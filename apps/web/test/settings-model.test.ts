import { test } from "node:test";
import assert from "node:assert/strict";
import { borrowedByEnv, borrowState, envsByProvider } from "../src/features/settings/model";
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

test("빌린 권한: 진행 중 마이그레이션 장부에서 벤더로 환경을 가리고, 살아 있는 줄 중 가장 늦게 끝나는 것", () => {
  const now = Date.parse("2026-11-04T10:05:00Z");
  const envs = [env("src", "gcp"), env("tgt", "aws")];
  const migration = { id: "m1", sourceEnvId: "src", targetEnvId: "tgt" };
  const out = borrowedByEnv(envs, [{ migration, rows: [
    row("aws"),
    row("aws", { expiresAt: "2026-11-04T10:20:00Z", purpose: "observe" }),
    row("gcp", { status: "revoked", issuedAt: "2026-11-04T10:01:00Z" }),
    row("gcp", { expiredButActive: true }),
    row("azure_mock"),
  ] }], now);
  assert.deepEqual(Object.keys(out).sort(), ["tgt"], "gcp 는 가장 최근 줄을 돌려줬으니 빌린 권한 없음");
  assert.equal(out.tgt!.expiresAt, "2026-11-04T10:20:00Z");
  assert.equal(out.tgt!.purpose, "observe");
  assert.equal(out.tgt!.expired, false);
});

test("빌린 권한: 살아 있는 줄이 없고 가장 최근 줄이 만료면 만료로 남긴다 (화면은 갱신 버튼)", () => {
  const now = Date.parse("2026-11-04T10:30:00Z");
  const envs = [env("src", "gcp"), env("tgt", "aws")];
  const migration = { id: "m1", sourceEnvId: "src", targetEnvId: "tgt" };
  const out = borrowedByEnv(envs, [{ migration, rows: [
    row("aws", { status: "revoked", issuedAt: "2026-11-04T09:00:00Z" }),
    row("aws"),                                    // 10:15 에 끝남, 아직 active 로 남은 줄
    row("gcp", { status: "expired" }),
  ] }], now);
  assert.equal(out.tgt!.expired, true);
  assert.equal(out.src!.expired, true);
});

test("빌린 권한 칸: 남은 분(내림) → 1분 이하 곧 만료 → 만료", () => {
  const b = { expiresAt: "2026-11-04T10:20:00Z", expired: false };
  const at = (iso: string) => borrowState(b, Date.parse(iso));
  assert.deepEqual(at("2026-11-04T10:05:00Z"), { kind: "left", minutes: 15 });
  assert.deepEqual(at("2026-11-04T10:18:01Z"), { kind: "left", minutes: 1 }, "1분 59초는 1분");
  assert.deepEqual(at("2026-11-04T10:19:00Z"), { kind: "soon" }, "딱 1분이면 곧 만료");
  assert.deepEqual(at("2026-11-04T10:19:59Z"), { kind: "soon" });
  assert.deepEqual(at("2026-11-04T10:20:00Z"), { kind: "expired" });
  assert.deepEqual(borrowState({ ...b, expired: true }, Date.parse("2026-11-04T10:05:00Z")), { kind: "expired" });
});
