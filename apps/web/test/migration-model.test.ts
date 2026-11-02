import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canPick, canRollback, formatClock, judgementRows, leftoversOf, leftoverValue, migrationSteps, needsStepAnchor, pollMs, screenOf,
  shiftNote, specRows, stepAnchorFrom, stepGate, trafficPercent, trafficReportRows,
} from "../src/features/migration/model";
import { MIGRATION_STATUSES, type EnvApp, type EnvironmentView, type FootprintResource } from "../src/lib/types";

test("상태 22개가 모두 화면 하나로 묶인다", () => {
  assert.equal(MIGRATION_STATUSES.length, 22);
  for (const s of MIGRATION_STATUSES) assert.ok(screenOf(s));
  assert.equal(screenOf("spec_review"), "spec");
  assert.equal(screenOf("prechecking"), "preparing");
  assert.equal(screenOf("awaiting_approval"), "approve");
  assert.equal(screenOf("shifting"), "running");
  assert.equal(screenOf("rollback_window"), "window");
  assert.equal(screenOf("paused"), "paused");
});

test("폴링: 워커 칸은 빠르게, 사람 칸은 느리게, 끝나면 멈춘다", () => {
  assert.equal(pollMs("provisioning"), 700);
  assert.equal(pollMs("spec_review"), 1500);
  assert.equal(pollMs("failed"), 1500);
  assert.equal(pollMs("completed"), null);
});

test("명세 줄: 검토 필요와 빈 칸을 표시한다", () => {
  const rows = specRows({ spec: { app: { name: "shop" }, service: { replicas: 2 } }, needsReview: ["service.replicas", "database.storageGb"] });
  assert.equal(rows.find((r) => r.path === "service.replicas")?.review, true);
  assert.equal(rows.find((r) => r.path === "database")?.review, true);
  assert.equal(rows.find((r) => r.path === "app.name")?.review, false);
  assert.equal(rows.find((r) => r.path === "service.cpu")?.value, "비어 있음");
});

test("단계 조건은 비어 있으면 빈 글자다", () => {
  assert.equal(stepGate({ weights: [10, 50, 100], holdSec: 30 }), "10 → 50 → 100% · 단계마다 30초");
  assert.equal(stepGate({}), "");
});

test("연결된 환경만, 도착은 출발과 다른 환경만 고른다", () => {
  const env = (id: string, c: EnvironmentView["connectionStatus"]): EnvironmentView =>
    ({ id, provider: "aws", name: id, connectionStatus: c, accountId: null, lastVerifiedAt: null, failureReason: null });
  assert.equal(canPick(env("a", "connected")), true);
  assert.equal(canPick(env("a", "failed")), false);
  assert.equal(canPick(env("a", "connected"), "a"), false);
});

const marks = (items: { status: string }[]) => items.map((i) => i.status);

test("진행 단계: 지금 칸은 활성, 앞은 끝남, 뒤는 대기", () => {
  const items = migrationSteps({ status: "shifting" });
  assert.equal(items.length, 13);
  assert.deepEqual(marks(items).slice(8, 11), ["done", "active", "pending"]);
  assert.ok(marks(migrationSteps({ status: "completed" })).every((m) => m === "done"));
});

test("진행 단계: 멈춘 이전은 멈춘 칸을 표시한다", () => {
  assert.equal(migrationSteps({ status: "paused", pausedFrom: "syncing" })[8]!.status, "paused");
  assert.equal(migrationSteps({ status: "failed", failedAtStatus: "provisioning" })[6]!.status, "failed");
  assert.equal(migrationSteps({ status: "rejected" })[4]!.status, "failed");
  assert.equal(migrationSteps({ status: "stale" })[4]!.status, "paused");
  assert.equal(migrationSteps({ status: "rolled_back" }, "shifting")[9]!.status, "paused");
});

test("진행 단계: 위치를 모르면 어떤 칸도 끝남으로 표시하지 않는다", () => {
  assert.ok(marks(migrationSteps({ status: "cancelled" })).every((m) => m === "pending"));
  assert.equal(needsStepAnchor({ status: "cancelled" }), true);
  assert.equal(needsStepAnchor({ status: "failed", failedAtStatus: "syncing" }), false);
  assert.equal(needsStepAnchor({ status: "shifting" }), false);
});

test("타임라인에서 온 칸을 찾는다. 일시 정지와 롤백 중은 거슬러 올라간다", () => {
  const move = (from: string, to: string) => ({ kind: "transition" as const, from, to });
  assert.equal(stepAnchorFrom([move("approved", "cancelled")], "cancelled"), "approved");
  assert.equal(stepAnchorFrom([move("shifting", "paused"), move("paused", "rolling_back")], "rolling_back"), "shifting");
  assert.equal(stepAnchorFrom([move("shifting", "rolling_back"), move("rolling_back", "rolled_back")], "rolled_back"), "shifting");
  assert.equal(stepAnchorFrom([], "cancelled"), null);
});

test("트래픽 비율: 실측을 먼저 쓰고, 없으면 단계로 정한다", () => {
  const shift = { available: true, targetWeightPct: 50, observedWeightPct: 47 };
  assert.equal(trafficPercent("shifting", shift), 47);
  assert.equal(trafficPercent("shifting", { ...shift, observedWeightPct: null }), 50);
  assert.equal(trafficPercent("deploying", null), 0);
  assert.equal(trafficPercent("rollback_window", { available: false, targetWeightPct: null, observedWeightPct: null }), 100);
});

test("롤백: 상태 표에 있고 창이 안 끝났을 때만", () => {
  const now = Date.parse("2026-11-02T00:00:00Z");
  assert.equal(canRollback({ status: "shifting" }, now), true);
  assert.equal(canRollback({ status: "provisioning" }, now), false);
  assert.equal(canRollback({ status: "rollback_window", rollbackWindowEndsAt: "2026-11-02T00:01:00Z" }, now), true);
  assert.equal(canRollback({ status: "rollback_window", rollbackWindowEndsAt: "2026-11-01T23:59:00Z" }, now), false);
  assert.equal(canRollback({ status: "rollback_window" }, now), false);
});

test("남은 시간 표시", () => {
  assert.equal(formatClock(900), "15:00");
  assert.equal(formatClock(59.9), "00:59");
  assert.equal(formatClock(-3), "00:00");
});

test("트래픽 막대 밑 한 줄: 트래픽 이동 중에만, 덜 퍼졌으면 퍼지는 중이라고 쓴다", () => {
  const shift = { available: true, targetWeightPct: 50, observedWeightPct: 48, reached: true };
  assert.equal(shiftNote("shifting", shift), "목표 50% · 실측 48%");
  assert.equal(shiftNote("shifting", { ...shift, observedWeightPct: 14, reached: false }), "목표 50%로 퍼지는 중 · 지금 14%");
  assert.equal(shiftNote("shifting", { ...shift, observedWeightPct: null, reached: null }), "목표 50% · 실측 아직 없음");
  assert.equal(shiftNote("cutover", shift), null);
  assert.equal(shiftNote("shifting", { ...shift, available: false }), null);
  assert.equal(shiftNote("shifting", null), null);
});

const res = (label: string, state: FootprintResource["state"], evidence: FootprintResource["evidence"] = "terraform"): FootprintResource =>
  ({ category: "compute", type: label, label, state, evidence });
const app = (migrationId: string, role: EnvApp["role"], resources: FootprintResource[]): EnvApp => ({
  migrationId, role, peer: { envId: "e2", name: "src", provider: "aws" }, migrationStatus: "failed", stage: "undone",
  trafficPct: 0, spec: { app: "shop" }, resources,
});

test("남은 자원: 도착 쪽에서 아직 살아 있거나 모르는 것만, 이전이 없으면 모름(null)", () => {
  const apps = [
    app("m1", "target", [res("db", "left"), res("ns", "unknown", "adapter"), res("sub", "removed"), res("app", "none")]),
    app("m1", "source", [res("src-app", "running")]),
    app("m2", "target", [res("db", "removed")]),
  ];
  assert.deepEqual(leftoversOf(apps, "m1")?.map((r) => r.label), ["db", "ns"]);
  assert.deepEqual(leftoversOf(apps, "m2"), []);
  assert.equal(leftoversOf(apps, "m3"), null);
  assert.equal(leftoversOf(null, "m1"), null);
  assert.equal(leftoverValue(res("db", "left")), "남음");
  assert.equal(leftoverValue(res("app", "left", "stub")), "남음 · 흉내");
  assert.equal(leftoverValue(res("ns", "unknown", "adapter")), "생겼을 수 있음");
});

test("판정 근거 줄: 계획서 기준이 있으면 함께, 없으면 숫자만", () => {
  const judgement = { stepPct: 50, samples: 1840, targetErrorRatePct: 3.4219, sourceErrorRatePct: 0.11, targetP95Ms: 912.4, sourceP95Ms: 124, verdict: "bad" };
  const rows = judgementRows(judgement, { errorRatePct: 1, p95Multiplier: 2, windowSec: 30 });
  assert.equal(rows[0]!.value, "3.42% (출발 0.11% · 기준 1%)");
  assert.equal(rows[1]!.value, "912ms (출발 124ms · 기준 2배)");
  assert.equal(rows[2]!.value, "50%");
  assert.equal(rows[3]!.value, "1,840건");
  assert.equal(judgementRows(judgement)[0]!.value, "3.42% (출발 0.11%)");
});

test("전환 판정 요약 줄: 서버가 못 낸 값은 아직 없음", () => {
  const rows = trafficReportRows({ judgements: 9, steps: [10, 50, 100], bad: 0, maxTargetErrorRatePct: 0.2, maxTargetP95Ms: 131.6 });
  assert.deepEqual(rows.map((r) => r.value), ["10% → 50% → 100%", "9번 · 나쁨 0번", "0.2%", "132ms"]);
  const empty = trafficReportRows({ judgements: 0, steps: [], bad: 0, maxTargetErrorRatePct: null, maxTargetP95Ms: null });
  assert.deepEqual(empty.map((r) => r.value), ["아직 없음", "0번 · 나쁨 0번", "아직 없음", "아직 없음"]);
});
