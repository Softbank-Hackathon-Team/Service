import { test } from "node:test";
import assert from "node:assert/strict";
import { upconvertV1, type AppSpec } from "@svc/contracts";
import { DEMO_SPEC } from "@svc/adapters";
import { targetResources, targetTypesOf, type MigrationRow } from "../src/routes/env-inventory.js";

// TA11 (설계 27번 A11): "생길 자원" 이 v2 계획서면 v2 Builder 기준, 아니면 v1 그대로
const SPEC: AppSpec = { ...DEMO_SPEC, database: { engine: "postgres", majorVersion: "16", storageGb: 20 } };
const row = (o: Partial<MigrationRow>): MigrationRow => ({
  id: "11111111-1111-4111-8111-111111111111", status: "approved", pausedFrom: null, failedAtStatus: null, updatedAt: "2026-11-03T00:00:00Z",
  sourceEnvId: "55555555-5555-4555-8555-555555555555", targetEnvId: "22222222-2222-4222-8222-222222222222",
  sourceName: "src", sourceProvider: "gcp", targetName: "dst", targetProvider: "onprem",
  spec: SPEC, applyEvidence: null, cleanupRemoved: null, reachedPct: null, ...o,
});
// v2 3티어 조각: 서비스 + 예약 잡 → 온프레 v2 는 CronJob 권한이 생김 (v1 표엔 없음)
const v2WithJob = () => {
  const s = upconvertV1(SPEC).spec;
  s.components.push({ id: "nightly", kind: "job", props: { image: { source: "registry", repository: "r/x", digest: "sha256:" + "1".repeat(64) },
    resources: {}, env: [], serviceAccount: "default", schedule: "0 3 * * *" } });
  return s;
};

test("정상: 계획서 irVersion 2 + spec_v2 있음 → v2 Builder 종류 (CronJob 이 생길 자원에 보임)", () => {
  const m = row({ planIrVersion: "2", specV2: v2WithJob() });
  assert.ok(targetTypesOf(m, SPEC).includes("batch/cronjobs"));
  const r = targetResources(m, SPEC).find((x) => x.type === "batch/cronjobs");
  assert.equal(r?.label, "k8s CronJob");
  assert.equal(r?.state, "planned");
});

test("거부(깃발 off 그대로): irVersion 없거나 v1, 또는 spec_v2 가 없거나 깨졌으면 v1 종류 그대로", () => {
  const v1 = targetTypesOf(row({}), SPEC);
  for (const o of [{}, { planIrVersion: null }, { planIrVersion: "1", specV2: v2WithJob() }, { planIrVersion: "2", specV2: null }, { planIrVersion: "2", specV2: { schemaVersion: "2" } }] as Partial<MigrationRow>[])
    assert.deepEqual(targetTypesOf(row(o), SPEC), v1, JSON.stringify(o).slice(0, 60));
  assert.ok(!v1.includes("batch/cronjobs"));
});

test("upconvert 판은 v1 과 같은 종류 (aws·gcp·onprem), azure_mock v2 도 목록이 나옴 (TA10 연결)", () => {
  for (const p of ["aws", "gcp", "onprem"] as const)
    assert.deepEqual(targetTypesOf(row({ targetProvider: p, planIrVersion: "2", specV2: upconvertV1(SPEC).spec }), SPEC), targetTypesOf(row({ targetProvider: p }), SPEC), p);
  assert.ok(targetTypesOf(row({ targetProvider: "azure_mock", planIrVersion: "2", specV2: upconvertV1(SPEC).spec }), SPEC).length > 0);
});
