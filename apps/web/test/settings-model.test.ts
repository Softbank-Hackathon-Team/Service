import { test } from "node:test";
import assert from "node:assert/strict";
import { borrowedByEnv, envsByProvider, minutesLeft } from "../src/features/settings/model";
import type { LedgerRow } from "../src/lib/security-types";
import type { EnvironmentView } from "../src/lib/types";

const env = (id: string, provider: EnvironmentView["provider"], name = id): EnvironmentView =>
  ({ id, provider, name, connectionStatus: "connected", accountId: null, lastVerifiedAt: null, failureReason: null });
const row = (provider: string, over: Partial<LedgerRow> = {}): LedgerRow => ({
  credentialRef: `${provider}-${Math.random()}`, provider, purpose: "operate", stage: null, status: "active", step: "deploy",
  issuedAt: "2026-11-04T10:00:00Z", expiresAt: "2026-11-04T10:15:00Z", revokedAt: null, ttlSec: 900, expiredButActive: false, ...over,
});

test("계정 화면: 환경을 벤더별로, 이름 순", () => {
  const groups = envsByProvider([env("b", "aws", "zeta"), env("a", "aws", "alpha"), env("g", "gcp")]);
  assert.deepEqual(groups.aws.map((e) => e.name), ["alpha", "zeta"]);
  assert.deepEqual(groups.onprem, []);
});

test("빌린 권한: 진행 중 마이그레이션 장부에서 벤더로 환경을 가리고, 끝난·만료된 줄은 뺀다", () => {
  const now = Date.parse("2026-11-04T10:05:00Z");
  const envs = [env("src", "gcp"), env("tgt", "aws")];
  const migration = { id: "m1", sourceEnvId: "src", targetEnvId: "tgt" };
  const out = borrowedByEnv(envs, [{ migration, rows: [
    row("aws"),
    row("aws", { expiresAt: "2026-11-04T10:20:00Z", purpose: "observe" }),
    row("gcp", { status: "revoked" }),
    row("gcp", { expiredButActive: true }),
    row("azure_mock"),
  ] }], now);
  assert.deepEqual(Object.keys(out), ["tgt"]);
  assert.equal(out.tgt!.expiresAt, "2026-11-04T10:20:00Z", "가장 늦게 끝나는 것");
  assert.equal(out.tgt!.purpose, "observe");
  assert.equal(minutesLeft("2026-11-04T10:20:00Z", now), 15);
  assert.equal(minutesLeft("2026-11-04T10:05:10Z", now), 1);
});
