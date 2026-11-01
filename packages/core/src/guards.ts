import type { MigrationStatus, TransitionEvidence } from "@svc/contracts";
import type { Tx } from "./db.js";
import { REPLANNABLE_FAILURES } from "./states.js";
import { envNumber } from "@svc/contracts";

// 전이 조건(guard). VALID는 "갈 수 있는 길"만 보고, 여기서는 "지금 그 길을 가도 되나"를 본다.
// 근거: 상태 전이표 T01~T39 (qa/09 2절). 조건 판단은 순수 함수라 DB 없이 시험한다.

// DB에서 다시 읽은 사실. 시각 비교는 워커 시계가 아니라 DB now()로 미리 계산해 둔다
export interface GuardFacts {
  status: MigrationStatus;
  pausedFrom: MigrationStatus | null;
  failedAtStatus: MigrationStatus | null;
  rollbackWindowOver: boolean;          // 롤백 가능 창 마감 시각이 지났나
  sourceEnvId: string;
  targetEnvId: string;
  sourceConn: string;                   // 출발 환경 연결 상태
  targetConn: string;
  specVersion: number | null;           // 최신 명세 버전 (없으면 null)
  specNeedsReview: number;              // 최신 명세에서 needs_review=true 칸 수
  plan: { id: string; hash: string; status: string; expired: boolean; expiresAt: Date } | null;
  locks: { total: number; live: number; reservedLive: number }; // 이 이전이 쥔 환경 잠금 줄
}

// DRAFT(ai): T21 마커 왕복 기준. 컷오버 펜스 중 따라잡기 시간과 같은 자릿수로 둔다
export const MAX_MARKER_RTT_MS = envNumber(process.env.REPL_MAX_MARKER_RTT_MS, 500);
// M7 DRAFT(ai): T22 100%에서 시계로 관찰할 최소 초. 기본 30. 가짜 지표 데모·smoke만 TRAFFIC_OBSERVE_SEC를 짧게 준다
// (그때 shift 감사 detail에 observeCompressed: true가 남는다). 워커 shift 작업도 이 값을 그대로 쓴다(한 곳에서만 정함)
// Z38 R3-9: 값 검사. 빈 값("")은 Number→0 이라 30초 조건이 통째로 꺼졌고, 글자(NaN)면 T22 가 영원히 막혔다 → 둘 다 30.
//   진짜 지표(PROM_URL)로 판정할 때는 압축하지 않는다(최소 30): .env.example 의 0.5 를 그대로 복사한 실클라우드 실행에서도
//   100% 관찰이 0.5초로 줄지 않게. 가짜 지표 데모·smoke(PROM_URL 없음)만 짧게 된다. DRAFT(ai)
export function observeMinSec(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.TRAFFIC_OBSERVE_SEC);
  const v = env.TRAFFIC_OBSERVE_SEC?.trim() && Number.isFinite(n) && n > 0 ? n : 30;
  return env.PROM_URL ? Math.max(v, 30) : v;
}
export const OBSERVE_MIN_SEC = observeMinSec();
export type { TransitionEvidence };

export interface GuardInput {
  facts: GuardFacts;
  ev: TransitionEvidence;
  failureCode?: string;
}

const bothConnected = (f: GuardFacts) =>
  f.sourceConn === "connected" && f.targetConn === "connected"
    ? null : `env not connected (source=${f.sourceConn}, target=${f.targetConn})`;
const envCount = (f: GuardFacts) => (f.sourceEnvId === f.targetEnvId ? 1 : 2);
const need = (cond: boolean, reason: string) => (cond ? null : reason);
// T07·T09 공통: 최신 계획서가 있고, 제안 상태이고, 만료 전
const planUsable = (f: GuardFacts) =>
  need(f.plan !== null, "no plan") ??
  need(f.plan!.status === "proposed", `plan status ${f.plan!.status}`) ??
  need(!f.plan!.expired, "plan expired");

type Guard = (g: GuardInput) => string | null;   // null = 통과, 문자열 = 막힌 이유

// "from>to" → 조건. 표에 없는 이동은 조건 없음 (VALID만 보면 됨)
const GUARDS: Partial<Record<`${MigrationStatus}>${MigrationStatus}`, Guard>> = {
  // 준비 구간
  "draft>importing": ({ facts }) => bothConnected(facts),                                   // T01
  "importing>spec_review": ({ facts }) => need(facts.specVersion !== null, "no spec saved"), // T02
  "spec_review>prechecking": ({ facts }) =>                                                 // T04
    need(facts.specVersion !== null, "no spec") ??
    need(facts.specNeedsReview === 0, `${facts.specNeedsReview} field(s) need review`),
  "prechecking>planning": ({ ev }) =>                                                       // T05
    need(ev.precheckBlockers === 0, "precheckBlockers must be 0"),
  "prechecking>spec_review": ({ ev }) =>                                                    // T06
    need((ev.precheckBlockers ?? 0) >= 1, "precheckBlockers must be >= 1"),
  "planning>awaiting_approval": ({ facts }) => planUsable(facts),                            // T07
  "awaiting_approval>approved": ({ facts, ev }) =>                                          // T09
    planUsable(facts) ??
    need(ev.planHash === facts.plan!.hash, "planHash mismatch") ??
    bothConnected(facts),
  "awaiting_approval>stale": ({ facts, ev }) =>                                             // T11
    need(facts.plan?.expired === true || ev.staleReason === "env_changed",
      "plan not expired and env not changed"),
  "approved>provisioning": ({ facts }) =>                                                   // T15
    need(facts.locks.reservedLive === envCount(facts) || facts.locks.live === envCount(facts),
      `env lock not held (live=${facts.locks.live}/${envCount(facts)})`) ??
    bothConnected(facts),
  "approved>stale": ({ facts }) =>                                                          // T16
    need(facts.locks.live < envCount(facts) || facts.plan?.expired === true,
      "lock still valid and plan not expired"),
  "provisioning>deploying": ({ ev }) => need(ev.applyOk === true, "applyOk required"),      // T17

  // 이전 구간
  "deploying>syncing": ({ ev }) =>                                                          // T20
    need(ev.argoHealthy === true, "argoHealthy required") ??
    need(ev.securityParity === true, "securityParity required"),
  "syncing>shifting": ({ ev }) =>                                                           // T21
    // DRAFT(ai): 쓰기 부하 중에도 넘어가야 해서 "슬롯 지연 0바이트" 대신 마커 왕복 시간으로 본다 (10/31 결정 기록)
    need(ev.snapshotDone === true, "initial snapshot not done") ??
    need(ev.markerRoundTripMs !== undefined && ev.markerRoundTripMs <= MAX_MARKER_RTT_MS,
      `marker round trip must be <= ${MAX_MARKER_RTT_MS}ms`),
  "shifting>cutover": ({ ev }) =>                                                           // T22
    need(ev.weightPct === 100, "weight must be 100") ??
    need((ev.observedSec ?? 0) >= OBSERVE_MIN_SEC, `observe >= ${OBSERVE_MIN_SEC}s at 100%`) ??
    need(ev.targetLogsSeen === true, "target logs not seen"),
  "cutover>rollback_window": ({ ev }) => need(ev.cutoverStepsOk === true, "cutover steps not ok"), // T23
  "cutover>shifting": ({ ev }) => need(ev.revertOk === true, "revertOk required"),          // T24
  "rollback_window>cleanup": ({ facts, ev }) =>                                             // T26
    need(facts.rollbackWindowOver, "rollback window still open") ??
    need(ev.cleanupApproved === true, "cleanup plan not approved"),
  "cleanup>completed": ({ ev }) =>                                                          // T27
    need(ev.tempResources === 0, "temporary resources remain") ??
    need(ev.operateRoleRevoked === true, "operate role not revoked"),

  // 롤백·실패
  // P-4 DRAFT(ai): 롤백 가능 창이 끝나면 롤백도 닫는다 (창 = 롤백 약속 기간). 대안 "cleanup 시작 전까지 허용"은 버림:
  //   정리 작업이 늦게 깨어나면 약속보다 길게 열려 있게 된다. TODO(human): 팀 확인
  "rollback_window>rolling_back": ({ facts }) =>                                            // T25(번호 추정)
    need(!facts.rollbackWindowOver, "rollback window is over"),
  "rolling_back>rolled_back": ({ ev }) =>                                                   // T35
    need(ev.sourceWeight100 === true, "source weight not 100") ??
    need(ev.sourceHealthy === true, "source not healthy"),
  "failed>planning": ({ facts }) =>                                                         // T37
    need(facts.failedAtStatus !== null && REPLANNABLE_FAILURES.includes(facts.failedAtStatus),
      `failed at ${facts.failedAtStatus ?? "?"}: replan only if failed at provisioning or earlier`),
  "failed>cancelled": ({ ev }) =>                                                           // T38
    need(ev.manualCleanupConfirmed === true, "manual cleanup not confirmed"),
};

// 이동 하나의 조건을 본다. null = 통과
export function checkGuard(from: MigrationStatus, to: MigrationStatus, g: GuardInput): string | null {
  // T30: 일시정지는 가드레일 규칙(또는 청소 작업의 실패 사유)이 있어야 한다
  if (to === "paused")
    return need(!!g.ev.guardrailRule || !!g.failureCode, "guardrailRule or failureCode required");
  // Z38-1: P-4 "롤백 가능 창이 끝나면 롤백도 닫는다"를 일시정지 옆길에서도 지킨다.
  //   cleanup → paused(청소 작업 WORKER_LOST 등) → rolling_back 은 창 뒤 롤백이다. 정리가 복제를 이미 걷었으면
  //   rollback 작업은 noop 이고 트래픽만 출발(쓰기 금지 상태)로 돌아가 쓰기가 전부 실패한다
  if (from === "paused" && to === "rolling_back" && g.facts.pausedFrom === "cleanup")
    return "rollback window is over (paused from cleanup)";
  // T31/T32: 일시정지에서는 멈추기 전 상태로만 돌아가거나 롤백한다
  if (from === "paused" && to !== "rolling_back")
    return need(g.facts.pausedFrom === to, `resume only to paused_from (${g.facts.pausedFrom ?? "?"})`) ??
      need(g.ev.ruleCleared === true, "guardrail rule not cleared");
  const guard = GUARDS[`${from}>${to}`];
  return guard ? guard(g) : null;
}

// 조건 판단에 쓸 사실을 한 번에 읽는다. 이전 행은 advance()가 이미 FOR UPDATE로 잠근 뒤다
export async function loadGuardFacts(tx: Tx, migrationId: string): Promise<GuardFacts | null> {
  const r = await tx.query(
    `SELECT m.status, m.paused_from, m.failed_at_status,
            (m.rollback_window_ends_at IS NOT NULL AND m.rollback_window_ends_at <= now()) AS window_over,
            m.source_env_id, m.target_env_id,
            se.connection_status AS source_conn, te.connection_status AS target_conn,
            sv.version AS spec_version, COALESCE(sv.needs_review, 0)::int AS spec_needs_review,
            p.id AS plan_id, p.plan_hash, p.status AS plan_status, p.expires_at AS plan_expires_at,
            (p.expires_at <= now()) AS plan_expired,
            (SELECT count(*) FROM env_locks l WHERE l.migration_id = m.id)::int AS locks_total,
            (SELECT count(*) FROM env_locks l WHERE l.migration_id = m.id
               AND l.lease_expires_at > now())::int AS locks_live,
            (SELECT count(*) FROM env_locks l WHERE l.migration_id = m.id
               AND l.holder = 'reserved' AND l.lease_expires_at > now())::int AS locks_reserved_live
       FROM migrations m
       JOIN environments se ON se.id = m.source_env_id
       JOIN environments te ON te.id = m.target_env_id
       LEFT JOIN LATERAL (
         SELECT s.version,
                (SELECT count(*) FROM jsonb_each(s.field_meta) f
                  WHERE f.value->>'needs_review' = 'true') AS needs_review
           FROM spec_versions s WHERE s.migration_id = m.id
            -- Z19 H1: AI 초안 판(field_meta._draft)은 사람이 받아들이기 전까지 조건에 안 쓴다 (packages/agent DRAFT_MARKER_KEY)
            AND NOT (s.field_meta ? '_draft')
          ORDER BY s.version DESC LIMIT 1) sv ON true
       LEFT JOIN LATERAL (
         SELECT id, plan_hash, status, expires_at FROM plans
          WHERE migration_id = m.id ORDER BY created_at DESC LIMIT 1) p ON true
      WHERE m.id = $1`, [migrationId]);
  const x = r.rows[0];
  if (!x) return null;
  return {
    status: x.status,
    pausedFrom: x.paused_from,
    failedAtStatus: x.failed_at_status,
    rollbackWindowOver: x.window_over,
    sourceEnvId: x.source_env_id,
    targetEnvId: x.target_env_id,
    sourceConn: x.source_conn,
    targetConn: x.target_conn,
    specVersion: x.spec_version,
    specNeedsReview: x.spec_needs_review,
    plan: x.plan_id ? { id: x.plan_id, hash: x.plan_hash, status: x.plan_status,
                        expired: x.plan_expired, expiresAt: x.plan_expires_at } : null,
    locks: { total: x.locks_total, live: x.locks_live, reservedLive: x.locks_reserved_live },
  };
}

// 조건이 붙은 이동 목록 (시험과 명세 역추출용)
export const GUARDED_TRANSITIONS = Object.keys(GUARDS) as `${MigrationStatus}>${MigrationStatus}`[];
