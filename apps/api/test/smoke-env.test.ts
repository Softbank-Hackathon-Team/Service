// tools/smoke.ts 의 도착 환경 고르기: SMOKE_TARGET_ENV_ID 를 읽는다 (맥 4차 발견)
import { test } from "node:test";
import assert from "node:assert/strict";
import { smokeEnvs, DEFAULT_SOURCE_ENV_ID, DEFAULT_TARGET_ENV_ID } from "../../../tools/smoke-env.js";

test("smoke: SMOKE_TARGET_ENV_ID 가 없으면 기본 gcp, 있으면 그 환경으로 간다", () => {
  assert.deepEqual(smokeEnvs({}), { sourceEnvId: DEFAULT_SOURCE_ENV_ID, targetEnvId: DEFAULT_TARGET_ENV_ID });
  assert.equal(smokeEnvs({ SMOKE_TARGET_ENV_ID: "44444444-4444-4444-8444-444444444444" }).targetEnvId, "44444444-4444-4444-8444-444444444444");
  assert.equal(smokeEnvs({ SMOKE_TARGET_ENV_ID: " 55555555-5555-4555-8555-555555555555 " }).targetEnvId, "55555555-5555-4555-8555-555555555555");
  assert.throws(() => smokeEnvs({ SMOKE_TARGET_ENV_ID: "onprem" }), /UUID/);
  assert.throws(() => smokeEnvs({ SMOKE_TARGET_ENV_ID: DEFAULT_SOURCE_ENV_ID }), /같다/);
});
