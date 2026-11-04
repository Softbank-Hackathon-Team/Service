import type { MigrationStatus, TransitionEvidence } from "@svc/contracts";
import type { Tx } from "./db.js";
import { ROLLBACK_ON_REJECT, RETRYABLE_FAILURES } from "@svc/contracts";
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
  // 신뢰도가 문턱값(SPEC_MIN_CONFIDENCE) 미만이고 사람이 아직 처리(승인) 안 한 칸 수. 없거나 0이면 통과. 깃발 꺼짐(0)이면 늘 0
  specLowConfidenceOpen?: number;
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
// DRAFT(ai): 신뢰도 문턱값. 0 = 꺼짐(기본, 지금 동작 그대로). 0~1 숫자만 켜짐, 숫자가 아니거나 범위 밖이면 꺼짐으로 본다
//   (잘못된 값은 시작 때 설정 검사가 먼저 알린다). 읽는 때마다 env 를 봐서 시험이 값을 바꿀 수 있다. TODO(human): 값·칸 범위는 팀 결정(N1)
export function specMinConfidence(env: NodeJS.ProcessEnv = process.env): number {
  const n = envNumber(env.SPEC_MIN_CONFIDENCE, 0);
  return Number.isFinite(n) && n > 0 && n <= 1 ? n : 0;
}
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
    need(facts.specNeedsReview === 0, `${facts.specNeedsReview} field(s) need review`) ??
    need((facts.specLowConfidenceOpen ?? 0) === 0, `${facts.specLowConfidenceOpen} field(s) below min confidence`),
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
  // G7-3: 승인 뒤 환경을 다른 계정으로 다시 연결하면(env_changed) 잠금·만료와 상관없이 낡음
  "approved>stale": ({ facts, ev }) =>                                                      // T16
    need(facts.locks.live < envCount(facts) || facts.plan?.expired === true || ev.staleReason === "env_changed",
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
  // DECISION(team) Jeong 11/4 01:53Z (ADR-066 개정): failed = "재시도할까?" 질문 대기. 다시 계획(failed>prechecking, 예전 T37)은 없앴다.
  //   failed → 실패 지점(재시도)은 checkGuard 가 한 곳에서 본다. 여기는 롤백·취소만
  // F8-1 + 01:53Z: 자원을 만든 뒤(provisioning·cutover·rolling_back) 실패면 거절 = 롤백, rolling_back 실패는 재시도도 같은 길
  "failed>rolling_back": ({ facts }) =>
    need(facts.failedAtStatus !== null && ROLLBACK_ON_REJECT.includes(facts.failedAtStatus),
      `failed at ${facts.failedAtStatus ?? "?"}: rollback only if failed at ${ROLLBACK_ON_REJECT.join("/")}`),
  // T38: 수동 정리 확인, 또는 01:53Z 거절인데 만든 자원이 없는 실패(가져오기·점검·계획)
  "failed>cancelled": ({ facts, ev }) =>
    ev.manualCleanupConfirmed === true ? null
      : need(ev.failureDecision === "rollback" && facts.failedAtStatus !== null && !ROLLBACK_ON_REJECT.includes(facts.failedAtStatus),
          "manual cleanup not confirmed"),
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
  // DRAFT(ai) Jeong 11/4 01:53Z 재시도: failed 에서 실패 지점 상태로만, 사람이 "재시도"를 고른 증거가 있어야 (POST .../failure-decision)
  if (from === "failed" && RETRYABLE_FAILURES.includes(to) && to !== "rolling_back")
    return need(g.facts.failedAtStatus === to, `retry only to failed_at_status (${g.facts.failedAtStatus ?? "?"})`) ??
      need(g.ev.failureDecision === "retry", "failureDecision retry required");
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
            COALESCE(sv.low_open, 0)::int AS spec_low_open,
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
                -- 명세 칸별 출처·신뢰도 = spec_v2->'fieldMeta'. to_jsonb 로 읽어 칸이 없거나 NULL·객체가 아니면 빈 객체
                (SELECT count(*) FROM jsonb_each(sv2.meta) f
                  WHERE f.value->>'needs_review' = 'true') AS needs_review,
                -- 문턱값 미만 + 아직 승인 안 한 칸(needs_review 가 false 로 바뀌면 처리된 것). 문턱값 0 이면 셈 자체를 안 한다
                -- confidence 가 숫자 글자면 숫자로, 숫자가 아니거나 없으면 가장 낮은 쪽(-1)으로 본다
                (SELECT count(*) FROM jsonb_each(sv2.meta) f
                  WHERE $2::numeric > 0 AND jsonb_typeof(f.value) = 'object'
                    AND COALESCE(f.value->>'needs_review', 'true') <> 'false'
                    AND (CASE WHEN f.value->>'confidence' ~ '^[0-9]+(\\.[0-9]+)?$'
                              THEN (f.value->>'confidence')::numeric ELSE -1 END) < $2::numeric) AS low_open
           FROM spec_versions s
           CROSS JOIN LATERAL (SELECT CASE WHEN jsonb_typeof(to_jsonb(s)->'spec_v2'->'fieldMeta') = 'object'
                                           THEN to_jsonb(s)->'spec_v2'->'fieldMeta' ELSE '{}'::jsonb END AS meta) sv2
          WHERE s.migration_id = m.id
            -- Z19 H1: AI 초안 판(field_meta._draft)은 사람이 받아들이기 전까지 조건에 안 쓴다 (packages/agent DRAFT_MARKER_KEY)
            AND NOT (s.field_meta ? '_draft')
          ORDER BY s.version DESC LIMIT 1) sv ON true
       LEFT JOIN LATERAL (
         SELECT id, plan_hash, status, expires_at FROM plans
          WHERE migration_id = m.id ORDER BY created_at DESC LIMIT 1) p ON true
      WHERE m.id = $1`, [migrationId, specMinConfidence()]);
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
    specLowConfidenceOpen: x.spec_low_open,
    plan: x.plan_id ? { id: x.plan_id, hash: x.plan_hash, status: x.plan_status,
                        expired: x.plan_expired, expiresAt: x.plan_expires_at } : null,
    locks: { total: x.locks_total, live: x.locks_live, reservedLive: x.locks_reserved_live },
  };
}

// 조건이 붙은 이동 목록 (시험과 명세 역추출용)
export const GUARDED_TRANSITIONS = Object.keys(GUARDS) as `${MigrationStatus}>${MigrationStatus}`[];
