import { restoreTrafficBeforeAsking } from "./_fail-traffic.js";
import { Measurement, MigrationJob, QUEUES } from "@svc/contracts";
import { replicationFor } from "./_repl.js";
import { replicationFromEnv, toMeasurements, SwitchoverError } from "@svc/replication";
import { errorMessage, nextJob, runStep, stubWait, stubFailIfAsked, type StepOutcome } from "./_step.js";
import { appLinkHooks, appLinkMeans, cutoverAppLinkBlock, switchRuntimeWriter, appLinkMeasurements, recordActiveWriter, targetBundle } from "../app-link.js";
import { DEFAULT_ROLLBACK_WINDOW_SEC, loadLatestApproval, loadPlanById, rollbackWindowSecFor } from "@svc/core";
import { envNumber } from "@svc/contracts";
import { trafficFor, type TrafficFor } from "../platform.js";
import { appDbSwitchKind } from "./deploy.js";
import { loadReapplyInput, type RealApplyInput } from "./apply-real.js";
import { loadWriterState } from "../db-writer.js";
import { tenantSlug } from "../gitops/bundle.js";

// pf-d FM-TRF-13 (지휘 결정 11/4 00:51Z): 컷오버가 끝나 도착 DB 가 주인이면 LB fallback 도 도착으로.
//   예전엔 fallback=출발 그대로라, 도착 모니터가 한 번 깜빡이면 사용자가 울타리 친(쓰기 막힌) 출발로 갔다.
//   실패해도 컷오버는 되돌리지 않는다(DB 는 이미 바뀜) → 결과 detail.fallback 에 남기고 화면·감사가 본다. 롤백(restoreSource)이 출발로 되돌린다
//   PF TRF-21: LB 자리는 shift 와 같이 trafficFor (DB 줄 먼저, 없으면 .env)
export async function fallbackToTarget(t: Pick<TrafficFor, "lbId" | "switcher">): Promise<{ to: "target"; ok: boolean; error?: string } | undefined> {
  const { lbId, switcher: sw } = t;
  if (!sw.setFallback) return undefined;
  try { await sw.setFallback(lbId, "target"); return { to: "target", ok: true }; }
  catch (e) { return { to: "target", ok: false, error: (e as Error).message.slice(0, 200) }; }
}

// M3: 롤백 가능 창 길이는 core 한 곳에서만 정한다. F8-4: 승인한 계획서 칸 rollbackWindowSec (환경변수 ROLLBACK_WINDOW_SEC 는 개발·시험 덮어쓰기). 데모·e2e 롤백 장면은 20초
// 통합 시험은 apps/api/test/_fast-env.ts 로 짧은 값을 준다
export const ROLLBACK_WINDOW_SEC = DEFAULT_ROLLBACK_WINDOW_SEC;
// DRAFT(ai): C3 마지막 따라잡기 제한 시간. 넘기면 C6' 되돌림 → shifting
const MAX_CATCHUP_MS = envNumber(process.env.REPL_MAX_CATCHUP_MS, 10_000);
// DRAFT(ai): 컷오버 따라잡기 실패(C6' 되돌림)는 최대 3번. 3번째 실패면 failed로 보내 사람이 결정한다 (10/31 결정 기록)
export const MAX_CUTOVER_ATTEMPTS = envNumber(process.env.MAX_CUTOVER_ATTEMPTS, 3);

// DB 컷오버. cutover → rollback_window (실패하면 C6' 되돌림 뒤 cutover → shifting)
// 쓰기를 잠깐 막고(펜스) 복제가 다 따라온 걸 확인한 뒤 도착 DB를 주인으로 바꾼다
export async function handleCutover(raw: unknown) {
  const job = MigrationJob.parse(raw);
  return runStep(job, {
    name: "cutover",
    expect: "cutover",
    // 지금까지 되돌린 횟수 (감사 기록에서 센다)
    load: async (tx, job, m) => {
      const q = await tx.query(
        // Jeong 11/4 01:53Z: 사람이 "재시도"를 고른 뒤(감사 migration.failure_retry)엔 횟수를 다시 0부터 센다 (안 그러면 첫 되돌림에 또 소진)
        `SELECT count(*)::int AS n FROM audit_events WHERE target = $1 AND action = 'cutover.shifting'
            AND at > COALESCE((SELECT max(at) FROM audit_events WHERE target = $1 AND action = 'migration.failure_retry'), '-infinity')`, [job.migrationId]);
      // Z31: 컷오버 뒤 GitOps 값(database.activeWriter)을 남길 도착 묶음 위치 (gitops 설정이 없으면 null)
      // F8-4: 창 길이 = 승인한 계획서 칸
      const ap = await loadLatestApproval(tx, job.migrationId);
      const win = rollbackWindowSecFor(ap ? await loadPlanById(tx, ap.planId) : null);
      const appKind = await appDbSwitchKind(tx, m);
      // APP-22 (가): Terraform 실행 방식은 같은 입력으로 다시 apply 해서 앱 DB 주소를 바꾼다 → 승인 계획서·명세를 미리 읽어 둔다
      const runtimeInput = appKind === "terraform_runtime" ? await loadReapplyInput(tx, { id: m.id, tenantId: job.tenantId, targetEnvId: m.targetEnvId }) : null;
      return { reverts: q.rows[0].n as number, bundle: await targetBundle(tx, job.tenantId, m), win, appKind, runtimeInput };
    },
    work: async (j, m, loaded, ctx) => {
      const { reverts, bundle, win, appKind, runtimeInput } = loaded as { reverts: number; bundle: Awaited<ReturnType<typeof targetBundle>>; win: ReturnType<typeof rollbackWindowSecFor>;
        appKind: Awaited<ReturnType<typeof appDbSwitchKind>>; runtimeInput: RealApplyInput | null };
      const data = { tenantId: j.tenantId, requestId: j.requestId, migrationId: j.migrationId };
      const toWindow = (measurements: unknown[], extra: Record<string, unknown>): StepOutcome => ({
        to: "rollback_window", detail: { measurements, windowSec: win.sec, windowSource: win.source, ...extra },
        evidence: { cutoverStepsOk: true },
        // 롤백 가능 창 끝 시각. 상태 칸이 아니라 advance() 밖에서 같은 트랜잭션으로 적는다
        inTx: async (tx) => { await tx.query(
          `UPDATE migrations SET rollback_window_ends_at = now() + make_interval(secs => $2) WHERE id = $1`,
          [j.migrationId, win.sec]); },
        // DRAFT(ai): 계약 표는 "rollback_window → cleanup 때 cleanup 작업"인데, 그 전이를 일으킬 주체가 없어서
        // 창이 끝나는 시각에 cleanup 작업이 깨어나게 미리 넣는다(startAfter). cleanup 작업이 rollback_window → cleanup → completed를 한다
        // TODO(human): 정리 전에 사람 승인을 받을지 (계약 표의 "정리 승인 뒤")
        next: nextJob(QUEUES.cleanup, j, { startAfter: win.sec }),
      });

      const repl = await replicationFor(j.tenantId, j.migrationId);
      if (!repl) {
        await stubWait();
        await stubFailIfAsked(j, "cutover");
        const pause = Measurement.parse({ migrationId: j.migrationId, name: "cutover_pause_ms",
          value: 850, unit: "ms", env: "target", at: new Date().toISOString() });
        const fallback = await fallbackToTarget(await trafficFor(j.tenantId, j.migrationId));
        return toWindow([pause], { stub: true, ...(fallback ? { fallback } : {}) });
      }
      // C1~C6. Z31: hooks = 앱 DB 연결 붙잡기 프록시 (APP_LINK_URLS). 없으면 noop (앱은 출발에 그대로 → 펜스 뒤 쓰기 실패)
      // DRAFT(ai) 결정 (앱 연결 드레인 TODO(human) → AI 기본값): hold 프록시 + GitOps activeWriter 기록. docs/APP-CUTOVER.md
      // Z36: 잠금을 잃으면(ctx.signal) C5 직전에 멈춘다 → 출발 울타리를 걷고 SwitchoverError(pastNoReturn=false)
      const link = appLinkHooks(repl.cfg);
      // APP-22 (가) DECISION(team): 컷오버 = 도착 앱 DB 주소를 출발 → 도착으로. 바꿀 길(GitOps 묶음·프록시)이 없으면 울타리 치기 전에 멈춘다.
      //   그대로 진행하면 DB 주인은 도착인데 도착 앱은 울타리 친 출발에 붙어 쓰기가 전부 실패한다. 출발이 그대로 주인이라 서비스는 돈다
      //   도착 앱을 안 올린 이전(클러스터 없음·흉내)은 바꿀 앱이 없다. Terraform 실행 방식(ECS·Cloud Run·VM)은 주소가 tf 출력에 박혀 아직 못 바꾼다
      //   Terraform 실행 방식(ECS·Cloud Run·VM)은 db_writer_json 을 target 으로 바꿔 다시 apply 한다 (apply 가 남긴 출발 경로 상태가 있어야 함)
      const means = appLinkMeans();
      const runtimeReady = !!runtimeInput && !!loadWriterState(process.env, tenantSlug(j.tenantId), j.migrationId);
      const block = cutoverAppLinkBlock({ on: means.on, proxy: !!link, appKind, bundle: !!bundle, runtimeReady });
      if (block) {
        return { to: "failed", failureCode: "APP_LINK_UNAVAILABLE",
          detail: { error: block, appLink: { ...means, appKind },
                    hint: "GitOps 설정 또는 APP_LINK_URLS 를 주고 다시. 앱 연결을 손대지 않으려면 APP_LINK=0 (시험 전용)", sourceUnfenced: true } };
      }
      const r = await repl.cutover({ maxCatchupMs: MAX_CATCHUP_MS, signal: ctx.signal, hooks: link ?? undefined });
      const appLink = link?.report();
      const measurements = [...toMeasurements(r.measures, j.migrationId, "target"), ...appLinkMeasurements(appLink, j.migrationId, "target")];
      if (r.ok) {
        // 오래가는 길: 프록시가 재시작해도 도착을 보게 GitOps 값에 남긴다. 실패해도 되돌리지 않는다 (DB 는 이미 바뀜)
        // APP-22 (가): 프록시가 없어도 기본으로 기록한다 (이 커밋이 도착 앱 DB 주소를 도착으로 바꾸는 길)
        const gitopsWriter = (link || means.on) && appKind !== "terraform_runtime" ? await recordActiveWriter(bundle, "target") : undefined;
        // APP-22 (가): Terraform 실행 방식은 db_writer_json=target 으로 다시 apply. 실패해도 DB 는 되돌리지 않는다 (이미 바뀜) → 결과에 남겨 사람이 본다
        const runtimeWriter = means.on && !link && appKind === "terraform_runtime" && runtimeInput
          ? await switchRuntimeWriter(j, m, runtimeInput, "target").catch((e) => ({ ok: false as const, failureCode: "APP_LINK_REAPPLY_FAILED", error: errorMessage(e) }))
          : undefined;
        const fallback = await fallbackToTarget(await trafficFor(j.tenantId, j.migrationId));
        // PF RV-25: 앱 DB 주소를 실제로 옮겼는지 결과에 남긴다 (화면·증거가 "컷오버 됨"만 보고 앱도 옮겨졌다고 말하지 않게)
        const appDbSwitched = !!(appLink && !appLink.resumeFailed) || !!gitopsWriter?.commit || gitopsWriter?.skipped === "unchanged" || runtimeWriter?.ok === true;
        return toWindow(measurements, { replication: { pauseMs: r.pauseMs }, appDb: { switched: appDbSwitched, kind: appKind, on: means.on },
          ...(appLink ? { appLink } : {}), ...(gitopsWriter ? { gitopsWriter } : {}), ...(runtimeWriter ? { runtimeWriter } : {}), ...(fallback ? { fallback } : {}) });
      }
      // C6' 되돌림 끝남: 출발이 그대로 주인. 횟수를 다 썼으면 failed (출발 DB가 계속 주인이라 서비스는 안 멈춤)
      if (reverts + 1 >= MAX_CUTOVER_ATTEMPTS) {
        return { to: "failed", failureCode: "CUTOVER_CATCHUP_EXHAUSTED",
          detail: { measurements, revert: { reason: r.reason, detail: r.detail }, ...(appLink ? { appLink } : {}), attempts: reverts + 1 } };
      }
      // 아직 남았으면 shifting으로 돌아가 다시 관찰 → 다시 cutover
      return {
        to: "shifting", detail: { measurements, revert: { reason: r.reason, detail: r.detail }, ...(appLink ? { appLink } : {}) },
        evidence: { revertOk: true, reason: r.reason },
        next: nextJob(QUEUES.shift, j),
      };
    },
    // Z19 H2: 컷오버 도중 예외 → 재시도하지 않고 failed로 보내 사람이 본다 (cutover 큐 retryLimit 0).
    // 예전: 던지기만 해서 출발이 울타리 친 채(쓰기 금지) cutover에 멈췄다. 재시도는 C5 뒤면 "phase=idle"로 또 실패했다.
    // switchover()가 C5 전 예외면 이미 출발 울타리를 걷었다 → 서비스는 출발로 계속 돈다
    // Jeong 11/4 01:53Z: failed 로 가기 전에 트래픽부터 출발로 (출발이 DB 주인일 때만, _fail-traffic.ts)
    beforeFail: (out, job) => restoreTrafficBeforeAsking(out, job),
    onError: async (e) => {
      const msg = errorMessage(e);
      const se = e instanceof SwitchoverError ? e : null;
      const failureCode = !se ? "CUTOVER_ERROR"
        : se.pastNoReturn ? "CUTOVER_HALFWAY"              // C5 뒤: 정방향 구독 없음. 출발·도착 어느 쪽이 주인인지 사람이 확인
        : se.unfenced ? "CUTOVER_ERROR_UNFENCED"           // C5 전: 출발이 그대로 주인, 쓰기 돌려줌
        : "CUTOVER_UNFENCE_FAILED";                        // C5 전인데 울타리 걷기도 실패: 출발이 읽기 전용일 수 있다 (긴급)
      return { to: "failed", failureCode,
        detail: { error: msg, step: se?.step, pastNoReturn: se?.pastNoReturn ?? null, sourceUnfenced: se?.unfenced ?? null } };
    },
  });
}
