import { test } from "node:test";
import assert from "node:assert/strict";
import { VALID, MIGRATION_STATUSES } from "@svc/contracts";
import { checkGuard, GUARDED_TRANSITIONS, observeMinSec, type GuardFacts } from "../src/guards.js";

// 전이 조건은 순수 함수라 DB 없이 본다
const base: GuardFacts = {
  status: "draft", pausedFrom: null, failedAtStatus: null, rollbackWindowOver: false,
  sourceEnvId: "s", targetEnvId: "t", sourceConn: "connected", targetConn: "connected",
  specVersion: 1, specNeedsReview: 0,
  plan: { id: "p", hash: "h1", status: "proposed", expired: false, expiresAt: new Date() },
  locks: { total: 0, live: 0, reservedLive: 0 },
};
const f = (o: Partial<GuardFacts>): GuardFacts => ({ ...base, ...o });

test("T01: 두 환경이 연결됨일 때만 가져오기 시작", () => {
  assert.equal(checkGuard("draft", "importing", { facts: base, ev: {} }), null);
  assert.match(checkGuard("draft", "importing", { facts: f({ targetConn: "unstable" }), ev: {} })!, /not connected/);
});

test("T04: needs_review 칸이 남으면 점검으로 못 간다", () => {
  assert.equal(checkGuard("spec_review", "prechecking", { facts: base, ev: {} }), null);
  assert.match(checkGuard("spec_review", "prechecking", { facts: f({ specNeedsReview: 2 }), ev: {} })!, /2 field/);
});

test("T05/T06: 점검 blocker 수로 갈 길이 갈린다", () => {
  assert.equal(checkGuard("prechecking", "planning", { facts: base, ev: { precheckBlockers: 0 } }), null);
  assert.ok(checkGuard("prechecking", "planning", { facts: base, ev: { precheckBlockers: 1 } }));
  assert.ok(checkGuard("prechecking", "planning", { facts: base, ev: {} }), "증거 없으면 막는다");
  assert.equal(checkGuard("prechecking", "spec_review", { facts: base, ev: { precheckBlockers: 1 } }), null);
});

test("T09: 승인은 지문 일치 + 만료 전", () => {
  assert.equal(checkGuard("awaiting_approval", "approved", { facts: base, ev: { planHash: "h1" } }), null);
  assert.match(checkGuard("awaiting_approval", "approved", { facts: base, ev: { planHash: "h2" } })!, /mismatch/);
  const expired = f({ plan: { ...base.plan!, expired: true } });
  assert.match(checkGuard("awaiting_approval", "approved", { facts: expired, ev: { planHash: "h1" } })!, /expired/);
});

test("T15: 잠금 둘을 쥐어야 자원 생성 시작", () => {
  assert.ok(checkGuard("approved", "provisioning", { facts: base, ev: {} }));
  assert.equal(checkGuard("approved", "provisioning",
    { facts: f({ locks: { total: 2, live: 2, reservedLive: 2 } }), ev: {} }), null);
});

test("T22: 100% + 30초 관찰 + 도착 로그", () => {
  const ok = { weightPct: 100, observedSec: 30, targetLogsSeen: true };
  assert.equal(checkGuard("shifting", "cutover", { facts: base, ev: ok }), null);
  assert.match(checkGuard("shifting", "cutover", { facts: base, ev: { ...ok, observedSec: 29 } })!, /30s/);
});

test("T30/T31: 일시정지는 이유가 필요하고, 재개는 멈추기 전 상태로만", () => {
  assert.ok(checkGuard("syncing", "paused", { facts: base, ev: {} }));
  assert.equal(checkGuard("syncing", "paused", { facts: base, ev: { guardrailRule: "MG-2-07" } }), null);
  assert.equal(checkGuard("syncing", "paused", { facts: base, ev: {}, failureCode: "WORKER_LOST" }), null);
  const p = f({ status: "paused", pausedFrom: "syncing" });
  assert.equal(checkGuard("paused", "syncing", { facts: p, ev: { ruleCleared: true } }), null);
  assert.match(checkGuard("paused", "shifting", { facts: p, ev: { ruleCleared: true } })!, /paused_from/);
  assert.match(checkGuard("paused", "syncing", { facts: p, ev: {} })!, /not cleared/);
  assert.equal(checkGuard("paused", "rolling_back", { facts: p, ev: {} }), null, "롤백은 언제나");
});

test("T37: provisioning 이하에서 실패했을 때만 다시 계획", () => {
  assert.equal(checkGuard("failed", "planning", { facts: f({ failedAtStatus: "provisioning" }), ev: {} }), null);
  assert.match(checkGuard("failed", "planning", { facts: f({ failedAtStatus: "cutover" }), ev: {} })!, /replan/);
});

test("모든 조건 키는 VALID에 있는 이동이다 (오타 방지)", () => {
  assert.ok(GUARDED_TRANSITIONS.length >= 20);
  for (const k of GUARDED_TRANSITIONS) {
    const [a, b] = k.split(">") as [string, string];
    assert.ok((MIGRATION_STATUSES as readonly string[]).includes(a), a);
    assert.ok((VALID as Record<string, readonly string[]>)[a]!.includes(b), `${k} not in VALID`);
  }
});

test("T21: 스냅샷 끝 + 마커 왕복 500ms 이하면 쓰기 부하 중(지연 바이트 남음)에도 트래픽 이동", () => {
  const ok = { snapshotDone: true, markerRoundTripMs: 120, replicationLagBytes: 22000, rowCountMatch: false };
  assert.equal(checkGuard("syncing", "shifting", { facts: base, ev: ok }), null);
  assert.match(checkGuard("syncing", "shifting", { facts: base, ev: { ...ok, markerRoundTripMs: 900 } })!, /marker/);
  assert.match(checkGuard("syncing", "shifting", { facts: base, ev: { ...ok, snapshotDone: false } })!, /snapshot/);
  assert.ok(checkGuard("syncing", "shifting", { facts: base, ev: { snapshotDone: true } }), "마커 측정 없으면 막는다");
});

test("컷오버 따라잡기 횟수를 다 쓰면 failed로 갈 수 있다", () => {
  assert.equal(checkGuard("cutover", "failed", { facts: base, ev: {}, failureCode: "CUTOVER_CATCHUP_EXHAUSTED" }), null);
});

test("Z38-1 (P-4): cleanup 에서 멈춘 이전은 롤백 못 한다. 다른 단계에서 멈춘 것은 롤백된다", () => {
  const why = checkGuard("paused", "rolling_back", { facts: f({ status: "paused", pausedFrom: "cleanup" }), ev: {} });
  assert.match(why!, /rollback window is over/);
  for (const p of ["deploying", "syncing", "shifting"] as const)
    assert.equal(checkGuard("paused", "rolling_back", { facts: f({ status: "paused", pausedFrom: p }), ev: {} }), null, p);
  // 재개(paused → cleanup)는 그대로 된다
  assert.equal(checkGuard("paused", "cleanup", { facts: f({ status: "paused", pausedFrom: "cleanup" }), ev: { ruleCleared: true } }), null);
});

test("Z38 R3-9: TRAFFIC_OBSERVE_SEC 검사 — 빈 값·글자·0 이하는 30, 진짜 지표(PROM_URL)면 최소 30", () => {
  assert.equal(observeMinSec({}), 30);
  assert.equal(observeMinSec({ TRAFFIC_OBSERVE_SEC: "0.5" }), 0.5);          // 가짜 지표 데모·smoke
  assert.equal(observeMinSec({ TRAFFIC_OBSERVE_SEC: "" }), 30);             // 예전: 0 → 30초 조건 꺼짐
  assert.equal(observeMinSec({ TRAFFIC_OBSERVE_SEC: "abc" }), 30);          // 예전: NaN → T22 영원히 막힘
  assert.equal(observeMinSec({ TRAFFIC_OBSERVE_SEC: "-1" }), 30);
  assert.equal(observeMinSec({ TRAFFIC_OBSERVE_SEC: "0.5", PROM_URL: "http://localhost:9090" }), 30);
  assert.equal(observeMinSec({ TRAFFIC_OBSERVE_SEC: "60", PROM_URL: "http://localhost:9090" }), 60);
});
