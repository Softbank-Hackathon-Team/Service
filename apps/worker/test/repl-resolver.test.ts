// DECISION(team): 끝점은 이전마다 DB 행으로 (2026-11-05, 보안·온프레 영역)
// 복제 객체 고르기 (DB 없이): 명세에 postgres 없음 → null / 줄 두 개 → 줄 / 줄 없음 → 예전 env / 한 줄 → 오류
import { test } from "node:test";
import assert from "node:assert/strict";
import { ReplConfigError } from "@svc/replication";
import type { ReplicationEndpoint } from "@svc/contracts";
import { pickReplication } from "../src/jobs/_repl.js";

const T = "11111111-1111-4111-8111-111111111111", M = "33333333-3333-4333-8333-333333333333";
const ENV = { REPL_SOURCE_URL: "postgres://u:p@env-src.invalid:5432/shop", REPL_TARGET_URL: "postgres://u:p@env-dst.invalid:5432/shop",
  REPL_SECRET_MASTER_KEY: "test-master-key-0123456789abcdef-xyz" };   // 시험용 가짜 키
const row = (side: "source" | "target"): ReplicationEndpoint => ({
  tenantId: T, migrationId: M, side, label: `row-${side}`, provider: "postgres", host: `${side}.row.invalid`, port: 5432, dbname: "shop",
  username: "admin", passwordRef: "derive:admin", peerHost: null, peerPort: null, appRole: "app_user", fenceRoles: [], schemaName: null,
  sslmode: null, tlsServername: null, caPem: null, relayHost: null, relayKnownHosts: null, relayPort: 22,
});

test("정상: 줄 없음 → 예전 env 끝점 그대로, 두 줄 → 줄 끝점 (env 주소는 안 씀)", () => {
  const fromEnv = pickReplication(M, null, [], ENV)!;
  assert.equal(fromEnv.cfg.source.adminUrl, ENV.REPL_SOURCE_URL);
  assert.equal(fromEnv.cfg.target.origin, undefined);
  const fromRows = pickReplication(M, true, [row("source"), row("target")], ENV)!;
  assert.equal(new URL(fromRows.cfg.source.adminUrl).hostname, "source.row.invalid");
  assert.equal(new URL(fromRows.cfg.target.adminUrl).hostname, "target.row.invalid");
  assert.equal(fromRows.cfg.target.origin, "db");
  // env 도 줄도 없으면 예전처럼 null (STUB 길)
  assert.equal(pickReplication(M, null, [], {}), null);
});

test("거부: 명세에 postgres 없으면 줄이 있어도 null, 한 줄만 있으면 env 로 메우지 않고 REPL_ENDPOINT_INCOMPLETE", () => {
  assert.equal(pickReplication(M, false, [row("source"), row("target")], ENV), null);
  assert.throws(() => pickReplication(M, true, [row("target")], ENV),
    (e: unknown) => e instanceof ReplConfigError && e.code === "REPL_ENDPOINT_INCOMPLETE");
});

test("끝점이 하나도 없음: 진짜 판 + 명세 postgres 면 REPL_ENDPOINT_MISSING, 흉내 판·postgres 없음·명세 못 읽음은 null (STUB 길)", () => {
  assert.throws(() => pickReplication(M, true, [], {}),
    (e: unknown) => e instanceof ReplConfigError && e.code === "REPL_ENDPOINT_MISSING" && /REPL_ENDPOINT_MISSING/.test((e as Error).message));
  assert.equal(pickReplication(M, true, [], { MOCK_IAC: "1" }), null);
  assert.equal(pickReplication(M, false, [], {}), null);
  assert.equal(pickReplication(M, null, [], {}), null);
  assert.ok(pickReplication(M, true, [], ENV), "env 끝점이 있으면 그대로 쓴다");
});
