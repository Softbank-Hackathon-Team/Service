import { TrafficJudgement } from "@svc/contracts";
import { makeDecider, type RuleOpts } from "./rule.js";
import type { MetricsSource } from "./metrics.js";
import { pctWeights, setAndVerify, SwitchFailed, type TrafficSwitcher } from "./switcher.js";

// DRAFT(ai): 10 → 50 → 100%. 단계는 시간이 아니라 "정상 판정 3번"이 쌓여야 넘어간다 (설계 v1)
export const DEFAULT_STEPS = [10, 50, 100];
export const OK_JUDGEMENTS_PER_STEP = 3;
// TODO(human): 단계별 최소 유지 시간, 100% 뒤 관찰 30초를 판정 몇 번으로 볼지, 자동 롤백 뒤 재시도 대기 시간
export const OBSERVE_AFTER_100 = 30;
// 판정 간격. 판정 1번 = 1초 → 100% 뒤 정상 30번 ≈ 관찰 30초 (전이 조건 T22 observedSec ≥ 30)
export const TICK_MS = 1000;
// Z19 H5 DRAFT(ai): 지표(Prometheus 등)를 이 횟수만큼 연속으로 못 읽으면 판단할 수 없으니 출발 100%로 되돌린다.
// 판정 1번 = 1초라 약 5초. 대안 "작업을 던져 재시도" 는 버림: 그동안 가중치가 10~50%인 채 판단 주체가 없다
export const MAX_METRIC_ERRORS = 5;
// z75-38: 실측 도착 몫(지표 창의 도착 요청 수 / 전체)이 목표 ±이 값 안이어야 다음 단계로 간다 (cf:check 판정과 같은 ±10%p)
export const SHARE_TOL_PCT = 10;
// z75-38: 다른 조건은 다 찼는데 실측 몫이 목표에 못 미치면 같은 길이로 이만큼 더 본다. 그래도 못 미치면 paused (가중치 그대로)
export const MAX_REOBSERVE = 2;

/** z75-38: 단계 진행 상황 (화면 "목표 / 실측" 두 칸). 지표 창을 읽을 때마다 부른다 */
export interface ShiftProgress {
  stepPct: number; observedPct: number | null; reached: boolean | null; reobserve: number;
  stepStartedAt: string; at: string;
}
/** 지표 창 하나의 실측 도착 몫(0~100, 정수). 표본이 없으면 null */
export function observedTargetPct(w: { target: { n: number }; source: { n: number } }): number | null {
  const total = w.target.n + w.source.n;
  return total > 0 ? Math.round((w.target.n / total) * 100) : null;
}

/** pf-d RV-11: 전환 도중 플랫폼 쪽(우리 DB 등) 오류가 여러 번 이어짐. 출발 100% 로 되돌린 뒤 paused 로 끝낸다 */
export const TRAFFIC_PLATFORM_ERROR = "TRAFFIC_PLATFORM_ERROR";
// DRAFT(ai) pf-d RV-11: guardSet(상태 확인 트랜잭션)이 플랫폼 오류로 실패하면 한 번 더 해 본다. 그래도면 되돌림
export const GUARD_ATTEMPTS = 2;

/** Z19 H3: 가중치를 바꾸기 직전 "아직 이 이전이 shifting인가" 를 확인했더니 아니었다 (롤백·일시정지가 먼저 확정됨) */
export class MigrationMoved extends Error {
  readonly code = "MIGRATION_MOVED";
  constructor(readonly status: string | undefined) { super(`migration moved to ${status ?? "(gone)"}`); }
}

// M7: 관찰 시간은 판정 횟수가 아니라 시계(now)로 잰다. 100%에서 "정상 판정 30번" 그리고 "시계로 observeSec 초"를 둘 다 채워야 끝난다.
// 예전엔 판정 1번 = 1초로 셌는데, 워커는 가짜 지표일 때 20ms마다 판정해서 0.6초 관찰이 감사에 30초로 남았다

export type Judgement = TrafficJudgement;
export type ShiftOutcome =
  | "reached_100"       // 100% + 관찰 끝 → cutover
  | "rolled_back"       // 지표가 나빠 출발 100%로 되돌림 (긴급 PATCH 성공) → rolling_back
  | "rollback_failed"   // 되돌리기 PATCH 도 실패 → rolling_back (rollback 작업이 다시 시도)
  | "paused";           // 가드레일 등으로 멈춤. 가중치는 그대로 → paused
export interface ShiftResult {
  outcome: ShiftOutcome;
  judgements: Judgement[];
  rollbackReason: string | null;
  failureCode: string | null;        // 상태 머신 failureCode 후보 (TRAFFIC_*)
  reachedPct: number;                // 마지막으로 확인된 도착 비율
  observedSecAt100: number;          // 100% 도달부터 끝날 때까지 시계로 잰 초 (0.1초 단위)
  // z75-38: 실측 몫 확인을 켰을 때만. 단계마다 마지막 실측 몫, 처음 목표 안에 든 초(못 들면 null), 재관찰 횟수
  stepShares?: Array<{ stepPct: number; observedPct: number | null; reachedAfterSec: number | null; reobserve: number }>;
  observeRequiredSec: number;        // 이번 전환이 요구한 관찰 초 (기본 30, 압축 데모면 더 짧다)
  // pf-d FM-TRF-10: 판정·몫에 쓴 지표 출처. "stub" 이면 stepShares 의 observedPct 는 가중치로 계산한 값 (실측 아님)
  metricsSource: "prometheus" | "stub" | "unknown";
  latencyUnmeasured?: true;          // 도착 응답 시간을 못 잰 판정이 있었다 → 오류율로만 판정한 전환
  finalWeights: { source: number; target: number };
}

// 전환 한 번. shift 큐 처리기가 부른다. 시계와 대기는 주입한다 (시험에서 즉시 돌게)
export async function runShift(o: {
  migrationId: string; lbId: string;
  switcher: TrafficSwitcher; metrics: MetricsSource;
  steps?: number[]; rule?: Partial<RuleOpts>;
  // 일시정지에서 다시 시작할 때: 지금 도착 비율. 이보다 작은 단계는 건너뛴다 (10%로 다시 내리지 않는다)
  resumeFromPct?: number;
  now?: () => Date; sleep?: (ms: number) => Promise<void>;
  onWeight?: (targetPct: number) => void | Promise<void>;
  onJudgement?: (j: Judgement) => void | Promise<void>;
  // 판정마다 부른다. true 면 가중치를 그대로 두고 멈춘다 (가드레일, 사람의 일시정지)
  shouldPause?: () => boolean | Promise<boolean>;
  maxTicksPerStep?: number;
  switchAttempts?: number;
  // Z19 H3: 도착 쪽으로 가중치를 올리는 PATCH 를 감싼다. 워커는 "이전 행 FOR SHARE + 상태 확인" 트랜잭션 안에서 apply() 를 부르고,
  // 상태가 바뀌었으면 MigrationMoved 를 던진다 → 가중치를 안 바꾸고 paused 로 끝낸다. 출발 100% 로 되돌리는 PATCH 는 감싸지 않는다(늘 안전)
  // pf-d RV-11: apply 는 PATCH 한 번이다(확인 GET·재시도 대기는 밖). 다른 오류(플랫폼 DB)를 던지면 GUARD_ATTEMPTS 번 뒤 출발 100% + paused
  guardSet?: (apply: () => Promise<void>) => Promise<void>;
  maxMetricErrors?: number;
  observeSec?: number;               // 100%에서 시계로 관찰할 초. 기본 OBSERVE_AFTER_100
  // z75-38: 켜면 단계마다 "판정 수 + 최소 관찰 시간(stepObserveSec) + 실측 몫이 목표 ±shareTolPct" 를 다 채워야 넘어간다.
  //   몫이 못 미치면 같은 길이로 최대 MAX_REOBSERVE 번 더 보고, 그래도면 paused (TRAFFIC_SHARE_NOT_REACHED). 끄면(기본) 예전 그대로
  shareTolPct?: number;
  stepObserveSec?: number;           // 10%·50% 단계의 최소 관찰 초 (100% 는 observeSec). 기본 0
  onProgress?: (p: ShiftProgress) => void | Promise<void>;
}): Promise<ShiftResult> {
  const now = o.now ?? (() => new Date());
  const sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const from = o.resumeFromPct ?? 0;
  const steps = (o.steps ?? DEFAULT_STEPS).filter((p) => p >= from);
  if (steps.length === 0 || steps[steps.length - 1] !== 100) throw new Error("단계는 100으로 끝나야 한다");
  const decide = makeDecider(o.rule);
  const judgements: Judgement[] = [];
  const observeSec = o.observeSec ?? OBSERVE_AFTER_100;
  let reachedPct = from, observedSecAt100 = 0, t100: number | null = null;
  const elapsed100 = () => (t100 === null ? 0 : Math.round((now().getTime() - t100) / 100) / 10);
  const verify = { attempts: o.switchAttempts ?? 3, sleep };
  const maxMetricErrors = o.maxMetricErrors ?? MAX_METRIC_ERRORS;
  let metricErrors = 0, platformErrors = 0;
  const shareOn = o.shareTolPct !== undefined;
  const stepShares: NonNullable<ShiftResult["stepShares"]> = [];

  // Z14-06: LB 설정 점검 (cloudflarePreflight 가 있었지만 아무도 부르지 않았다)
  // 문제가 있으면 가중치를 건드리지 않고 paused (지금 가중치 그대로). 사람이 LB 를 고치고 재개한다
  // pf-d FM-TRF-17: 재개(from>0)에도 점검한다. 예전엔 처음만 봐서, 멈춘 사이 LB 가 꺼지거나 쿠키 고정이 켜지면 그대로 50→100 을 올렸다
  if (o.switcher.preflight) {
    let issues: string[];
    try { issues = await o.switcher.preflight(o.lbId); }
    catch (e) { return done("paused", `LB 점검 실패: ${(e as Error).message}`, "TRAFFIC_PREFLIGHT_FAILED"); }
    if (issues.length > 0) return done("paused", `LB 설정이 전환 조건에 안 맞음: ${issues.join(",")}`, "TRAFFIC_LB_MISCONFIGURED");
  }

  for (const pct of steps) {
    try {
      if (pct !== reachedPct || from === 0) {
        for (let g = 1; ; g++) {
          try { await setAndVerify(o.switcher, o.lbId, pctWeights(pct), { ...verify, ...(o.guardSet ? { guard: o.guardSet } : {}) }); break; }
          catch (e) {
            if (e instanceof MigrationMoved || e instanceof SwitchFailed || g >= GUARD_ATTEMPTS) throw e;
            await sleep(TICK_MS);
          }
        }
      }
    } catch (e) {
      if (e instanceof MigrationMoved) return done("paused", null, null);
      if (e instanceof SwitchFailed) return rollback(`단계 ${pct}% 가중치 전환 실패: ${e.message}`, "TRAFFIC_SWITCH_FAILED");
      // pf-d RV-11: 예전엔 그대로 던져 작업이 죽고 가중치가 10~50% 인 채 판단 주체가 없었다(재시도는 5초 뒤, 그 사이 지표 안 봄).
      //   이제 출발 100% 로 되돌린 뒤 paused. 재개하면 LB 의 지금 값(출발 100%)부터 다시 오른다. DB 가 아직 죽어 상태를 못 옮기면 작업 재시도·죽은 작업 처리가 paused 로 옮긴다
      return platformFail(`단계 ${pct}% 플랫폼 오류: ${(e as Error).message}`);
    }
    reachedPct = pct;
    await o.onWeight?.(pct);
    if (pct === 100) t100 = now().getTime();
    const baseNeed = pct === 100 ? OBSERVE_AFTER_100 : OK_JUDGEMENTS_PER_STEP;
    let need = baseNeed;
    let okCount = 0;
    // z75-38 실측 몫: 단계 시작 시각, 최소 관찰 초, 마지막 실측, 재관찰 수
    const tStep = now().getTime();
    const stepSec = () => Math.round((now().getTime() - tStep) / 100) / 10;
    const baseMinSec = shareOn ? (pct === 100 ? observeSec : (o.stepObserveSec ?? 0)) : 0;
    let minSec = baseMinSec;
    let lastObserved: number | null = null, reachedAfterSec: number | null = null, reobserve = 0;
    const shareOk = () => lastObserved !== null && Math.abs(lastObserved - pct) <= o.shareTolPct!;
    const stepDone = () => okCount >= need && (pct !== 100 || elapsed100() >= observeSec) && stepSec() >= minSec;
    for (let tick = 0; ; tick++) {
      if (stepDone()) {
        if (!shareOn || shareOk()) break;
        if (reobserve >= MAX_REOBSERVE) {
          stepShares.push({ stepPct: pct, observedPct: lastObserved, reachedAfterSec, reobserve });
          return done("paused", `단계 ${pct}% 실측 도착 몫 ${lastObserved ?? "없음"}% 가 목표 ±${o.shareTolPct}%p 밖 (재관찰 ${reobserve}번 뒤)`, "TRAFFIC_SHARE_NOT_REACHED");
        }
        // 같은 길이로 한 번 더 본다: 판정 수와 최소 관찰 초를 한 묶음만큼 늘린다
        reobserve++;
        need += baseNeed;
        minSec += baseMinSec;
      }
      // 판정이 모자란 채로 너무 오래 돌면 되돌린다. 판정은 다 찼고 시계만 기다리는 중이면 세지 않는다
      if (okCount < need && tick >= (o.maxTicksPerStep ?? 600)) return rollback(`단계 ${pct}% 판정 부족 (표본 모자람)`, "TRAFFIC_INSUFFICIENT_SAMPLES");
      // pf-d RV-11: 상태 읽기(플랫폼 DB) 실패는 지표 실패처럼 보류 한 번으로 센다. 연속 maxMetricErrors 번이면 출발 100% + paused
      let pause = false;
      try { pause = (await o.shouldPause?.()) === true; platformErrors = 0; }
      catch (e) {
        if (++platformErrors >= maxMetricErrors) return platformFail(`상태 확인 ${platformErrors}번 연속 실패 @${pct}%: ${(e as Error).message}`);
        // 상태를 확인 못 한 틱은 판정에 안 넣는다 (그 사이 사람이 멈췄을 수도 있으니 다음 단계로 가지 않음)
        await sleep(TICK_MS);
        continue;
      }
      if (pause) return done("paused", null, null);
      await sleep(TICK_MS);
      // Z19 H5: 예전엔 예외가 그대로 작업 밖으로 나가 가중치가 10~50%인 채 판단 주체가 사라졌다.
      // 이제 실패는 "보류" 한 번으로 세고(판정 수에 안 들어감), 연속 maxMetricErrors 번이면 긴급 롤백한다
      let w: Awaited<ReturnType<MetricsSource["window"]>>;
      try { w = await o.metrics.window(o.migrationId, pct); metricErrors = 0; }
      catch (e) {
        if (++metricErrors >= maxMetricErrors)
          return rollback(`지표 조회 ${metricErrors}번 연속 실패 @${pct}%: ${(e as Error).message}`, "TRAFFIC_METRICS_UNAVAILABLE");
        continue;
      }
      const d = decide(w);
      const verdict = d.rollback ? (d.reason === "error_rate_hard" ? "bad_shortcut" : "bad")
        : d.hit || d.reason === "insufficient_samples" ? "hold" : "ok";
      const j = TrafficJudgement.parse({
        migrationId: o.migrationId, stepPct: pct, samples: w.target.n, target5xx: w.target.err5xx,
        targetErrorRatePct: +(d.targetRatio * 100).toFixed(3), sourceErrorRatePct: +(d.sourceRatio * 100).toFixed(3),
        // 표본 0 이면 p95 가 NaN → 계약(z.number)이 NaN 을 거부해서 0 으로 적는다. samples 로 구분한다
        targetP95Ms: fin(d.targetP95Ms), sourceP95Ms: fin(d.refP95Ms), verdict, at: now().toISOString(),
        // 표본이 있는데 p95 가 없으면 0ms 가 정상으로 읽히지 않게 표시한다
        ...(w.target.n > 0 && !d.latencyMeasured ? { latencyMeasured: false } : {}),
      });
      judgements.push(j);
      await o.onJudgement?.(j);
      if (shareOn) {
        lastObserved = observedTargetPct(w);
        if (reachedAfterSec === null && shareOk()) reachedAfterSec = stepSec();
        await o.onProgress?.({ stepPct: pct, observedPct: lastObserved, reached: lastObserved === null ? null : shareOk(), reobserve,
          stepStartedAt: new Date(tStep).toISOString(), at: now().toISOString() });
      }
      if (d.rollback) return rollback(`${d.reason} @${pct}%`, d.reason === "latency" ? "TRAFFIC_LATENCY" : "TRAFFIC_ERROR_RATE");
      if (verdict === "ok") okCount++;
    }
    if (shareOn) stepShares.push({ stepPct: pct, observedPct: lastObserved, reachedAfterSec, reobserve });
  }
  observedSecAt100 = elapsed100();
  return done("reached_100", null, null);

  async function done(outcome: ShiftOutcome, reason: string | null, code: string | null): Promise<ShiftResult> {
    let finalWeights = pctWeights(reachedPct);
    try { finalWeights = await o.switcher.get(o.lbId); } catch { /* 읽기 실패면 마지막으로 확인된 값 */ }
    return { outcome, judgements, rollbackReason: reason, failureCode: code, reachedPct, observedSecAt100, observeRequiredSec: observeSec, finalWeights,
             metricsSource: o.metrics.source ?? "unknown", ...(shareOn ? { stepShares } : {}),
             ...(judgements.some((j) => j.latencyMeasured === false) ? { latencyUnmeasured: true } : {}) };
  }

  // pf-d RV-11: 플랫폼 오류 → 출발 100% (가드 없이, 늘 안전) 뒤 paused. 되돌리기도 실패하면 rollback_failed (rollback 작업이 다시 시도)
  async function platformFail(reason: string): Promise<ShiftResult> {
    try {
      await setAndVerify(o.switcher, o.lbId, { source: 1, target: 0 }, verify);
      reachedPct = 0;
      await o.onWeight?.(0);
      return done("paused", `${reason} → 출발 100% 로 되돌림`, TRAFFIC_PLATFORM_ERROR);
    } catch (e) {
      return done("rollback_failed", `${reason} / 되돌리기 실패: ${(e as Error).message}`, TRAFFIC_PLATFORM_ERROR);
    }
  }

  // 긴급 롤백 = PATCH(출발 100%) + GET 확인. 실패해도 던지지 않고 rollback_failed 로 알린다 → rollback 작업이 다시 시도
  async function rollback(reason: string, code: string): Promise<ShiftResult> {
    try {
      await setAndVerify(o.switcher, o.lbId, { source: 1, target: 0 }, verify);
      reachedPct = 0;
      await o.onWeight?.(0);
      return done("rolled_back", reason, code);
    } catch (e) {
      return done("rollback_failed", `${reason} / 되돌리기 실패: ${(e as Error).message}`, code);
    }
  }
}

const fin = (x: number) => (Number.isFinite(x) ? x : 0);
