// 운영자 명령 (작업 Z32 7a): 정상 길(API 롤백·취소·재개)로 못 치우는 정체 이전을 failed 로 닫는다
// 예: 시험이 env_locks 만 지우고 남긴 rollback_window 이전 (롤백 409 GUARD_FAILED, 취소 409 INVALID_TRANSITION)
// 실행 (Service 루트): npm run ops:force-fail -- <migration id> --reason "<왜>"        ← 무엇을 바꿀지 보여 주기만 (기본)
//                     npm run ops:force-fail -- <migration id> --reason "<왜>" --yes  ← 실제로 바꿈
// 하는 일 (한 트랜잭션, 회사 벽(RLS) 안): 상태 → failed(failure_code OPERATOR_FORCE_FAILED, failed_at_status = 원래 상태),
//   대기 중인(created·retry) 단계 작업 삭제, 환경 잠금 해제, 감사 migration.force_failed (누가·왜·무엇을)
// 끝 상태(completed·failed·rolled_back·cancelled 등)면 아무것도 안 바꾸고 exit 1. 실행 중(active) 작업은 건드리지 않는다(돌다가 상태가 바뀐 걸 보고 멈춘다)
// 상태 기계(VALID)를 우회하는 유일한 길이다. DRAFT(ai): 코드화된 명령 + 감사 = 허용 (손으로 UPDATE 금지 규칙은 그대로)
import pg from "pg";
import { withTenant, writeAudit, releaseEnvLocks, reclaimEnvLocks, STEP_QUEUES, INACTIVE_STATES, LOCKED_STAGES, pool } from "@svc/core";

const args = process.argv.slice(2);
const id = args.find((a) => /^[0-9a-f-]{36}$/i.test(a));
const ri = args.indexOf("--reason");
const reason = ri >= 0 ? args[ri + 1] : undefined;
const yes = args.includes("--yes");
// PF FM-ORC-16: 살아 있는 워커가 기한 안에 쥔 잠금(apply 도는 중 등)이면 막는다. 그 워커는 다음 연장에서 잠금을 잃고 terraform 을 SIGINT 로 멈춰
//   state 밖 고아 자원이 생길 수 있다(FM-ORC-14). 정말 죽은 워커인데 기한만 남았으면 --force-live (또는 90초 기다렸다 다시)
const forceLive = args.includes("--force-live");
if (!id || !reason) {
  console.error('사용법: npm run ops:force-fail -- <migration id> --reason "<왜>" [--yes]');
  process.exit(2);
}
const actor = `operator:${process.env.USER ?? "unknown"}`;

// 회사 번호 찾기만 관리자 연결로 (이전 id 만 알고 회사는 모를 때). 바꾸는 일은 아래 withTenant 안에서
const owner = new pg.Client({ connectionString: process.env.OWNER_DATABASE_URL }); await owner.connect();
const found = (await owner.query("SELECT tenant_id::text t, status FROM migrations WHERE id=$1", [id])).rows[0] as { t: string; status: string } | undefined;
await owner.end();
if (!found) { console.error(`이전 ${id} 없음`); await pool.end(); process.exit(1); }

const out = await withTenant(found.t, async (tx) => {
  const m = (await tx.query("SELECT status FROM migrations WHERE id=$1 FOR UPDATE", [id])).rows[0] as { status: string };
  if (m.status === "failed" || (INACTIVE_STATES as readonly string[]).includes(m.status)) return { changed: false, why: `이미 끝 상태 ${m.status}` };
  const jobs = (await tx.query(
    `SELECT id::text, name, state FROM pgboss.job WHERE name = ANY($1::text[]) AND data->>'migrationId' = $2 AND state IN ('created','retry')`,
    [STEP_QUEUES, id])).rows as { id: string; name: string; state: string }[];
  const lk = (await tx.query(`SELECT count(*)::int n,
      count(*) FILTER (WHERE holder <> 'reserved' AND lease_expires_at > now())::int live FROM env_locks WHERE migration_id=$1`, [id])).rows[0] as { n: number; live: number };
  const locks = lk.n;
  // PF FM-ORC-16: 실행 중(active) 작업도 미리 보기에 보인다 (예전엔 created·retry 만 셈)
  const active = (await tx.query(
    `SELECT count(*)::int n FROM pgboss.job WHERE name = ANY($1::text[]) AND data->>'migrationId' = $2 AND state = 'active'`, [STEP_QUEUES, id])).rows[0].n as number;
  // Jeong 11/4 01:53Z: failed 는 "재시도할까?" 질문 대기다. 자원을 만든 뒤 단계면 잠금을 예약으로 남겨 재시도·거절(롤백)이 그 잠금을 쓴다
  const keepLocks = (LOCKED_STAGES as readonly string[]).includes(m.status);
  const plan = { from: m.status, to: "failed", failureCode: "OPERATOR_FORCE_FAILED", queuedJobs: jobs.length, activeJobs: active, envLocks: locks,
                 liveWorkerLocks: lk.live, envLocksAfter: keepLocks ? "reserved" : "released" };
  if (lk.live > 0 && !forceLive)
    return { changed: false, why: `워커가 기한 안에 쥔 잠금 ${lk.live}개 (실행 중 작업 ${active}개): 지금 바꾸면 그 워커의 terraform 이 끊겨 고아 자원이 생길 수 있음. 워커가 정말 죽었으면 90초 뒤 다시, 아니면 --force-live`, plan, blocked: true };
  if (!yes) return { changed: false, why: "미리 보기 (--yes 없음)", plan };
  await tx.query(`UPDATE migrations SET status='failed', failed_at_status=$2, failure_code='OPERATOR_FORCE_FAILED',
                    paused_from=NULL, updated_at=now() WHERE id=$1`, [id, m.status]);
  if (jobs.length) await tx.query("DELETE FROM pgboss.job WHERE id = ANY($1::uuid[])", [jobs.map((j) => j.id)]);
  const released = keepLocks ? 0 : await releaseEnvLocks(tx, id);
  const kept = keepLocks ? await reclaimEnvLocks(tx, id) : 0;
  await writeAudit(tx, found.t, { actor, action: "migration.force_failed", target: id, result: "ok",
    detail: { ...plan, reason, deletedJobs: jobs.map((j) => `${j.name}:${j.id}`), released, kept, forceLive } });
  return { changed: true, plan };
});
console.log("주의: 바깥 자원(트래픽 가중치·복제 슬롯·임시 역할·도착 자원)은 건드리지 않는다. 다음은 화면 또는 POST /migrations/<id>/failure-decision {choice:\"rollback\"} (만든 자원 지우기는 롤백 끝에 자동)");
console.log(JSON.stringify({ id, tenantId: found.t, actor, reason, ...out }));
await pool.end();
process.exit((out as { blocked?: boolean }).blocked ? 3 : out.changed || !yes ? 0 : 1);
