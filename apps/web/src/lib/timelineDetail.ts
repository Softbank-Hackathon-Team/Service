import type { PrecheckItem, TimelineItem } from "./types";
import { t } from './i18n';

// Z83-06: 타임라인 한 줄의 detail(JSON)을 사람이 읽는 조각으로. 워커가 넣는 키만 안다(apps/worker/src/jobs/*.ts):
//   precheck: PrecheckItem[]                 (precheck.ts — 되돌아간 이유)
//   deploy: {…}, gitops: { commit, argoApp } | { skipped }   (deploy.ts — GitOps 커밋·Argo 앱)
//   measurements, windowSec, revert: { reason }, attempts     (cutover.ts)
//   recheck, error, step                      (apply.ts·cutover.ts 실패)
//   error|reason, missing, hint — 맨 위 또는 단계 칸 하나 안 (멈춘·실패한 전이. stopHelpOf)
// 모르는 키는 안 보여 준다(원문은 서버 report 에 있음)

export interface DetailChip { label: string; tone?: "ok" | "wait" | "bad" | "run" }

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const str = (x: unknown): string | null => (typeof x === "string" ? x : typeof x === "number" ? String(x) : null);

export function precheckOf(detail: Record<string, unknown>): PrecheckItem[] | null {
  const pc = detail.precheck;
  if (!Array.isArray(pc)) return null;
  return pc.filter((c): c is PrecheckItem => isObj(c) && typeof c.id === "string" && typeof c.message === "string"
    && (c.level === "block" || c.level === "warn" || c.level === "info"));
}

export function summarizeDetail(detail: Record<string, unknown>): DetailChip[] {
  const out: DetailChip[] = [];
  const pc = precheckOf(detail);
  if (pc) {
    const block = pc.filter((c) => c.level === "block").length, warn = pc.filter((c) => c.level === "warn").length;
    out.push({ label: t('점검 {0}항목 · 막힘 {1} · 주의 {2}', { 0: pc.length, 1: block, 2: warn }), tone: block ? "bad" : warn ? "wait" : "ok" });
  }
  const g = detail.gitops;
  if (isObj(g)) {
    if (str(g.skipped)) out.push({ label: t('GitOps 건너뜀 ({0})', { 0: str(g.skipped) }), tone: "wait" });
    const c = str(g.commit); if (c) out.push({ label: t('커밋 {0}', { 0: c.slice(0, 8) }), tone: "ok" });
    const a = str(g.argoApp); if (a) out.push({ label: t('Argo 앱 {0}', { 0: a }) });
  }
  const d = detail.deploy;
  if (isObj(d)) {
    const e = str(d.error); if (e) out.push({ label: t('배포 오류 {0}', { 0: e }), tone: "bad" });
    const s = str(d.status) ?? str(d.result); if (s && !e) out.push({ label: t('배포 {0}', { 0: s }) });
  }
  const w = detail.windowSec; if (typeof w === "number") out.push({ label: t('롤백 창 {0}초', { 0: w }) });
  const r = detail.revert; if (isObj(r)) { const why = str(r.reason); out.push({ label: t('되돌림{0}', { 0: why ? ": " + why : "" }), tone: "wait" }); }
  const at = detail.attempts; if (typeof at === "number" && at > 1) out.push({ label: t('{0}번째 시도', { 0: at }), tone: "wait" });
  if (detail.recheck) out.push({ label: t('실행 직전 재검사 실패 (계획 지문 다름)'), tone: "bad" });
  const err = str(detail.error); if (err) out.push({ label: err, tone: "bad" });
  if (detail.stub === true) out.push({ label: t('흉내(stub)'), tone: "wait" });
  return out;
}

// 마지막으로 되돌아간(prechecking → spec_review) 전이의 점검 항목. 없으면 null
export function lastPrecheckBounce(items: TimelineItem[]): { at: string; items: PrecheckItem[] } | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]!;
    if (it.kind === "transition" && it.from === "prechecking" && it.to === "spec_review") {
      const pc = precheckOf(it.detail);
      if (pc) return { at: it.at, items: pc };
    }
  }
  return null;
}

// 트래픽 판정 한 번 (contracts results.ts TrafficJudgement). 워커 shift 가 멈추거나 되돌릴 때 detail.lastJudgement 로 남긴다
export interface Judgement {
  stepPct: number; samples: number;
  targetErrorRatePct: number; sourceErrorRatePct: number;
  targetP95Ms: number; sourceP95Ms: number;
  latencyMeasured?: boolean;
  verdict: string;
}
const num = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
function judgementOf(x: unknown): Judgement | null {
  if (!isObj(x)) return null;
  const keys = ["stepPct", "samples", "targetErrorRatePct", "sourceErrorRatePct", "targetP95Ms", "sourceP95Ms"] as const;
  if (!keys.every((k) => num(x[k]))) return null;
  return {
    stepPct: x.stepPct as number, samples: x.samples as number,
    targetErrorRatePct: x.targetErrorRatePct as number, sourceErrorRatePct: x.sourceErrorRatePct as number,
    targetP95Ms: x.targetP95Ms as number, sourceP95Ms: x.sourceP95Ms as number,
    ...(x.latencyMeasured === false ? { latencyMeasured: false } : {}),
    verdict: str(x.verdict) ?? "",
  };
}

/** 이 상태로 들어온 마지막 전이에 남은 근거: 트래픽 판정, 가드레일 규칙 번호 (packages/core advance: detail.evidence). 전이가 없으면 null */
//   리허설로 멈춘 전이는 detail.rehearsal 에 stage(queue = 줄 서기 / run = 실행)를 남긴다 (REHEARSAL_TIMEOUT 을 둘로 가른다)
export function stopEvidence(items: TimelineItem[], into: string): { at: string; judgement: Judgement | null; rule: string | null; rehearsalStage: "queue" | "run" | null } | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]!;
    if (it.kind !== "transition" || it.to !== into) continue;
    const evidence = isObj(it.detail.evidence) ? it.detail.evidence : {};
    const stage = isObj(it.detail.rehearsal) ? str(it.detail.rehearsal.stage) : null;
    return { at: it.at, judgement: judgementOf(it.detail.lastJudgement), rule: str(evidence.guardrailRule),
      rehearsalStage: stage === "queue" || stage === "run" ? stage : null };
  }
  return null;
}

/** 멈춘 전이에 서버가 남긴 도움말: 무슨 일이 있었나 / 무엇이 빠졌나(설정·권한·도구 이름 그대로) / 어떻게 고치나 */
export interface StopHelp { error: string | null; missing: string[]; hint: string | null }

const NO_HELP: StopHelp = { error: null, missing: [], hint: null };
const text = (x: unknown): string | null => (typeof x === "string" && x.trim() ? x.trim() : null);
// 사유 코드 모양(TRAFFIC_NOT_CONFIGURED). 단계 칸의 error 는 코드만 담고 사람 말은 reason 에 두는 곳이 많다 (워커 deploy·shift)
const CODE_LIKE = /^[A-Z][A-Z0-9_]*$/;

function helpIn(o: Record<string, unknown>): StopHelp | null {
  const error = text(o.error), reason = text(o.reason);
  const missing = Array.isArray(o.missing) ? [...new Set(o.missing.map(text).filter((x): x is string => x !== null))] : [];
  const help = { error: error && CODE_LIKE.test(error) ? reason ?? error : error ?? reason, missing, hint: text(o.hint) };
  return help.error || help.missing.length > 0 || help.hint ? help : null;
}

/**
 * 멈춘·실패한 전이 detail 에서 도움말을 읽는다. 워커는 error|reason·missing·hint 를 detail 맨 위에 두거나
 * 단계 칸 하나 안에 둔다 (detail.shift·envLayer·deploy·relay·tempRole·rehearsal …).
 * 맨 위에 하나라도 있으면 맨 위를 쓰고, 없으면 그런 값이 있는 첫 단계 칸을 쓴다. 글이 아닌 값은 버린다 (서버 모양을 믿지 않는다)
 */
export function stopHelpOf(detail: Record<string, unknown>): StopHelp {
  const top = helpIn(detail);
  if (top) return top;
  for (const value of Object.values(detail)) {
    const nested = isObj(value) ? helpIn(value) : null;
    if (nested) return nested;
  }
  return NO_HELP;
}

/**
 * 감사 줄 하나에 서버가 남긴 실패 이유 한 줄. 워커는 실패·재시도 이유를 detail.error 에 남긴다(500자, 워커 _step.ts SD-1·import.ts).
 * 단계 칸 안의 error·reason(detail.envLayer.error, detail.deploy.reason …)도 읽는다 (stopHelpOf).
 * 계획 재확인 실패는 detail.recheck 에 글로 남긴다 (plan.ts). 없으면 null. 글자 그대로 보여 준다 (HTML 로 해석하지 않는다)
 */
export function failureDetailOf(item: Pick<TimelineItem, "detail">): string | null {
  return helpWithRecheck(item.detail).error;
}

function helpWithRecheck(detail: Record<string, unknown>): StopHelp {
  const help = stopHelpOf(detail);
  return help.error ? help : { ...help, error: text(detail.recheck) };
}

/** 이 상태(기본 failed)로 들어온 마지막 전이의 도움말 (이유는 failureDetailOf 와 같다). 전이가 없으면 빈 도움말 */
export function stopHelp(items: TimelineItem[], into = "failed"): StopHelp {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]!;
    if (it.kind === "transition" && it.to === into) return helpWithRecheck(it.detail);
  }
  return NO_HELP;
}

/** 이 상태(기본 failed)로 들어온 마지막 전이의 실패 이유. 실패 화면의 큰 카드가 쓴다 */
export function failureDetail(items: TimelineItem[], into = "failed"): string | null {
  return stopHelp(items, into).error;
}

// 가장 최근 측정값(이름별 1개). 복제 지연·컷오버 멈춤 같은 숫자를 상세·모니터링에서 바로 보이게
export function latestMeasurements(items: TimelineItem[]): { name: string; value: number; unit: string; at: string }[] {
  const seen = new Map<string, { name: string; value: number; unit: string; at: string }>();
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]!;
    for (const m of it.measurements) if (!seen.has(m.name)) seen.set(m.name, { ...m, at: it.at });
  }
  return [...seen.values()];
}

export const MEASURE_LABEL: Record<string, string> = {
  replication_lag_ms: t('복제 지연'), cutover_pause_ms: t('컷오버 멈춤'), reverse_replication_ms: t('역방향 복제'), initial_copy_ms: t('초기 복사'),
  sequences_synced: t('시퀀스 맞춤'), replication_slot_lag_bytes: t('슬롯 지연 바이트'), replication_slot_safe_wal_bytes: t('슬롯 안전 WAL'), fence_terminated_sessions: t('끊은 세션'),
  forward_slot_left: t('남은 정방향 슬롯'), already_cut_over: t('이미 컷오버'), p95_ms: "p95", error_rate_pct: t('오류율'),
};
