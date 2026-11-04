import type { Tx } from "./db.js";
import { pool } from "./db.js";
import { EnvBusy } from "./errors.js";

// 환경 잠금: 한 환경(고객 계정 하나)은 한 번에 한 이전만 고친다.
// 일생: 승인 때 예약(reserved, 계획 만료까지) → 작업 시작 때 인수(worker:<id>, 90초)
//       → 30초마다 연장 → 끝나면 반납(reserved, 10분) → 완료·롤백됨·취소·낡음에서 해제.
//       실행이 실패하면 잠금은 남긴다 (클라우드에 반쯤 만든 것이 있을 수 있어 사람이 본다).
// STUB: 앱 단위 잠금, 다른 이전에게 순서 넘기기(대기열)는 없다. 지금은 409 ENV_BUSY로 끝낸다
// DRAFT(ai): 기한이 지난 예약도 다른 이전이 바로 뺏지 못한다. 지우는 것은 청소 작업(60초마다)뿐이다.
//            그래서 "기한 지남"은 "지금 일하는 작업 없음"일 뿐, 환경이 빈 것은 아니다

// z75-20: 기한·연장·스스로 멈춤 시간을 env로 줄일 수 있다 (워커가 죽었을 때 회복을 빨리 보려는 데모·측정용).
//         값을 안 주면 지금과 같다 (90·30·60). 연장 간격은 안 주면 기한의 1/3.
//         연장 간격 < 스스로 멈춤 < 기한 이 아니면 시작할 때 바로 멈춘다 (둘이 동시에 일하는 틈을 막는 순서)
export interface LeaseTimes {
  workerSec: number;      // 인수·연장 기한 (기본 90)
  heartbeatSec: number;   // 연장 간격 (기본 30)
  selfFenceSec: number;   // DB에 못 닿은 채 이만큼 지나면 스스로 멈춤 (기본 60 = 90 - 여유 30)
  handBackSec: number;    // 반납 뒤 다음 작업이 집어 갈 시간 (600, env 없음)
}
// Z38 R8-4: 생존 신호 감시 타이머의 최대 간격(초). apps/worker/src/lease/heartbeat.ts 가 이 값을 쓴다
export const FENCE_SLACK_SEC = 5;
export function leaseFromEnv(env: NodeJS.ProcessEnv = process.env): Readonly<LeaseTimes> {
  const num = (name: string, fallback: number): number => {
    const raw = env[name];
    if (raw === undefined || raw === "") return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer (got ${raw})`);
    return n;
  };
  const workerSec = num("ENVLOCK_WORKER_SEC", 90);
  const selfFenceSec = num("ENVLOCK_SELF_FENCE_SEC", workerSec === 90 ? 60 : Math.round(workerSec * 2 / 3));
  const heartbeatSec = num("ENVLOCK_HEARTBEAT_SEC", Math.max(1, Math.floor(workerSec / 3)));
  if (!(heartbeatSec < selfFenceSec && selfFenceSec < workerSec)) {
    throw new Error(`envlock lease needs heartbeat < selfFence < worker (got ${heartbeatSec} < ${selfFenceSec} < ${workerSec})`);
  }
  // Z38 R8-4: 스스로 멈춤은 감시 타이머(최대 FENCE_SLACK_SEC 간격)가 알아챈다 → 실제 멈춤은 selfFence + 최대 5초.
  //           같은 작업 재시도의 인수 시점(기한 - 남은 시간)이 그보다 늦어야 둘이 겹치지 않는다
  if (!(selfFenceSec + FENCE_SLACK_SEC < workerSec)) {
    throw new Error(`envlock lease needs selfFence + ${FENCE_SLACK_SEC} < worker (got ${selfFenceSec} + ${FENCE_SLACK_SEC} >= ${workerSec})`);
  }
  return Object.freeze({ workerSec, heartbeatSec, selfFenceSec, handBackSec: 600 });
}

export const LEASE = leaseFromEnv();

// z32-10: 기한이 지났고, 쥔 이전이 "잠금을 쥘 일이 없는 상태"(승인 전·거절·낡음·끝)면 고아 잠금이니 회수한다.
//         approved(예약 만료)는 예전처럼 청소가 낡음 처리한 뒤에만 (DRAFT(ai) 규칙, envlock-conflict 시험).
//         실행 중·멈춤·롤백 중·실패(반쯤 만든 자원이 있을 수 있음)도 남겨 409 ENV_BUSY (사람이 본다)
export const RECLAIMABLE_OWNER_STATUSES: readonly string[] = [
  "draft", "importing", "spec_review", "prechecking", "planning", "awaiting_approval",
  "rejected", "stale", "completed", "rolled_back", "cancelled",
];
export interface ReclaimedLock { envId: string; fromMigrationId: string; fromHolder: string; fromStatus: string; expiredAt: string }

// 승인 때: 출발·도착 환경을 예약한다. 같은 이전이 이미 쥔 줄이면 기한만 늘린다.
// 돌려주는 값: 위 규칙으로 회수한 남의 잠금 (부르는 쪽이 감사에 LOCK_RECLAIMED 로 남긴다)
export async function reserveEnvLocks(
  tx: Tx, m: { id: string; tenantId: string }, envIds: string[], until: Date,
): Promise<ReclaimedLock[]> {
  const reclaimed: ReclaimedLock[] = [];
  // 잠금 순서를 늘 같게 (교착 방지): 환경 번호 오름차순
  for (const envId of [...new Set(envIds)].sort()) {
    const gone = await tx.query(
      `DELETE FROM env_locks l USING migrations o
        WHERE l.env_id = $1 AND l.migration_id <> $2 AND l.lease_expires_at < now()
          AND o.id = l.migration_id AND o.status = ANY($3::text[])
        RETURNING l.migration_id, l.holder, o.status, l.lease_expires_at`,
      [envId, m.id, RECLAIMABLE_OWNER_STATUSES]);
    for (const x of gone.rows) reclaimed.push({ envId, fromMigrationId: x.migration_id, fromHolder: x.holder,
      fromStatus: x.status, expiredAt: new Date(x.lease_expires_at).toISOString() });
    const r = await tx.query(
      `INSERT INTO env_locks (env_id, tenant_id, migration_id, holder, lease_expires_at)
       VALUES ($1, $2, $3, 'reserved', $4)
       ON CONFLICT (env_id) DO UPDATE
         SET holder = 'reserved', lease_expires_at = EXCLUDED.lease_expires_at,
             job_id = NULL, job_queue = NULL
         WHERE env_locks.migration_id = EXCLUDED.migration_id
       RETURNING 1`,
      [envId, m.tenantId, m.id, until]);
    if (r.rowCount === 0) throw new EnvBusy(envId);
  }
  return reclaimed;
}

// 작업 시작 때: 예약 상태이거나 기한이 지난 잠금만 인수한다. false면 작업을 거부(job.rejected)
// Z32: 또는 "같은 pg-boss 작업 번호"가 쥔 잠금 (번호는 Z36 jobRef가 적는다). pg-boss는 앞 시도의 생존 신호가 끊겨야만
//      같은 번호로 재시도를 내보내므로, 그 번호가 쥔 잠금 = 죽은 앞 시도의 잠금이다. 예전엔 기한(90초)까지 job.rejected →
//      청소 작업이 paused(WORKER_LOST)로 보냈다. 앞 시도가 사실은 살아 있었다면 다음 연장에서 NOT_OWNER로 멈추고 ③ fence에서 막힌다
// Z32 4차 (Z43-2, Z38 REVIEW-4): 단, 마지막 연장 뒤 selfFenceSec(60초)가 지난 잠금만 (= 남은 기한 < workerSec - selfFenceSec = 30초).
//      생존 신호만 놓친 "가짜 죽음"(DB 끊김·이벤트 루프 멈춤)이면 앞 시도는 그 60초 안에 스스로 멈춘다 → 둘이 동시에 일하지 않는다.
//      그 전에 온 재시도는 runStep이 sameJobTakeoverWaitSec 만큼 기다렸다 한 번 더 인수한다
// Z38 R8-4: 감시 타이머 간격(FENCE_SLACK_SEC)만큼 더 기다린다. 예전(90-60=30)엔 앞 시도가 60~65초에 멈추는데 재시도는 60초에 인수 → 최대 5초 겹침
export const SAME_JOB_TAKEOVER_LEFT_SEC = LEASE.workerSec - LEASE.selfFenceSec - FENCE_SLACK_SEC;
export async function acquireEnvLock(
  tx: Tx,
  a: { migrationId: string; envId: string; holder: string; jobId?: string; jobQueue?: string },
): Promise<boolean> {
  const r = await tx.query(
    `UPDATE env_locks
        SET holder = $3, job_id = $4, job_queue = $5,
            lease_expires_at = now() + make_interval(secs => $6)
      WHERE env_id = $1 AND migration_id = $2
        AND (holder = 'reserved' OR lease_expires_at < now()
             -- F8-6: 같은 주인(같은 프로세스)이어도 다른 작업 번호가 기한 안에 쥐고 있으면 거부 (만료·재시도된 shift 둘이 같은 LB 를 바꾸지 않게)
             OR (holder = $3 AND (job_id IS NULL OR $4::uuid IS NULL OR job_id = $4::uuid))
             OR ($4::uuid IS NOT NULL AND job_id = $4::uuid
                 AND lease_expires_at < now() + make_interval(secs => $7)))
      RETURNING 1`,
    [a.envId, a.migrationId, a.holder, a.jobId ?? null, a.jobQueue ?? null, LEASE.workerSec, SAME_JOB_TAKEOVER_LEFT_SEC]);
  return r.rowCount === 1;
}

// Z32 4차: 같은 작업 번호가 쥔 잠금을 인수할 수 있을 때까지 몇 초 남았나. 그 번호의 잠금이 없으면 null
export async function sameJobTakeoverWaitSec(tx: Tx, migrationId: string, jobId: string): Promise<number | null> {
  const r = await tx.query(
    `SELECT max(extract(epoch from lease_expires_at - now()))::float AS left_sec
       FROM env_locks WHERE migration_id = $1 AND job_id = $2::uuid`, [migrationId, jobId]);
  const left = r.rows[0]?.left_sec as number | null;
  return left === null || left === undefined ? null : Math.max(0, left - SAME_JOB_TAKEOVER_LEFT_SEC);
}

// 연장: 내가 주인이고 아직 기한 안일 때만. 연장된 환경 번호를 돌려준다
export async function renewEnvLocks(
  tx: Tx, a: { migrationId: string; envIds: string[]; holder: string },
): Promise<string[]> {
  const r = await tx.query(
    `UPDATE env_locks SET lease_expires_at = now() + make_interval(secs => $4)
      WHERE env_id = ANY($1::uuid[]) AND migration_id = $2 AND holder = $3
        AND lease_expires_at > now()
      RETURNING env_id`,
    [a.envIds, a.migrationId, a.holder, LEASE.workerSec]);
  return r.rows.map((x) => x.env_id as string);
}

// 작업 끝: 예약 상태로 돌려놓는다 (다음 단계 작업이 인수한다)
export async function handBackEnvLock(
  tx: Tx, a: { migrationId: string; envId: string; holder: string },
): Promise<boolean> {
  const r = await tx.query(
    `UPDATE env_locks
        SET holder = 'reserved', job_id = NULL, job_queue = NULL,
            lease_expires_at = now() + make_interval(secs => $4)
      WHERE env_id = $1 AND migration_id = $2 AND holder = $3
      RETURNING 1`,
    [a.envId, a.migrationId, a.holder, LEASE.handBackSec]);
  return r.rowCount === 1;
}

// 되찾기: 롤백을 시작할 때 이 이전의 잠금을 모두 '예약'으로 돌린다 (주인이 누구든).
// 지금 일하던 워커(예: 매달린 sync)는 다음 연장에서 NOT_OWNER로 멈추고, ③의 fence에서 LEASE_LOST로 막힌다.
// 그래야 롤백 작업이 바로 잠금을 인수할 수 있다. 줄은 지우지 않는다 (롤백이 끝날 때까지 다른 이전이 못 들어온다)
export async function reclaimEnvLocks(tx: Tx, migrationId: string): Promise<number> {
  const r = await tx.query(
    `UPDATE env_locks SET holder = 'reserved', job_id = NULL, job_queue = NULL,
            lease_expires_at = now() + make_interval(secs => $2)
      WHERE migration_id = $1`, [migrationId, LEASE.handBackSec]);
  return r.rowCount ?? 0;
}

// 해제: 이 이전이 쥔 잠금을 모두 지운다 (advance가 끝 상태·낡음으로 갈 때 부른다)
export async function releaseEnvLocks(tx: Tx, migrationId: string): Promise<number> {
  const r = await tx.query("DELETE FROM env_locks WHERE migration_id = $1", [migrationId]);
  return r.rowCount ?? 0;
}

export interface ExpiredLock {
  tenantId: string; envId: string; migrationId: string; holder: string;
  jobId: string | null; jobQueue: string | null; status: string;
}

// 청소 작업 전용: 모든 회사의 기한 지난 잠금 목록 (번호와 상태만).
// withTenant 밖에서 pool을 쓰는 예외다. 회사 벽은 DB 함수(svc_maintenance 소유)가 지키고,
// 여기서 받은 번호로 실제 변경은 그 회사의 withTenant 안에서 한다
export async function listExpiredEnvLocks(maxRows = 100): Promise<ExpiredLock[]> {
  const r = await pool.query("SELECT * FROM maint_expired_env_locks($1)", [maxRows]);
  return r.rows.map((x) => ({
    tenantId: x.tenant_id, envId: x.env_id, migrationId: x.migration_id, holder: x.holder,
    jobId: x.job_id, jobQueue: x.job_queue, status: x.status,
  }));
}

// 청소 작업 전용: 24시간 지난 멱등 키 지우기
export async function cleanupIdempotencyKeys(maxAgeHours = 24): Promise<number> {
  const r = await pool.query("SELECT maint_cleanup_idempotency(make_interval(hours => $1)) AS n",
    [maxAgeHours]);
  return r.rows[0]?.n ?? 0;
}

// PF FM-ORC-10: 트래픽 LB 주인 (db 0040). LB 가 워커 전역 하나라 환경 잠금으로는 다른 이전의 shift·롤백을 못 막는다.
//   shift 는 가중치를 바꾸기 전에 take, 롤백은 state 가 'other' 면 LB 를 건드리지 않는다. 끝 상태에서 advance 가 release
export type TrafficLeaseState = "mine" | "other" | "none" | "denied";
export async function takeTrafficLease(tx: Tx, lbId: string, migrationId: string): Promise<TrafficLeaseState> {
  return (await tx.query<{ s: TrafficLeaseState }>("SELECT traffic_lease_take($1, $2) AS s", [lbId, migrationId])).rows[0]!.s;
}
export async function trafficLeaseState(tx: Tx, lbId: string, migrationId: string): Promise<TrafficLeaseState> {
  return (await tx.query<{ s: TrafficLeaseState }>("SELECT traffic_lease_state($1, $2) AS s", [lbId, migrationId])).rows[0]!.s;
}
export async function releaseTrafficLease(tx: Tx, migrationId: string): Promise<number> {
  return (await tx.query<{ n: number }>("SELECT traffic_lease_release($1) AS n", [migrationId])).rows[0]!.n;
}
