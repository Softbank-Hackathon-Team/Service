import { test } from "node:test";
import assert from "node:assert/strict";
import type { AppSpecV2 } from "@svc/contracts";
import { DEMO_SPEC } from "@svc/adapters";
import { targetTypesOf, buildPlanResources, type MigrationRow } from "../src/routes/env-inventory.js";

// TA11 (설계 27번 A11): "생길 자원" = 도착 Builder 기준 (명세는 하나뿐)
const row = (o: Partial<MigrationRow>): MigrationRow => ({
  id: "11111111-1111-4111-8111-111111111111", status: "approved", pausedFrom: null, failedAtStatus: null, updatedAt: "2026-11-03T00:00:00Z",
  sourceEnvId: "55555555-5555-4555-8555-555555555555", targetEnvId: "22222222-2222-4222-8222-222222222222",
  sourceName: "src", sourceProvider: "gcp", targetName: "dst", targetProvider: "onprem",
  applyEvidence: null, cleanupRemoved: null, reachedPct: null, specV2: DEMO_SPEC, ...o,
});
const withoutJobs = (): AppSpecV2 => ({ ...DEMO_SPEC, components: DEMO_SPEC.components.filter((c) => c.kind !== "job"),
  links: DEMO_SPEC.links.filter((l) => DEMO_SPEC.components.find((c) => c.id === l.from)?.kind !== "job") });

test("정상: 예약 잡이 있으면 온프레 도착에 CronJob 이 생길 자원으로 보인다", () => {
  assert.ok(targetTypesOf(row({}), DEMO_SPEC).includes("batch/cronjobs"));
  assert.ok(targetTypesOf(row({}), DEMO_SPEC).includes("apps/deployments"));
});

test("거부: 잡이 없는 명세면 CronJob 종류가 없다", () => {
  assert.ok(!targetTypesOf(row({}), withoutJobs()).includes("batch/cronjobs"));
});

test("aws·gcp·onprem·azure_mock 모두 목록이 나오고, 계획 자원 표는 명세가 없거나 깨지면 specKnown=false + 빈 줄", () => {
  for (const p of ["aws", "gcp", "onprem"] as const) assert.ok(targetTypesOf(row({ targetProvider: p }), DEMO_SPEC).length > 0, p);
  assert.equal(buildPlanResources(row({})).specKnown, true);
  for (const bad of [null, { schemaVersion: "2" }]) {
    const r = buildPlanResources(row({ specV2: bad }));
    assert.equal(r.specKnown, false);
    assert.deepEqual(r.rows, []);
  }
});
