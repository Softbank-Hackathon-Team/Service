// Z77: 도착 표 없음 사유 코드 + REPL_COPY_SCHEMA 켜기 (DB 없이)
import assert from "node:assert/strict";
import { test } from "node:test";
import { isTransient, replicationFromEnv } from "@svc/replication";
import { precheckFailureCode } from "../src/jobs/sync.js";

test("sync precheck 사유 코드: DB-T4 는 REPL_TARGET_SCHEMA_MISSING, TLS 가 먼저", () => {
  assert.equal(precheckFailureCode([{ id: "DB-T4" }]), "REPL_TARGET_SCHEMA_MISSING");
  assert.equal(precheckFailureCode([{ id: "DB-05" }, { id: "DB-T4" }]), "REPL_TARGET_SCHEMA_MISSING");
  assert.equal(precheckFailureCode([{ id: "NET-TLS1" }, { id: "DB-T4" }]), "REPL_TLS_REQUIRED");
  assert.equal(precheckFailureCode([{ id: "DB-01" }]), "SYNC_FAILED");
});

test("REPL_COPY_SCHEMA=1 일 때만 스키마 복사를 켠다 (기본 꺼짐 → 예전 그대로)", async () => {
  const base = { REPL_SOURCE_URL: "postgres://a@h1/db", REPL_TARGET_URL: "postgres://a@h2/db" };
  for (const [v, want] of [[undefined, false], ["0", false], ["1", true], ["true", true]] as const) {
    const m = replicationFromEnv("m1", { ...base, ...(v === undefined ? {} : { REPL_COPY_SCHEMA: v }) })!;
    assert.equal(!!m.cfg.copySchema, want, `REPL_COPY_SCHEMA=${v}`);
    if (!want) assert.equal(await m.prepareTarget(), null);
  }
});

test("Z38 R8-34: 연결 끊김만 일시 오류 (DDL 오류는 아님)", () => {
  for (const code of ["08006", "08001", "57P01", undefined]) assert.equal(isTransient(Object.assign(new Error("x"), code ? { code } : {})), true, String(code));
  for (const code of ["42P07", "42501", "42704"]) assert.equal(isTransient(Object.assign(new Error("x"), { code })), false, code);
});

test("Z77 주제 60: 도착 복제 권한·설정 실패는 DEST_REPL_PRIVILEGE (TLS 가 먼저, 출발 쪽은 예전처럼)", () => {
  assert.equal(precheckFailureCode([{ id: "DB-04", side: "target" }]), "DEST_REPL_PRIVILEGE");
  assert.equal(precheckFailureCode([{ id: "DB-02", side: "target" }, { id: "DB-T4", side: "target" }]), "DEST_REPL_PRIVILEGE");
  assert.equal(precheckFailureCode([{ id: "DB-01", side: "target" }]), "DEST_REPL_PRIVILEGE");
  assert.equal(precheckFailureCode([{ id: "DB-04", side: "source" }]), "SYNC_FAILED");
  assert.equal(precheckFailureCode([{ id: "NET-TLS0", side: "target" }, { id: "DB-04", side: "target" }]), "REPL_TLS_REQUIRED");
});
