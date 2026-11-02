import { test } from "node:test";
import assert from "node:assert/strict";
import { canPick, canRollback, formatClock, migrationSteps, needsStepAnchor, pollMs, screenOf, specRows, stepAnchorFrom, stepGate, trafficPercent } from "../src/features/migration/model";
import { MIGRATION_STATUSES, type EnvironmentView } from "../src/lib/types";

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
