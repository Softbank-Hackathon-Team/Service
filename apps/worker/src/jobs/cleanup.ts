import { dropRuntimeLinkSecret, targetBundle } from "../app-link.js";
import { commitReplicationCleanup } from "../gitops/index.js";
import { MigrationJob, QUEUES } from "@svc/contracts";
import { replicationFor } from "./_repl.js";
import { asBossDb, boss, withTenant, writeAudit } from "@svc/core";
import { jobData, readMigration, RetryLater, runStep, stubWait, stubFailIfAsked } from "./_step.js";
import { tempRoles } from "../platform.js";
import { pausedOnRenewFailure, withStepRoles } from "./_roles.js";
import { envNumber } from "@svc/contracts";

// 정리. rollback_window → cleanup → completed
// 창이 끝나기 전에 깨어나면(시계 차이 등) 남은 시간 뒤로 자신을 다시 넣는다 (L8)
export async function handleCleanup(raw: unknown) {
  const job = MigrationJob.parse(raw);

  // 1) 창 닫기: rollback_window → cleanup
  const first = await runStep(job, {
    name: "cleanup",
    expect: "rollback_window",
    load: async (tx, j) => {
      const q = await tx.query(
        `SELECT rollback_window_ends_at <= now() AS over FROM migrations WHERE id=$1`, [j.migrationId]);
      return q.rows[0]?.over ? (true as const) : null;
    },
    // DRAFT(ai): 정리 승인 단계가 아직 없어서 "창이 끝나면 자동 정리 = 승인"으로 본다 (TODO(human) 아래와 같은 질문)
    work: async () => ({ to: "cleanup", evidence: { cleanupApproved: true } }),
  });
  if (first === "skipped") {
    // 이미 cleanup 상태면(재시도) 2)로 이어 간다. 그 외는 끝
    const m = await withTenant(job.tenantId, (tx) => readMigration(tx, job.migrationId));
    if (m?.status === "rollback_window") {
      // L8: 창이 아직 안 끝났는데 깨어났다(시계 차이·창 연장). 그냥 끝내면 리퍼도 rollback_window는 안 봐서 영원히 머문다.
      // 남은 초 + 1 뒤로 다시 넣는다. 같은 키라 대기 중인 cleanup이 이미 있으면 안 넣는다(send = null)
      // DRAFT(ai): 창 끝 시각이 비어 있으면(있으면 안 되는 상태) 다시 넣지 않고 끝낸다. 사람이 롤백·정리를 고른다
      await rescheduleUntilWindowEnds(job);
      return first;
    }
    if (m?.status !== "cleanup") return first;
  }

  // 2) 출발 쪽 자원 정리: cleanup → completed
  return runStep(job, {
    name: "cleanup",
    expect: "cleanup",
    // 출발 쪽 정리 = 출발 환경 destroy 단계 실행 역할 (Z39). 이 워커가 빌린 것은 아래 revokeForMigration 이 같이 회수하고 센다 (T27)
    // STUB: 지금 정리 일은 자격을 안 쓴다. 진짜 destroy 가 들어오면 회수를 일 뒤로 옮긴다
    work: async (j, m) => withStepRoles("cleanup", j, m, async () => {
      // APP-22 (가): Terraform 실행 방식 도착의 출발 전용 계정 비밀 그릇을 지운다 (롤백 가능 창이 끝나 다시 출발로 갈 일 없음). 실행 역할 회수 전에
      const linkSecret = await dropRuntimeLinkSecret(j, m);
      // 이 이전에 빌려준 실행 역할 회수 → T27 operateRoleRevoked (DB 장부 기준: 다른 워커가 쥔 것이 남아 있으면 false)
      const roles = await tempRoles().revokeForMigration(j.tenantId, j.migrationId, "cleanup");
      // Z75-04: 다른 워커가 빌린 실행 역할이 아직 살아 있으면(그 워커가 죽었거나 아직 청소 전) 지금 completed 로 가면
      //   전이 조건 "operate role not revoked" 에 3번 걸려 paused(JOB_FAILED_CLEANUP) 가 된다 (Z32 0절에서 찾은 것).
      //   임시 자격은 만료 전에 남이 지울 수 없다 → 그 워커의 청소(15초마다) 또는 만료를 기다렸다가 다시 한다. 상태는 cleanup 그대로
      if (!roles.evidence.operateRoleRevoked && roles.failed === 0 && roles.stillActive > 0) {
        const delaySec = await waitForOtherRolesSec(j);
        throw new RetryLater("cleanup", job, delaySec,
          { reason: "OPERATE_ROLE_HELD_ELSEWHERE", stillActive: roles.stillActive, requested: roles.requested });
      }
      // TODO(human): 출발 쪽 DB·자원을 지울지, 남겨 둘지 (고객 동의 범위). 출발 DB는 쓰기 권한 회수 상태로 남는다
      const repl = await replicationFor(j.tenantId, j.migrationId);
      if (!repl) {
        await stubWait();
        await stubFailIfAsked(j, "cleanup");
        return { to: "completed", detail: { removed: ["STUB: replication slot", "STUB: source app scaled to 0"], roles, stub: true, ...(linkSecret.skipped ? {} : { linkSecret }) },
                 evidence: { tempResources: 0, ...roles.evidence } };   // STUB: 임시 자원 장부
      }
      // 복제 슬롯·발행·구독·마커를 양쪽에서 지우고, 남은 게 없는지 다시 센다 (T27 tempResources)
      const { removed } = await repl.teardown();
      const left = await repl.leftovers();
      // 온프레 CNPG 이전: 복제 걷기가 끝난 뒤에만 gitops 값에서 이전 역할(ensure absent)·터널·터널 키·역할 비밀번호를 걷는다.
      //   찌꺼기가 남았으면 그대로 둔다 (터널이 사라지면 워커가 도착 DB 에 못 붙어 repl-cleanup 으로 다시 걷을 길이 없다)
      const gitopsRepl = left.length === 0
        ? await commitReplicationCleanup(await withTenant(j.tenantId, (tx) => targetBundle(tx, j.tenantId, m)))
        : { skipped: "replication_leftovers" };
      return { to: "completed", detail: { removed: [...removed, "STUB: source app scaled to 0"], leftovers: left, roles, gitopsReplication: gitopsRepl, ...(linkSecret.skipped ? {} : { linkSecret }) },
               evidence: { tempResources: left.length, ...roles.evidence } };
    }),
    // 재발급 실패(Z61) → cleanup → paused(CRED_RENEW_FAILED). 그 밖의 예외는 지금처럼 pg-boss 재시도
    onError: async (e) => pausedOnRenewFailure(e),
  });
}

// 다시 볼 때까지 초: 남은 실행 역할 중 가장 먼저 끝나는 것의 만료 + 1초, 다만 다른 워커 청소 주기의 2배를 넘지 않게
// (살아 있는 워커면 청소가 회수 요청을 처리하고, 죽은 워커면 만료로 닫힌다. 어느 쪽이든 끝이 있다: 자격 수명 ≤ 15분)
export async function waitForOtherRolesSec(job: MigrationJob): Promise<number> {
  const cap = Math.max(1, Math.ceil(2 * envNumber(process.env.TEMP_ROLE_SWEEP_MS, 15000) / 1000));
  return withTenant(job.tenantId, async (tx) => {
    const q = await tx.query<{ s: number | null }>(
      `SELECT ceil(extract(epoch FROM min(expires_at) - now()))::int + 1 AS s FROM temp_credentials
        WHERE migration_id = $1 AND purpose = 'operate' AND status IN ('active', 'revoke_requested') AND expires_at > now()`,
      [job.migrationId]);
    return Math.min(Math.max(q.rows[0]?.s ?? 1, 1), cap);
  });
}

// Z38 R8-25: 창이 끝난 뒤 이만큼(초) 지나서도 건너뛰면 잠금 문제로 보고 다시 넣지 않는다
const WINDOW_OVER_MARGIN_SEC = 5;
// Z32 8차: 창이 끝났는데 남이 잠금을 쥐고 있을 때 다시 볼 간격(초)
export const CLEANUP_LOCK_RETRY_SEC = Math.max(1, Number(process.env.CLEANUP_LOCK_RETRY_SEC) || 15);
async function rescheduleUntilWindowEnds(job: MigrationJob) {
  await withTenant(job.tenantId, async (tx) => {
    const q = await tx.query<{ wait: number | null; over: boolean }>(
      `SELECT GREATEST(ceil(extract(epoch FROM rollback_window_ends_at - now())), 0)::int AS wait,
              rollback_window_ends_at < now() - make_interval(secs => $2) AS over
         FROM migrations WHERE id = $1 AND status = 'rollback_window'`, [job.migrationId, WINDOW_OVER_MARGIN_SEC]);
    const wait = q.rows[0]?.wait;
    if (wait == null) return;
    // Z32 (맥 B4 22:18Z): 창이 이미 끝났는데 건너뛰었다 = 잠금을 못 쥠(잠금 줄 없음·남이 쥠). 예전엔 0+1초 뒤로 다시 넣어
    //   1.5초마다 시작→skipped 가 끝없이 돌았다(시험이 잠금만 지우고 남긴 옛 이전 등). 창이 끝난 뒤의 재예약은 하지 않는다:
    //   잠금을 쥔 쪽이 진행하고, 잠금 줄이 없으면 사람이 롤백·정리를 고른다
    // Z38 REVIEW-8 R8-25: "창 끝남" 은 끝난 지 WINDOW_OVER_MARGIN_SEC 넘었을 때만. 창 끝 바로 전에 시작해 창 검사(guard)에서 건너뛴 작업이
    //   이 줄에 왔을 때 막 끝났으면(wait 0) 예전처럼 1초 뒤 한 번 더 넣는다 (그 한 번이 창 검사를 통과해 정리한다)
    // Z32 8차: 창이 끝났어도 잠금 줄이 남아 있으면(남이 쥠) CLEANUP_LOCK_RETRY_SEC(15초) 뒤 1개만 다시 — 그쪽이 끝나거나 기한(90초)이
    //   지나면 다음 시도가 인수하거나 청소 작업이 처리한다(끝이 있다). 잠금 줄이 하나도 없으면(고아) 다시 넣지 않는다 → npm run ops:force-fail
    if (q.rows[0]?.over) {
      // Z38 R8-42: "남이 쥠" = 기한 안 지난 워커 잠금만 센다. 한쪽 줄만 남은 이전(빠진 쪽 인수가 늘 실패)·reserved·기한 지난 줄은 세지 않는다 → 끝이 있다
      const locks = (await tx.query(
        `SELECT count(*)::int n FROM env_locks WHERE migration_id = $1 AND holder <> 'reserved' AND lease_expires_at > now()`,
        [job.migrationId])).rows[0].n as number;
      if (locks > 0) {
        await boss.send(QUEUES.cleanup, jobData(job),
          { singletonKey: `cleanup:${job.migrationId}`, startAfter: CLEANUP_LOCK_RETRY_SEC, db: asBossDb(tx) });
        return;
      }
      await writeAudit(tx, job.tenantId, { actor: "worker", action: "cleanup.reschedule_stopped", target: job.migrationId,
        result: "denied", detail: { requestId: job.requestId, reason: "window_over_no_live_lock_holder" } });
      return;
    }
    await boss.send(QUEUES.cleanup, jobData(job),
      { singletonKey: `cleanup:${job.migrationId}`, startAfter: wait + 1, db: asBossDb(tx) });
  });
}
