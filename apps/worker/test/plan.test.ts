import { test } from "node:test";
import assert from "node:assert/strict";
import { AppSpec, PlanDoc } from "@svc/contracts";
import { adapterFor, DbNetworkError } from "@svc/adapters";
import { buildPlanDoc, planOnError } from "../src/jobs/plan.js";
import { stubPrecheck } from "../src/jobs/precheck.js";

const spec = AppSpec.parse(adapterFor("aws").normalize({ provider: "aws", items: [], coverage: {} }).spec);
const base = {
  planId: "7f000000-0000-4000-8000-000000000001",
  migrationId: "4a8c0000-0000-4000-8000-000000000001",
  spec, target: { envId: "33333333-3333-4333-8333-333333333333", provider: "gcp" as const, region: "default" },
  precheck: stubPrecheck(),
};

test("계획서는 PlanDoc 계약을 통과하고, 같은 입력이면 같은 planHash", () => {
  const a = buildPlanDoc({ ...base, now: new Date("2026-11-07T00:00:00Z") });
  const b = buildPlanDoc({ ...base, now: new Date("2026-11-07T01:00:00Z") }); // 만든 시각만 다름
  assert.equal(PlanDoc.safeParse(a).success, true);
  assert.equal(a.planHash, b.planHash);
  assert.notEqual(a.expiresAt, b.expiresAt);
  assert.deepEqual(a.steps.map((s) => s.id), ["provision", "deploy", "sync", "shift", "cutover", "cleanup"]);
});

test("명세가 바뀌면 planHash도 바뀐다 (사람이 본 계획 ≠ 실행할 계획을 막는 근거)", () => {
  const now = new Date("2026-11-07T00:00:00Z");
  const a = buildPlanDoc({ ...base, now });
  const changed = { ...spec, service: { ...spec.service, replicas: spec.service.replicas + 1 } };
  const b = buildPlanDoc({ ...base, spec: changed, now });
  // 계획 지문은 명세 전체가 아니라 번역 결과(Terraform 변수·Helm 값)로 정해진다.
  // STUB 어댑터는 replicas를 번역에 안 넣으니 지문도 같아야 한다. 진짜 어댑터가 넣으면 둘 다 달라진다
  assert.equal(a.planHash === b.planHash, a.helmValuesHash === b.helmValuesHash && a.tfPlanHash === b.tfPlanHash);
  const img = { ...spec, service: { ...spec.service, image: "registry/demo@sha256:" + "1".repeat(64) } };
  assert.notEqual(buildPlanDoc({ ...base, spec: img, now }).planHash, a.planHash); // 이미지는 Helm 값에 들어간다
});

test("거부: 계약에 없는 단계·칸이 끼면 PlanDoc이 통과시키지 않는다", () => {
  const a = buildPlanDoc({ ...base, now: new Date() });
  assert.equal(PlanDoc.safeParse({ ...a, extra: 1 }).success, false);
  assert.equal(PlanDoc.safeParse({ ...a, steps: [{ id: "teleport", owner: "worker" }] }).success, false);
});

// Z38 REVIEW-5 Z77-1: 데모 B 를 위해 워커 .env 에 DB_PUBLIC=1 을 켜도 onprem·azure_mock 계획은 그대로
test("DB_PUBLIC=1 이 켜진 워커에서도 onprem·azure_mock 계획은 예전 지문 그대로, 잘못된 허용 목록은 바로 failed(DB_NETWORK_INVALID)", async () => {
  const now = new Date("2026-11-07T00:00:00Z");
  const on = { DB_PUBLIC: "1", DB_PEER_CIDRS: "203.0.113.7/32", DB_DISPOSABLE: "1" };
  for (const provider of ["onprem", "azure_mock"] as const) {
    const t = { ...base, target: { ...base.target, provider }, now };
    assert.equal(buildPlanDoc(t, on).tfPlanHash, buildPlanDoc(t, {}).tfPlanHash, provider);
  }
  assert.notEqual(buildPlanDoc({ ...base, now }, on).tfPlanHash, buildPlanDoc({ ...base, now }, {}).tfPlanHash);
  assert.throws(() => buildPlanDoc({ ...base, now }, { DB_PUBLIC: "1", DB_PEER_CIDRS: "0.0.0.0/0" }), DbNetworkError);
  assert.deepEqual(await planOnError(new DbNetworkError("x: 넓다")), { to: "failed", failureCode: "DB_NETWORK_INVALID", detail: { error: "x: 넓다" } });
  assert.equal(await planOnError(new Error("other")), null);
});

// Z38 REVIEW-5 04: 복제 precheck 의 연결 전 TLS 실패는 사유 코드 REPL_TLS_REQUIRED (나머지는 예전처럼 SYNC_FAILED)
test("sync precheck 사유 코드: NET-TLS* 면 REPL_TLS_REQUIRED, 아니면 SYNC_FAILED", async () => {
  const { precheckFailureCode } = await import("../src/jobs/sync.js");
  assert.equal(precheckFailureCode([{ id: "NET-TLS0" }]), "REPL_TLS_REQUIRED");
  assert.equal(precheckFailureCode([{ id: "DB-01" }, { id: "NET-TLS1" }]), "REPL_TLS_REQUIRED");
  assert.equal(precheckFailureCode([{ id: "DB-01" }]), "SYNC_FAILED");
});
