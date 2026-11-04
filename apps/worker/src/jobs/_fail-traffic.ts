// Jeong 결정 11/4 01:53Z: 실패하면 사람에게 묻기 전에 트래픽부터 출발로 되돌린다 (답을 기다리는 동안 서비스가 도착에 묶여 있지 않게).
//   failed 로 가는 단계 중 트래픽이 옮겨져 있을 수 있는 곳은 cutover 뿐이다 (shifting 은 지표 나쁨 → 긴급 되돌림 뒤 rolling_back,
//   플랫폼 오류 → 출발 100% 뒤 paused(pf-d RV-11). rolling_back 실패는 롤백 작업이 이미 트래픽을 먼저 다룬다).
//   순서: 이 함수(트래픽) → finish 의 advance(failed, analyze) = AI 원인 분석 → 화면 질문(POST .../failure-decision)
import type { StepOutcome, StepJob } from "./_step.js";
import { restoreTrafficToSource, TrafficRestoreFailed, type TrafficRestoreResult } from "../traffic-restore.js";

// DRAFT(ai): 출발이 DB 주인임을 아는 실패만 트래픽을 출발로 보낸다 (TRF-19 "DB 먼저" 규칙과 같은 뜻).
//   CUTOVER_ERROR_UNFENCED = C5 전, 출발 울타리 걷음 / CUTOVER_CATCHUP_EXHAUSTED = C6' 되돌림 뒤 출발이 주인.
//   CUTOVER_HALFWAY(C5 뒤)·CUTOVER_UNFENCE_FAILED(출발 읽기 전용일 수 있음)·CUTOVER_ERROR(어디서 났는지 모름)는 DB 주인을 몰라
//   트래픽을 안 옮긴다: 출발로만 보내면 "앱 출발·DB 주인 도착"으로 쓰기가 전부 실패한다. 거절 → 롤백 작업이 DB 먼저 순서로 처리
export const SOURCE_OWNS_DB_ON_FAIL: ReadonlySet<string> = new Set(["CUTOVER_ERROR_UNFENCED", "CUTOVER_CATCHUP_EXHAUSTED"]);

export type Restore = (tenantId: string, migrationId: string, o?: { reason?: string }) => Promise<TrafficRestoreResult>;

export async function restoreTrafficBeforeAsking(out: StepOutcome, job: StepJob, restore: Restore = restoreTrafficToSource): Promise<StepOutcome> {
  if (out.to !== "failed") return out;
  const code = String(out.failureCode ?? "");
  if (!SOURCE_OWNS_DB_ON_FAIL.has(code))
    return { ...out, detail: { ...(out.detail ?? {}), trafficRestore: { skipped: "db_owner_unknown", rule: "db first (TRF-19)" } } };
  try {
    const r = await restore(job.tenantId, job.migrationId, { reason: code });
    return { ...out, detail: { ...(out.detail ?? {}), trafficRestore: r } };
  } catch (e) {
    // DRAFT(ai) (D 문의): 되돌리기가 끝내 실패해도 cutover 에는 paused 길이 없어 failed 로 간다. 실패 코드를 TRAFFIC_RESTORE_FAILED 로 바꿔
    //   화면·AI 분석·알림이 "트래픽이 아직 도착"을 가장 먼저 보이게 한다 (원래 코드는 detail.originalFailureCode).
    //   사람이 롤백을 고르면 롤백 작업이 트래픽 되돌리기를 다시 한다. 재시도를 골라도 막지 않는다(컷오버가 다시 트래픽 100% 도착 전제)
    const msg = (e as Error)?.message?.slice(0, 500) ?? String(e);
    return { ...out, failureCode: "TRAFFIC_RESTORE_FAILED",
             detail: { ...(out.detail ?? {}), originalFailureCode: code,
                       trafficRestore: { ok: false, error: msg, attempts: e instanceof TrafficRestoreFailed ? e.attempts : null } } };
  }
}
