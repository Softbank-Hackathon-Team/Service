// Z53: 전이 조건(guard) 빈 곳 채우기. guards.test.ts 가 안 보던 이동을 "통과 1개 + 막힘 1개"씩 표로 본다
// 대상: T02 T07 T11 T16 T17 T20 T23 T24 T25 T26 T27 T35 T38, paused→rolling_back, 같은 환경(잠금 1개) 규칙
// 그리고 VALID 표 자체의 모양(끝 상태엔 나가는 길 없음, 모든 상태는 draft 에서 닿고, 끝 상태로 빠져나갈 길이 있음)
import { test } from "node:test";
import assert from "node:assert/strict";
import { VALID, TERMINAL, MIGRATION_STATUSES, type MigrationStatus, type TransitionEvidence } from "@svc/contracts";
import { checkGuard, type GuardFacts } from "../src/guards.js";

const base: GuardFacts = {
  status: "draft", pausedFrom: null, failedAtStatus: null, rollbackWindowOver: false,
  sourceEnvId: "s", targetEnvId: "t", sourceConn: "connected", targetConn: "connected",
  specVersion: 1, specNeedsReview: 0,
  plan: { id: "p", hash: "h1", status: "proposed", expired: false, expiresAt: new Date() },
  locks: { total: 0, live: 0, reservedLive: 0 },
};
const f = (o: Partial<GuardFacts> = {}): GuardFacts => ({ ...base, ...o });

interface Case {
  name: string; from: MigrationStatus; to: MigrationStatus;
  facts?: Partial<GuardFacts>; ev?: TransitionEvidence;
  blocked?: RegExp;                // 없으면 통과(null)해야 한다
}

const CASES: Case[] = [
  // T02
  { name: "T02 명세 저장됨 → 통과", from: "importing", to: "spec_review" },
  { name: "T02 명세 없음 → 막힘", from: "importing", to: "spec_review", facts: { specVersion: null }, blocked: /no spec saved/ },
  // T07
  { name: "T07 계획 proposed → 통과", from: "planning", to: "awaiting_approval" },
  { name: "T07 계획 없음", from: "planning", to: "awaiting_approval", facts: { plan: null }, blocked: /no plan/ },
  { name: "T07 계획 만료", from: "planning", to: "awaiting_approval",
    facts: { plan: { ...base.plan!, expired: true } }, blocked: /plan expired/ },
  { name: "T07 계획 superseded", from: "planning", to: "awaiting_approval",
    facts: { plan: { ...base.plan!, status: "superseded" } }, blocked: /plan status superseded/ },
  // T09 의 나머지 갈래: 환경 연결이 끊기면 지문이 맞아도 승인 못 함
  { name: "T09 지문 맞아도 도착 환경 끊김 → 막힘", from: "awaiting_approval", to: "approved",
    facts: { targetConn: "error" }, ev: { planHash: "h1" }, blocked: /env not connected/ },
  // T11
  { name: "T11 계획 만료 → stale 통과", from: "awaiting_approval", to: "stale", facts: { plan: { ...base.plan!, expired: true } } },
  { name: "T11 환경 바뀜 → stale 통과", from: "awaiting_approval", to: "stale", ev: { staleReason: "env_changed" } },
  { name: "T11 멀쩡하면 stale 못 감", from: "awaiting_approval", to: "stale", blocked: /not expired/ },
  // T15 같은 환경(출발=도착)이면 잠금 1개로 충분
  { name: "T15 같은 환경: 잠금 1개면 통과", from: "approved", to: "provisioning",
    facts: { sourceEnvId: "x", targetEnvId: "x", locks: { total: 1, live: 1, reservedLive: 1 } } },
  { name: "T15 다른 환경: 잠금 1개면 막힘", from: "approved", to: "provisioning",
    facts: { locks: { total: 1, live: 1, reservedLive: 1 } }, blocked: /live=1\/2/ },
  { name: "T15 잠금은 쥐었지만 연결 끊김", from: "approved", to: "provisioning",
    facts: { sourceConn: "error", locks: { total: 2, live: 2, reservedLive: 2 } }, blocked: /env not connected/ },
  // T16
  { name: "T16 잠금 만료 → stale 통과", from: "approved", to: "stale", facts: { locks: { total: 2, live: 1, reservedLive: 1 } } },
  { name: "T16 잠금 살아 있고 계획 유효 → 막힘", from: "approved", to: "stale",
    facts: { locks: { total: 2, live: 2, reservedLive: 2 } }, blocked: /lock still valid/ },
  // T17
  { name: "T17 apply 성공", from: "provisioning", to: "deploying", ev: { applyOk: true } },
  { name: "T17 apply 증거 없음", from: "provisioning", to: "deploying", blocked: /applyOk/ },
  { name: "T17 apply 실패 증거", from: "provisioning", to: "deploying", ev: { applyOk: false }, blocked: /applyOk/ },
  // T20: 둘 다 있어야
  { name: "T20 Argo 건강 + 보안 동등", from: "deploying", to: "syncing", ev: { argoHealthy: true, securityParity: true } },
  { name: "T20 보안 동등 없음", from: "deploying", to: "syncing", ev: { argoHealthy: true }, blocked: /securityParity/ },
  { name: "T20 Argo 건강 없음", from: "deploying", to: "syncing", ev: { securityParity: true }, blocked: /argoHealthy/ },
  // T21 경계: 정확히 500ms 는 통과, 501ms 는 막힘, 마커 값 없으면 막힘
  { name: "T21 마커 500ms 경계 통과", from: "syncing", to: "shifting", ev: { snapshotDone: true, markerRoundTripMs: 500 } },
  { name: "T21 마커 501ms 막힘", from: "syncing", to: "shifting", ev: { snapshotDone: true, markerRoundTripMs: 501 }, blocked: /marker round trip/ },
  { name: "T21 마커 값 없음", from: "syncing", to: "shifting", ev: { snapshotDone: true }, blocked: /marker round trip/ },
  // T22 경계: 29초 관찰은 막힘
  { name: "T22 관찰 29초 막힘", from: "shifting", to: "cutover",
    ev: { weightPct: 100, observedSec: 29, targetLogsSeen: true }, blocked: /observe/ },
  { name: "T22 가중치 99 막힘", from: "shifting", to: "cutover",
    ev: { weightPct: 99, observedSec: 30, targetLogsSeen: true }, blocked: /weight must be 100/ },
  // T23 / T24
  { name: "T23 컷오버 단계 ok", from: "cutover", to: "rollback_window", ev: { cutoverStepsOk: true } },
  { name: "T23 컷오버 단계 실패", from: "cutover", to: "rollback_window", ev: { cutoverStepsOk: false }, blocked: /cutover steps/ },
  { name: "T24 되돌림 ok", from: "cutover", to: "shifting", ev: { revertOk: true } },
  { name: "T24 되돌림 증거 없음", from: "cutover", to: "shifting", blocked: /revertOk/ },
  // T25(P-4) / T26
  { name: "T25 창 열림 → 롤백 통과", from: "rollback_window", to: "rolling_back" },
  { name: "T25 창 닫힘 → 롤백 막힘", from: "rollback_window", to: "rolling_back", facts: { rollbackWindowOver: true }, blocked: /window is over/ },
  { name: "T26 창 닫힘 + 정리 승인 → cleanup", from: "rollback_window", to: "cleanup",
    facts: { rollbackWindowOver: true }, ev: { cleanupApproved: true } },
  { name: "T26 창 아직 열림 → cleanup 막힘", from: "rollback_window", to: "cleanup",
    ev: { cleanupApproved: true }, blocked: /still open/ },
  { name: "T26 정리 승인 없음", from: "rollback_window", to: "cleanup",
    facts: { rollbackWindowOver: true }, blocked: /cleanup plan not approved/ },
  // T27
  { name: "T27 임시 자원 0 + 운영 역할 회수", from: "cleanup", to: "completed", ev: { tempResources: 0, operateRoleRevoked: true } },
  { name: "T27 임시 자원 남음", from: "cleanup", to: "completed", ev: { tempResources: 1, operateRoleRevoked: true }, blocked: /temporary resources/ },
  { name: "T27 역할 회수 안 됨", from: "cleanup", to: "completed", ev: { tempResources: 0 }, blocked: /operate role/ },
  // T35
  { name: "T35 출발 100% + 건강", from: "rolling_back", to: "rolled_back", ev: { sourceWeight100: true, sourceHealthy: true } },
  { name: "T35 출발 건강 확인 없음", from: "rolling_back", to: "rolled_back", ev: { sourceWeight100: true }, blocked: /source not healthy/ },
  // T38
  { name: "T38 수동 정리 확인 → 취소", from: "failed", to: "cancelled", ev: { manualCleanupConfirmed: true } },
  { name: "T38 확인 없이 취소 막힘", from: "failed", to: "cancelled", blocked: /manual cleanup/ },
  // T32: paused 에서 rolling_back 은 paused_from 과 상관없이 간다 (조건 없음)
  { name: "T32 paused → rolling_back 은 재개 규칙 안 탐", from: "paused", to: "rolling_back", facts: { pausedFrom: "syncing" } },
  { name: "T31 paused → cleanup 은 paused_from=cleanup 일 때만", from: "paused", to: "cleanup",
    facts: { pausedFrom: "shifting" }, ev: { ruleCleared: true }, blocked: /resume only to paused_from/ },
];

for (const c of CASES) {
  test(`가드 ${c.name}`, () => {
    // 표에 적은 이동이 VALID 에도 있는지 먼저 (오타면 시험 자체가 틀린 것)
    assert.ok(VALID[c.from].includes(c.to), `VALID 에 없는 이동: ${c.from}>${c.to}`);
    const r = checkGuard(c.from, c.to, { facts: f(c.facts), ev: c.ev ?? {} });
    if (c.blocked) assert.match(r ?? "(통과함)", c.blocked);
    else assert.equal(r, null);
  });
}

test("VALID 모양: 끝 상태 3개는 나가는 길이 없고, 끝 상태가 아닌 것은 나가는 길이 있다", () => {
  for (const s of MIGRATION_STATUSES) {
    if (TERMINAL.includes(s)) assert.deepEqual(VALID[s], [], s);
    else assert.ok(VALID[s].length > 0, `${s} 에서 막다른 길`);
  }
});

test("VALID 모양: 22개 상태 모두 draft 에서 닿을 수 있다 (고아 상태 없음)", () => {
  const seen = new Set<MigrationStatus>(["draft"]);
  const q: MigrationStatus[] = ["draft"];
  while (q.length) for (const n of VALID[q.shift()!]) if (!seen.has(n)) { seen.add(n); q.push(n); }
  assert.deepEqual(MIGRATION_STATUSES.filter((s) => !seen.has(s)), []);
});

test("VALID 모양: 끝 상태가 아닌 모든 상태에서 끝 상태(completed·rolled_back·cancelled) 중 하나로 갈 길이 있다", () => {
  const canEnd = (from: MigrationStatus) => {
    const seen = new Set<MigrationStatus>([from]); const q = [from];
    while (q.length) for (const n of VALID[q.shift()!]) {
      if (TERMINAL.includes(n)) return true;
      if (!seen.has(n)) { seen.add(n); q.push(n); }
    }
    return false;
  };
  assert.deepEqual(MIGRATION_STATUSES.filter((s) => !TERMINAL.includes(s) && !canEnd(s)), []);
});

test("VALID 모양: 자원을 만든 뒤(provisioning 이후)엔 cancelled 로 바로 못 간다 (정리 없이 버리기 금지)", () => {
  const after: MigrationStatus[] = ["provisioning", "deploying", "syncing", "shifting", "cutover",
    "rollback_window", "cleanup", "paused", "rolling_back"];
  for (const s of after) assert.ok(!VALID[s].includes("cancelled"), `${s} → cancelled 가 열려 있음`);
});
