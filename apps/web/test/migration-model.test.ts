import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ackState, approveLabel, canPick, canReplan, canRollback, failureChoices, formatClock, judgementRows, leftoversOf, leftoverValue, migrationSteps, needsStepAnchor, stepsPhase,
  pollMs, screenOf, shiftNote, signalCovers, specRows, stepAnchorFrom, stepGate, trafficPercent, trafficReportRows,
} from "../src/features/migration/model";
import { planResourceRows, runtimeChangeNote, type ResourceRow } from "../src/lib/resourceMap";
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

const labels = (items: { label: string }[]) => items.map((i) => i.label);
const PREPARE = ["구성 읽기", "명세 확정", "사전 점검", "계획 만들기", "계획 승인"];
const RUN = ["자원 생성", "앱 배포", "DB 복제", "트래픽 이동", "DB 컷오버", "롤백 대기", "정리"];

test("진행 단계: 실행 전에는 구성 읽기~계획 승인, 승인한 뒤에는 자원 생성~정리만 보인다", () => {
  assert.deepEqual(labels(migrationSteps({ status: "spec_review" })), PREPARE);
  assert.deepEqual(labels(migrationSteps({ status: "awaiting_approval" })), PREPARE);
  assert.deepEqual(labels(migrationSteps({ status: "approved" })), RUN);
  assert.deepEqual(labels(migrationSteps({ status: "provisioning" })), RUN);
  assert.deepEqual(labels(migrationSteps({ status: "completed" })), RUN);
  assert.ok(!labels(migrationSteps({ status: "approved" })).includes("실행 시작"), "실행 시작 칸은 없다 (승인하면 바로 시작)");
  // 멈추거나 끝난 것은 멈춘 칸이 어느 묶음인지로
  assert.equal(stepsPhase({ status: "failed", failedAtStatus: "planning" }), "prepare");
  assert.equal(stepsPhase({ status: "failed", failedAtStatus: "provisioning" }), "run");
  assert.equal(stepsPhase({ status: "paused", pausedFrom: "deploying" }), "run");
  assert.equal(stepsPhase({ status: "rejected" }), "prepare");
  assert.equal(stepsPhase({ status: "cancelled" }, "approved"), "run");
  assert.equal(stepsPhase({ status: "cancelled" }), "prepare");
});

test("진행 단계: 지금 칸은 활성, 앞은 끝남, 뒤는 대기", () => {
  const items = migrationSteps({ status: "shifting" });
  assert.equal(items.length, 7);
  assert.deepEqual(marks(items).slice(2, 5), ["done", "active", "pending"]);
  assert.ok(marks(migrationSteps({ status: "completed" })).every((m) => m === "done"));
});

test("진행 단계: 사람이 눌러야 하는 칸은 도는 표시 대신 입력을 기다린다", () => {
  assert.deepEqual(marks(migrationSteps({ status: "spec_review" })).slice(0, 3), ["done", "waiting", "pending"]);
  assert.equal(migrationSteps({ status: "awaiting_approval" })[4]!.status, "waiting");
  // 승인했는데 시작이 막혀 approved 에 남으면 자원 생성 칸이 다시 시작을 기다린다
  assert.equal(migrationSteps({ status: "approved" })[0]!.status, "waiting");
  assert.equal(migrationSteps({ status: "provisioning" })[0]!.status, "active");
  assert.equal(migrationSteps({ status: "prechecking" })[2]!.status, "active");
  // 멈춘 표시가 사람 칸보다 먼저다
  assert.equal(migrationSteps({ status: "stale" })[4]!.status, "paused");
  assert.equal(migrationSteps({ status: "rejected" })[4]!.status, "failed");
  assert.ok(marks(migrationSteps({ status: "shifting" })).every((m) => m !== "waiting"));
});

test("진행 단계: 멈춘 마이그레이션은 멈춘 칸을 표시한다", () => {
  assert.equal(migrationSteps({ status: "paused", pausedFrom: "syncing" })[2]!.status, "paused");
  assert.equal(migrationSteps({ status: "failed", failedAtStatus: "provisioning" })[0]!.status, "failed");
  assert.equal(migrationSteps({ status: "failed", failedAtStatus: "planning" })[3]!.status, "failed");
  assert.equal(migrationSteps({ status: "rejected" })[4]!.status, "failed");
  assert.equal(migrationSteps({ status: "stale" })[4]!.status, "paused");
  assert.equal(migrationSteps({ status: "rolled_back" }, "shifting")[3]!.status, "paused");
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

test("신호가 화면을 다 맞춰 주는 상태: 사람 차례·멈춤은 맞고, 워커 단계는 아니다", () => {
  for (const status of ["provisioning", "deploying", "syncing", "shifting", "cutover", "rollback_window", "cleanup", "rolling_back"] as const)
    assert.equal(signalCovers(status), false, status);
  for (const status of ["spec_review", "awaiting_approval", "approved", "paused", "failed", "rejected", "stale", "completed"] as const)
    assert.equal(signalCovers(status), true, status);
});

test("계획 다시 만들기: stale·rejected 만. failed 는 서버가 다시 계획을 막는다(409) → 실패 질문으로", () => {
  assert.equal(canReplan({ status: "stale", failedAtStatus: null }), true);
  assert.equal(canReplan({ status: "rejected", failedAtStatus: null }), true);
  assert.equal(canReplan({ status: "failed", failedAtStatus: "planning" }), false);
  assert.equal(canReplan({ status: "failed", failedAtStatus: "provisioning" }), false);
  assert.equal(canReplan({ status: "failed", failedAtStatus: "importing" }), false);
  assert.equal(canReplan({ status: "paused", failedAtStatus: null }), false);
});

test("실패 질문: 가져오기·점검·계획·자원 만들기는 그 단계부터 다시, 만든 것이 없는 실패는 정리 확인 없이 끝낸다", () => {
  const at = (failedAtStatus: Parameters<typeof failureChoices>[0]["failedAtStatus"]) => failureChoices({ status: "failed", failedAtStatus });
  // 가져오기 실패: 서버 failure-decision 이 재시도(→ importing)를 받는다. 거절은 cancelled (만든 자원 없음)
  assert.deepEqual(at("importing"), { retry: "importing", nothingMade: true });
  assert.deepEqual(at("prechecking"), { retry: "prechecking", nothingMade: true });
  assert.deepEqual(at("planning"), { retry: "planning", nothingMade: true });
  // 자원 만들기 실패: 재시도는 승인한 계획 그대로 다시 만들기. 만든 자원이 있을 수 있어 끝내기는 정리 확인 뒤
  assert.deepEqual(at("provisioning"), { retry: "provisioning", nothingMade: false });
  // 데이터·트래픽이 움직인 뒤 실패는 화면이 다시 시도를 두지 않는다
  assert.deepEqual(at("cutover"), { retry: null, nothingMade: false });
  assert.deepEqual(at("rolling_back"), { retry: null, nothingMade: false });
  assert.deepEqual(at(null), { retry: null, nothingMade: false });
  assert.deepEqual(failureChoices({ status: "paused", failedAtStatus: "importing" }), { retry: null, nothingMade: false });
});

test("승인 확인 항목: 다 체크해야 승인, 버튼은 남은 수를 말한다, 옛 계획서는 항목 없이 바로 승인", () => {
  const acks = [{ id: "cost" }, { id: "failure_cost_policy" }, { id: "runtime_change:web" }];
  const none = ackState(acks, new Set());
  assert.deepEqual(none.missing, ["cost", "failure_cost_policy", "runtime_change:web"]);
  assert.equal(none.ready, false);
  assert.equal(approveLabel({ busy: false, expired: false, missing: none.missing.length }), "확인 3개 남음");
  const some = ackState(acks, new Set(["cost", "stray"]));
  assert.deepEqual(some.ids, ["cost"]);                 // 계획서에 없는 id 는 보내지 않는다
  assert.equal(some.missing.length, 2);
  const all = ackState(acks, new Set(acks.map((a) => a.id)));
  assert.equal(all.ready, true);
  assert.deepEqual(all.ids, ["cost", "failure_cost_policy", "runtime_change:web"]);
  assert.equal(approveLabel({ busy: false, expired: false, missing: 0 }), "승인하고 실행 시작");
  assert.equal(approveLabel({ busy: true, expired: false, missing: 2 }), "보내는 중");
  assert.equal(approveLabel({ busy: false, expired: true, missing: 2 }), "승인 시간이 지났습니다");
  const old = ackState(undefined, new Set());
  assert.equal(old.ready, true);
  assert.deepEqual(old.ids, []);
});

const resRow = (over: Partial<ResourceRow>): ResourceRow => ({
  category: "workload", label: "앱", source: { service: "a", detail: null }, target: { service: "b", detail: null },
  method: "redeploy", methodLabel: "", step: "deploy", stepState: "todo", afterSource: null, ...over,
});

test("자원 대응 v2: 같은 칸 여러 줄도 열쇠가 겹치지 않고, 건수는 그린 줄 수, 경계 밖은 따로 한 줄", () => {
  const view = {
    rows: [
      resRow({ category: "workload", label: "앱(컨테이너) · web", runtimeChange: { from: "managedContainer", to: "k8s" } }),
      resRow({ category: "workload", label: "앱(예약 잡) · nightly", runtimeChange: null }),
      resRow({ category: "cache", label: "캐시 · shop-cache", method: "create_new" }),
      resRow({ category: "storage", label: "객체 저장소", method: "out_of_scope", source: null, target: null }),
      resRow({ category: "boundary", label: "경계 밖 자원 2개", method: "out_of_scope", target: null, afterSource: "출발에 그대로 (건드리지 않음)" }),
    ],
  };
  const got = planResourceRows(view);
  assert.equal(got.listed.length, 3);
  assert.equal(new Set(got.listed.map((item) => item.key)).size, 3);
  assert.equal(got.boundary?.label, "경계 밖 자원 2개");
  assert.equal(got.runtimeChanges, 1);
  assert.equal(runtimeChangeNote(view.rows[0]!), "실행 방식 바뀜: 관리형 컨테이너 → 쿠버네티스");
  assert.equal(runtimeChangeNote(view.rows[1]!), null);
  assert.equal(runtimeChangeNote(resRow({})), null);       // v1 줄엔 칸 자체가 없다
  const v1 = planResourceRows({ rows: [resRow({}), resRow({ category: "storage", method: "out_of_scope" })] });
  assert.equal(v1.listed.length, 1);
  assert.equal(v1.boundary, null);
  assert.equal(planResourceRows(null).listed.length, 0);
});
