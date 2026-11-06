import { MigrationJob, QUEUES } from "@svc/contracts";
import { replicationFor } from "./_repl.js";
import { ReplConfigError, toMeasurements, withClient, appCanWrite } from "@svc/replication";
import { restoreSource } from "@svc/traffic";
import { trafficLeaseState, withTenant, writeAudit } from "@svc/core";
import { log, setTrafficWeightMetric } from "../instrument.js";
import { cleanupAfterRollback } from "./rollback-cleanup.js";
import { errorMessage, runStep, failedAttempts, recordAttemptFailure, RetryLater, jobData } from "./_step.js";
import { withStepRoles } from "./_roles.js";
import { transientTrafficError, rollbackTransientDelaysSec } from "./_transient.js";
import { tempRoles, trafficFor, trafficMetrics } from "../platform.js";
import { appLinkHooks, appLinkMeasurements, appLinkOn, recordActiveWriter, switchRuntimeWriter, targetBundle } from "../app-link.js";
import { appDbSwitchKind } from "./deploy.js";
import { loadReapplyInput, type RealApplyInput } from "./apply-real.js";
import { commitReplicationCleanup, commitTrafficWeight, configFromEnv, GitopsRepo, type BundleRef } from "../gitops/index.js";
import { envNumber } from "@svc/contracts";
import { teardownRelayStep } from "../relay/relay-step.js";

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
    // APP-22 (가): Terraform 실행 방식 도착은 컷오버 뒤 롤백 때 db_writer_json=source 로 다시 apply → 승인 계획서·명세를 미리 읽는다
    load: async (tx, job, m) => {
      const appKind = await appDbSwitchKind(tx, m);
      return { bundle: await targetBundle(tx, job.tenantId, m), appKind,
               runtimeInput: appKind === "terraform_runtime" ? await loadReapplyInput(tx, { id: m.id, tenantId: job.tenantId, targetEnvId: m.targetEnvId }) : null };
    },
    // PF FM-ORC-20: 이 이전의 실행 역할 회수는 withStepRoles 가 끝난 뒤(재발급 고리가 멈춘 뒤)에 한다.
    //   예전엔 단계 안에서 회수해, 뒤의 DB 되돌림·복제 걷기가 재발급 주기를 넘기면 ROLE_RENEW_UNKNOWN → 롤백 실패·재시도로 일이 겹쳤다 (cleanup 과 같은 모양)
    work: async (j, m, loaded, ctx) => withRevokeAfter(j, await withStepRoles("rollback", j, m, async () => {
      const { bundle, appKind, runtimeInput } = loaded as { bundle: Awaited<ReturnType<typeof targetBundle>>; appKind: Awaited<ReturnType<typeof appDbSwitchKind>>; runtimeInput: RealApplyInput | null };
      // PF-E32 (RV-19) + orch RV-19 (FM-INT-12 합침): 복제 주소를 못 만들면(ReplConfigError: outputs.json 없음·빈 {tf:}) 예전엔 트래픽을 되돌리기 전에 던져 롤백이 영영 실패했다.
      //   컷오버 전이면 출발이 DB 주인이라 트래픽은 먼저 되돌리고, 복제 걷기는 못 한 채(감사 cleanup_incomplete) rolled_back.
      //   컷오버 뒤면 DB 주인이 도착일 수 있어 트래픽을 옮기지 않고 던진다 (TRF-19 와 같은 규칙). 단 지난 시도가 DB 를 이미 되돌렸으면(orch) 트래픽은 되돌린다
      let repl: Awaited<ReturnType<typeof replicationFor>>;
      let replErr: ReplConfigError | undefined;
      try { repl = await replicationFor(j.tenantId, j.migrationId); }   // FM-ORC-09: 명세에 postgres 없으면 null
      catch (e) { if (!(e instanceof ReplConfigError)) throw e; replErr = e; repl = null; }
      const replDbDone = replErr ? await dbRevertedEarlier(j) : false;
      if (replErr && !replDbDone && await passedCutover(j.tenantId, j.migrationId))
        throw new Error(`replication config error after cutover: rollback needs the replication endpoints (traffic left as is): ${replErr.message}`);
      // PF-E6 (FM-TRF-19): 컷오버 뒤(역방향 구독 = 도착이 DB 주인)면 DB 를 먼저 출발로 되돌리고 그다음 트래픽.
      //   예전 순서(트래픽 먼저)는 그 사이 사용자가 울타리 친(쓰기 막힌) 출발 DB 를 쓰는 출발 앱으로 갔고,
      //   DB 되돌리기가 실패하면 "트래픽 출발·DB 주인 도착·출발 읽기 전용"으로 멈췄다(쓰기 전부 실패).
      //   DB 먼저면 실패해도 switchover 가 C5 전 도착 울타리를 걷어 "트래픽·DB 둘 다 도착"으로 남는다(서비스는 돈다).
      //   컷오버 전·phase 를 못 읽음(도착이 안 닿음)이면 예전 순서 그대로 (출발이 주인이라 트래픽부터 돌려야 한다)
      const link = repl ? appLinkHooks(repl.cfg) : null;
      // PF-E17 (FM-TRF-hunt-traffic-ops-01): 지난 시도가 DB 를 이미 출발로 되돌린 뒤 트래픽에서 실패했으면, 이번 시도엔 phase 가 reverse 가 아니다.
      //   그 기록(rollback.db_reverted 감사)을 보고 "컷오버 뒤 롤백"으로 이어 간다 (예전: 컷오버 전 길로 빠져 GitOps activeWriter 가 target 으로 남음)
      const dbDone = repl ? await dbRevertedEarlier(j) : false;
      const phase = repl && !dbDone ? await repl.phase().catch(() => "unknown") : null;
      const dbFirst = dbDone || phase === "reverse";
      // PF TRF-19: 컷오버를 지난 이전인데 DB 방향을 못 읽으면(도착 DB 가 안 닿음) 트래픽을 출발로 보내지 않고 멈춘다.
      //   DB 주인이 도착일 수 있어, 트래픽만 출발로 가면 "앱 출발·DB 주인 도착(출발 읽기 전용)"으로 쓰기가 전부 실패한다.
      //   던지면 onError 가 재시도 → ROLLBACK_MAX_ATTEMPTS 뒤 failed(ROLLBACK_FAILED). 트래픽·DB 는 그대로(둘 다 도착)라 서비스는 돈다
      //   (FM-INT-10: PF-E17 의 "이미 되돌림" 기록이 있으면 phase 를 안 읽으므로 이 점검도 건너뛴다)
      if (repl && phase === "unknown" && await passedCutover(j.tenantId, j.migrationId))
        throw new Error("db phase unknown after cutover: traffic left on target (db first rule)");
      let r: Awaited<ReturnType<NonNullable<typeof repl>["rollback"]>> | undefined = dbDone ? { kind: "after_cutover" } : undefined;
      if (repl && dbFirst && !dbDone) {
        r = await repl.rollback({ signal: ctx.signal, hooks: link ?? undefined, teardown: false });
        if (r.kind === "after_cutover" && !r.result?.ok) throw new Error(`db rollback failed: ${JSON.stringify(r.result)}`);
        if (r.kind === "after_cutover") await withTenant(j.tenantId, (tx) => writeAudit(tx, j.tenantId, {
          actor: "worker", action: "rollback.db_reverted", target: j.migrationId, result: "ok",
          detail: { requestId: j.requestId, pauseMs: r!.result?.pauseMs } }));
      }
      // 트래픽: 출발 100% 확인(shift 가 이미 긴급 되돌림을 했으면 PATCH 없이 확인만) + 출발 5xx ≤ 1%
      // PF FM-ORC-10: LB 를 다른 이전이 쥐고 있으면(그 이전이 shift 중) 건드리지 않는다. 이 이전은 LB 를 옮긴 적이 없어 출발이 그대로다.
      //   DRAFT(ai): 이때 증거는 "이 이전 몫은 출발 100%"로 본다 (출발 5xx 확인은 LB 주인의 일). 주인 없음·내 것이면 예전처럼 출발 100% 로
      const { lbId, switcher } = await trafficFor(j.tenantId, j.migrationId);   // PF TRF-21: 이전별 LB 자리(DB) 먼저
      const lease = await withTenant(j.tenantId, (tx) => trafficLeaseState(tx, lbId, j.migrationId));
      const traffic = lease === "other"
        ? { evidence: { sourceWeight100: true, sourceHealthy: true }, detail: { skipped: "lb_owned_by_other_migration", after: null } }
        : await restoreSource({ switcher, lbId, metrics: trafficMetrics(j.tenantId), migrationId: j.migrationId });
      const weights = traffic.detail.after;
      if (lease !== "other" && traffic.evidence.sourceWeight100) setTrafficWeightMetric(j.migrationId, 0);
      // 화면 막대·GET traffic-shift 가 읽는 진행 줄도 출발로 맞춘다 (옮긴 적 없으면 줄이 없어 그대로). 표시용이라 쓰기 실패로 롤백을 멈추지 않는다
      if (lease !== "other") await withTenant(j.tenantId, (tx) => tx.query(
        `UPDATE traffic_progress SET target_pct = 0, observed_pct = 0, reached = true, reobserve = 0, observed_at = now() WHERE migration_id = $1`, [j.migrationId]))
        .catch(() => { /* 표시용 */ });
      // Z59: 계약 5절 "Cloudflare 를 먼저 0 → 그다음 weightPct 0 커밋". shift 긴급 되돌림은 이미 0을 남기지만
      // 컷오버 뒤·창 안 롤백, rollback_failed 재시도는 이 길만 탄다. 커밋 실패는 롤백을 막지 않는다 (detail 에만)
      const gitopsWeight = await recordZero(bundle);
      if (!repl && replErr && replDbDone) {
        // (orch RV-19) 컷오버 뒤 DB 는 지난 시도가 이미 출발로 되돌렸고 트래픽도 지금 출발로 되돌렸다.
        //   GitOps activeWriter·복제 걷기는 복제 설정(작업 폴더 outputs·REPL_*)을 고친 뒤 재시도가 한다
        await withTenant(j.tenantId, (tx) => writeAudit(tx, j.tenantId, { actor: "worker", action: "rollback.traffic_restored", target: j.migrationId,
          result: "ok", detail: { requestId: j.requestId, weights, replicationError: replErr.message.slice(0, 300) } }));
        throw replErr;
      }
      if (!repl && replErr) {
        const warning = replErr.message.slice(0, 500);
        await withTenant(j.tenantId, (tx) => writeAudit(tx, j.tenantId, { actor: "worker", action: "rollback.traffic_restored", target: j.migrationId,
          result: "ok", detail: { requestId: j.requestId, weights, replicationError: replErr.message.slice(0, 300) } }));   // orch RV-19 기록 (FM-INT-12)
        return { to: "rolled_back", detail: { weights, traffic: traffic.detail, gitopsWeight, replication: { kind: "before_cutover", cleanup: "incomplete", code: replErr.code, warning } },
                 evidence: traffic.evidence,
                 inTx: async (tx) => { await writeAudit(tx, j.tenantId, { actor: "worker", action: "rollback.cleanup_incomplete", target: j.migrationId, result: "error",
                   detail: { requestId: j.requestId, kind: "before_cutover", code: replErr.code, warning, hint: "복제 주소(끝점 줄·TF_WORK_DIR outputs·REPL_FACTS_FILES)를 고친 뒤 repl-cleanup 으로 출발 슬롯을 걷는다" } }); } };
      }
      if (!repl) {
        return { to: "rolled_back", detail: { weights, traffic: traffic.detail, stub: true, gitopsWeight },
                 evidence: traffic.evidence };
      }
      // 컷오버 전이면 정방향 복제만 걷고, 컷오버 뒤면 역방향으로 다시 전환(도착에 쓴 데이터도 출발로)
      // Z31: 컷오버 뒤면 앱 DB 연결도 붙잡았다가 출발로 풀어 준다 (같은 hold 프록시. 방향만 반대)
      // Z69: 걷기는 아래 cleanupAfterRollback이 따로 한다(teardown:false) → 걷기 실패가 롤백 실패로 번지지 않는다
      if (!r) {
        r = await repl.rollback({ signal: ctx.signal, hooks: link ?? undefined, teardown: false });   // Z36: 잠금을 잃으면 C5 직전에 멈춤
        if (r.kind === "after_cutover" && !r.result?.ok) throw new Error(`db rollback failed: ${JSON.stringify(r.result)}`);
      }
      const appLink = r.kind === "after_cutover" ? link?.report() : undefined;
      // APP-22 (가) DECISION(team): 컷오버 뒤 롤백이면 도착 앱 DB 주소도 출발로 되돌린다 (프록시가 없어도 기본으로)
      const gitopsWriter = r.kind === "after_cutover" && (appLink || appLinkOn()) && appKind !== "terraform_runtime" ? await recordActiveWriter(bundle, "source") : undefined;
      // Terraform 실행 방식: db_writer_json=source 로 다시 apply (도착 앱이 출발 DB 로). 실패해도 롤백은 이어 간다 (DB 는 이미 출발이 주인) → 결과에 남김
      const runtimeWriter = r.kind === "after_cutover" && !link && appLinkOn() && appKind === "terraform_runtime" && runtimeInput
        ? await switchRuntimeWriter(j, m, runtimeInput, "source").catch((e) => ({ ok: false as const, failureCode: "APP_LINK_REAPPLY_FAILED", error: (e as Error).message.slice(0, 200) }))
        : undefined;
      // M4: 컷오버 뒤 롤백(switchover 도착→출발)은 끝에 반대 방향 복제(출발→도착 슬롯·발행·구독)를 새로 만든다.
      // rolled_back은 끝 상태라 cleanup이 안 돈다 → 여기서 걷는다. 안 걷으면 출발 DB 슬롯이 WAL을 계속 쌓고(디스크),
      // 다음 시연에서 phase()가 forward로 보여 sync가 이상하게 돈다. 출발이 다시 주인이라 되돌릴 대상은 없다
      // Z69: 컷오버 전·뒤·noop 모두 걷고, 실패하면 경고만 (rollback-cleanup.ts 결정 참고)
      const cleanup = await cleanupAfterRollback(repl);
      const { removed, leftovers } = cleanup;
      // 출발 헬스 = 출발 DB에서 앱 계정이 다시 쓸 수 있나. 중계기를 지우기 전에 본다:
      //   AWS→온프레 이전은 워커가 출발 DB 에 중계기(공인 IP:15432)로만 닿는다. 예전엔 중계기를 지운 뒤 같은 주소로 붙어
      //   timeout expired → 재시도 때는 중계기가 없어 복제 걷기·헬스 모두 실패 → ROLLBACK_FAILED (2026-11-06 실제 플랫폼에서 확인)
      const sourceHealthy = await withClient(repl.cfg.source, (c) => appCanWrite(c, repl.cfg.source, (repl.cfg.tables?.[0]) ?? "orders"));
      // 온프레 CNPG 이전: 걷기가 다 끝났을 때만 gitops 에서 이전 역할(ensure absent)·터널을 걷는다. 실패해도 롤백은 이어 간다 (detail 에만)
      //   덜 걷었으면 터널을 남긴다: repl-cleanup 이 같은 터널로 다시 걷고 그때 이 커밋을 한다
      const gitopsReplication = cleanup.ok ? await commitReplicationCleanup(bundle) : { skipped: "replication_leftovers" };
      // 출발 계정 중계기: 걷기와 터널 정리 커밋이 끝났을 때만 지운다. 실패해도 롤백은 rolled_back (걷기 실패와 같은 규칙, Z69) → 경고 감사 + repl-cleanup 으로 다시
      const relay = cleanup.ok ? await teardownRelayStep(j, m) : { kind: "skipped" as const, reason: "replication_leftovers" };
      if (relay.kind === "failed") log.warn({ migration_id: j.migrationId, code: relay.failureCode, reason: relay.reason }, "rollback: relay teardown incomplete");
      if (!cleanup.ok) log.warn({ migration_id: j.migrationId, kind: r.kind, warning: cleanup.warning, leftovers }, "rollback: replication cleanup incomplete");
      return {
        to: "rolled_back",
        detail: { weights, traffic: traffic.detail, gitopsWeight, gitopsReplication,
                  relay: relay.kind === "ok" ? relay.detail : relay.kind === "skipped" ? { skipped: relay.reason } : { failed: relay.failureCode, error: relay.reason },
                  replication: { kind: r.kind, order: dbFirst ? "db_then_traffic" : "traffic_then_db", removed, leftovers, cleanup: cleanup.ok ? "ok" : "incomplete",
                                 ...(cleanup.warning ? { warning: cleanup.warning } : {}) },
                  measurements: [...(r.result ? toMeasurements(r.result.measures, j.migrationId, "source") : []), ...appLinkMeasurements(appLink, j.migrationId, "source")],
                  ...(appLink ? { appLink } : {}), ...(gitopsWriter ? { gitopsWriter } : {}), ...(runtimeWriter ? { runtimeWriter } : {}) },
        // 출발 건강 = 트래픽 지표(5xx) 와 DB(앱 계정 쓰기 가능) 둘 다
        evidence: { sourceWeight100: traffic.evidence.sourceWeight100, sourceHealthy: sourceHealthy && traffic.evidence.sourceHealthy === true },
        // 경고는 rolled_back 감사와 별도 줄로도 남긴다(화면·조회에서 result=error로 바로 보이게). 같은 트랜잭션
        ...(cleanup.ok && relay.kind !== "failed" ? {} : { inTx: async (tx) => {
          if (!cleanup.ok) await writeAudit(tx, j.tenantId, { actor: "worker", action: "rollback.cleanup_incomplete", target: j.migrationId, result: "error",
            detail: { requestId: j.requestId, kind: r.kind, removed, leftovers, warning: cleanup.warning,
                      hint: "teardown은 여러 번 불러도 안전. 원인(권한·연결·active 슬롯) 해결 뒤 다시 걷기" } });
          if (relay.kind === "failed") await writeAudit(tx, j.tenantId, { actor: "worker", action: "rollback.relay_cleanup_incomplete", target: j.migrationId, result: "error",
            detail: { requestId: j.requestId, code: relay.failureCode, warning: relay.reason.slice(0, 500), ...(relay.detail ?? {}),
                      hint: "출발 계정 중계기(태그 managed-by=platform, svc:migration=<이전>)가 남았다. 원인을 고친 뒤 repl-cleanup 으로 다시 지운다" } });
        } }),
      };
    })),
    onError: async (e, j) => {
      const msg = errorMessage(e);
      // PF FM-ORC-13: Cloudflare 429(5분 차단)·네트워크 끊김·5xx 는 기다리면 풀린다. 예전엔 5초 뒤 1번만 더 하고 failed(ROLLBACK_FAILED) →
      //   트래픽이 도착에 남은 채 사람이 다시 눌러야 했다(안전망이 몇 초 만에 포기). 이제 늘어나는 대기로 다시 넣고, 횟수에 안 센다
      const transient = transientTrafficError(e);
      if (transient) {
        const n = await transientRetries(j);
        const delays = rollbackTransientDelaysSec();
        if (n < delays.length)
          throw new RetryLater(QUEUES.rollback, jobData(j), delays[n]!, { error: msg, transient, retry: n + 1, max: delays.length });
      }
      const attempts = (await failedAttempts(j, "rollback")) + 1;
      if (attempts >= ROLLBACK_MAX_ATTEMPTS)
        return { to: "failed", failureCode: "ROLLBACK_FAILED", detail: { error: msg, attempts } };
      await recordAttemptFailure(j, "rollback", { attempts, max: ROLLBACK_MAX_ATTEMPTS, error: msg });
      return null;
    },
  });
}

/** 이번 롤백(rolling_back 에 들어온 뒤) 일시 오류로 다시 넣은 횟수 */
async function transientRetries(j: { tenantId: string; migrationId: string }): Promise<number> {
  return withTenant(j.tenantId, async (tx) => (await tx.query(
    `SELECT count(*)::int AS n FROM audit_events WHERE target = $1 AND action = 'rollback.retry_scheduled' AND detail ? 'transient'
        AND at >= (SELECT updated_at FROM migrations WHERE id = $1)`, [j.migrationId])).rows[0].n as number);
}

/** PF-E17: 이번 롤백(rolling_back 에 들어온 뒤)에서 DB 되돌리기가 이미 끝났나 */
async function dbRevertedEarlier(j: { tenantId: string; migrationId: string }): Promise<boolean> {
  return withTenant(j.tenantId, async (tx) => (await tx.query(
    // PF-E33 (RV-21): 예전엔 migrations.updated_at 뒤 감사만 봐서 "다시 롤백"(rolling_back→failed→rolling_back)이 기록을 잃었다.
    //   rolled_back 은 끝 상태라 한 이전에서 DB 되돌림은 한 번뿐 → 이 이전의 기록이 하나라도 있으면 됐다
    `SELECT 1 FROM audit_events WHERE target = $1 AND action = 'rollback.db_reverted' LIMIT 1`, [j.migrationId])).rowCount === 1);
}

// 롤백이 끝나면 이 이전의 실행 역할은 더 쓸 일이 없다 (회수 결과는 감사에 남는다). PF FM-ORC-20: 단계 역할을 다 쓴 뒤에 부른다
async function withRevokeAfter<T extends { detail?: Record<string, unknown> }>(j: MigrationJob, out: T): Promise<T> {
  const roles = await tempRoles().revokeForMigration(j.tenantId, j.migrationId, "rolled_back");
  return { ...out, detail: { ...(out.detail ?? {}), rolesRevoked: roles.revoked } };
}

// 컷오버(C1~C6)를 끝내고 rollback_window 로 간 적이 있나 (감사 전이 줄)
async function passedCutover(tenantId: string, migrationId: string): Promise<boolean> {
  return withTenant(tenantId, async (tx) => ((await tx.query(
    `SELECT 1 FROM audit_events WHERE target = $1 AND detail->>'from' = 'cutover' AND detail->>'to' = 'rollback_window' LIMIT 1`, [migrationId])).rowCount ?? 0) > 0);
}

// weightPct 0 을 gitops 에 남긴다. 이미 0 이면 커밋이 안 생긴다 (commitBundle 멱등)
async function recordZero(bundle: BundleRef | null): Promise<{ commit?: string; skipped?: string; error?: string }> {
  const cfg = configFromEnv();
  if (!cfg || !bundle) return { skipped: "no_gitops" };
  try { return { commit: (await commitTrafficWeight(new GitopsRepo(cfg), bundle, 0)).commit }; }
  catch (e) { return { error: (e as Error).message.slice(0, 200) }; }
}
