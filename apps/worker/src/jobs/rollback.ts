import { MigrationJob } from "@svc/contracts";
import { replicationFromEnv, toMeasurements, withClient, appCanWrite } from "@svc/replication";
import { restoreSource } from "@svc/traffic";
import { writeAudit } from "@svc/core";
import { log } from "../instrument.js";
import { cleanupAfterRollback } from "./rollback-cleanup.js";
import { errorMessage, runStep, failedAttempts, recordAttemptFailure } from "./_step.js";
import { withStepRoles } from "./_roles.js";
import { TRAFFIC_LB_ID, tempRoles, trafficMetrics, trafficSwitcher } from "../platform.js";
import { appLinkHooks, appLinkMeasurements, recordActiveWriter, targetBundle } from "../app-link.js";
import { commitTrafficWeight, configFromEnv, GitopsRepo, type BundleRef } from "../gitops/index.js";
import { envNumber } from "@svc/contracts";

// DRAFT(ai): 롤백 자체가 이 횟수만큼 실패하면 rolling_back → failed(ROLLBACK_FAILED).
// 잠금은 남는다(반쯤 되돌린 상태일 수 있음). 사람이 확인하고 POST .../cancel {manualCleanupConfirmed:true}로 끝낸다.
// 기본 2 = rollback 큐 retryLimit 1(기본값) + 첫 시도. 대안 "계속 재시도"는 버림: 화면에 rolling_back으로 영원히 남는다. TODO(human): 횟수 확정
export const ROLLBACK_MAX_ATTEMPTS = envNumber(process.env.ROLLBACK_MAX_ATTEMPTS, 2);

// 롤백. rolling_back → rolled_back
// 트래픽을 출발 쪽 100%로 되돌리고, 도착 쪽 쓰기를 막는다
export async function handleRollback(raw: unknown) {
  const job = MigrationJob.parse(raw);
  return runStep(job, {
    name: "rollback",
    expect: "rolling_back",
    // Z31: 컷오버 뒤 롤백이면 GitOps 값 database.activeWriter 를 source 로 되돌릴 묶음 위치
    // Z59-03: 같은 묶음에 weightPct 0 도 남긴다 (Z31 targetBundle 을 같이 씀)
    load: async (tx, job, m) => ({ bundle: await targetBundle(tx, job.tenantId, m) }),
    work: async (j, m, loaded, ctx) => withStepRoles("rollback", j, m, async () => {
      const { bundle } = loaded as { bundle: Awaited<ReturnType<typeof targetBundle>> };
      // 트래픽: 출발 100% 확인(shift 가 이미 긴급 되돌림을 했으면 PATCH 없이 확인만) + 출발 5xx ≤ 1%
      const traffic = await restoreSource({ switcher: trafficSwitcher(), lbId: TRAFFIC_LB_ID ?? j.migrationId,
        metrics: trafficMetrics(j.tenantId), migrationId: j.migrationId });
      // 롤백이 끝나면 이 이전의 실행 역할은 더 쓸 일이 없다 (회수 결과는 감사에 남는다)
      const roles = await tempRoles().revokeForMigration(j.tenantId, j.migrationId, "rolled_back");
      const weights = traffic.detail.after;
      // Z59: 계약 5절 "Cloudflare 를 먼저 0 → 그다음 weightPct 0 커밋". shift 긴급 되돌림은 이미 0을 남기지만
      // 컷오버 뒤·창 안 롤백, rollback_failed 재시도는 이 길만 탄다. 커밋 실패는 롤백을 막지 않는다 (detail 에만)
      const gitopsWeight = await recordZero(bundle);
      const repl = replicationFromEnv(j.migrationId);
      if (!repl) {
        return { to: "rolled_back", detail: { weights, traffic: traffic.detail, rolesRevoked: roles.revoked, stub: true, gitopsWeight },
                 evidence: traffic.evidence };
      }
      // 컷오버 전이면 정방향 복제만 걷고, 컷오버 뒤면 역방향으로 다시 전환(도착에 쓴 데이터도 출발로)
      // Z31: 컷오버 뒤면 앱 DB 연결도 붙잡았다가 출발로 풀어 준다 (같은 hold 프록시. 방향만 반대)
      const link = appLinkHooks(repl.cfg);
      // Z69: 걷기는 아래 cleanupAfterRollback이 따로 한다(teardown:false) → 걷기 실패가 롤백 실패로 번지지 않는다
      const r = await repl.rollback({ signal: ctx.signal, hooks: link ?? undefined, teardown: false });   // Z36: 잠금을 잃으면 C5 직전에 멈춤
      if (r.kind === "after_cutover" && !r.result?.ok) throw new Error(`db rollback failed: ${JSON.stringify(r.result)}`);
      const appLink = r.kind === "after_cutover" ? link?.report() : undefined;
      const gitopsWriter = appLink ? await recordActiveWriter(bundle, "source") : undefined;
      // M4: 컷오버 뒤 롤백(switchover 도착→출발)은 끝에 반대 방향 복제(출발→도착 슬롯·발행·구독)를 새로 만든다.
      // rolled_back은 끝 상태라 cleanup이 안 돈다 → 여기서 걷는다. 안 걷으면 출발 DB 슬롯이 WAL을 계속 쌓고(디스크),
      // 다음 시연에서 phase()가 forward로 보여 sync가 이상하게 돈다. 출발이 다시 주인이라 되돌릴 대상은 없다
      // Z69: 컷오버 전·뒤·noop 모두 걷고, 실패하면 경고만 (rollback-cleanup.ts 결정 참고)
      const cleanup = await cleanupAfterRollback(repl);
      const { removed, leftovers } = cleanup;
      if (!cleanup.ok) log.warn({ migration_id: j.migrationId, kind: r.kind, warning: cleanup.warning, leftovers }, "rollback: replication cleanup incomplete");
      // 출발 헬스 = 출발 DB에서 앱 계정이 다시 쓸 수 있나
      const sourceHealthy = await withClient(repl.cfg.source, (c) => appCanWrite(c, repl.cfg.source, (repl.cfg.tables?.[0]) ?? "orders"));
      return {
        to: "rolled_back",
        detail: { weights, traffic: traffic.detail, rolesRevoked: roles.revoked, gitopsWeight,
                  replication: { kind: r.kind, removed, leftovers, cleanup: cleanup.ok ? "ok" : "incomplete",
                                 ...(cleanup.warning ? { warning: cleanup.warning } : {}) },
                  measurements: [...(r.result ? toMeasurements(r.result.measures, j.migrationId, "source") : []), ...appLinkMeasurements(appLink, j.migrationId, "source")],
                  ...(appLink ? { appLink, gitopsWriter } : {}) },
        // 출발 건강 = 트래픽 지표(5xx) 와 DB(앱 계정 쓰기 가능) 둘 다
        evidence: { sourceWeight100: traffic.evidence.sourceWeight100, sourceHealthy: sourceHealthy && traffic.evidence.sourceHealthy === true },
        // 경고는 rolled_back 감사와 별도 줄로도 남긴다(화면·조회에서 result=error로 바로 보이게). 같은 트랜잭션
        ...(cleanup.ok ? {} : { inTx: async (tx) => {
          await writeAudit(tx, j.tenantId, { actor: "worker", action: "rollback.cleanup_incomplete", target: j.migrationId, result: "error",
            detail: { requestId: j.requestId, kind: r.kind, removed, leftovers, warning: cleanup.warning,
                      hint: "teardown은 여러 번 불러도 안전. 원인(권한·연결·active 슬롯) 해결 뒤 다시 걷기" } });
        } }),
      };
    }),
    onError: async (e, j) => {
      const msg = errorMessage(e);
      const attempts = (await failedAttempts(j, "rollback")) + 1;
      if (attempts >= ROLLBACK_MAX_ATTEMPTS)
        return { to: "failed", failureCode: "ROLLBACK_FAILED", detail: { error: msg, attempts } };
      await recordAttemptFailure(j, "rollback", { attempts, max: ROLLBACK_MAX_ATTEMPTS, error: msg });
      return null;
    },
  });
}

// weightPct 0 을 gitops 에 남긴다. 이미 0 이면 커밋이 안 생긴다 (commitBundle 멱등)
async function recordZero(bundle: BundleRef | null): Promise<{ commit?: string; skipped?: string; error?: string }> {
  const cfg = configFromEnv();
  if (!cfg || !bundle) return { skipped: "no_gitops" };
  try { return { commit: (await commitTrafficWeight(new GitopsRepo(cfg), bundle, 0)).commit }; }
  catch (e) { return { error: (e as Error).message.slice(0, 200) }; }
}
