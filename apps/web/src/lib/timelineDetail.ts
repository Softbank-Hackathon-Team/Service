import type { PrecheckItem, TimelineItem } from "./types";

// Z83-06: 타임라인 한 줄의 detail(JSON)을 사람이 읽는 조각으로. 워커가 넣는 키만 안다(apps/worker/src/jobs/*.ts):
//   precheck: PrecheckItem[]                 (precheck.ts — 되돌아간 이유)
//   deploy: {…}, gitops: { commit, argoApp } | { skipped }   (deploy.ts — GitOps 커밋·Argo 앱)
//   measurements, windowSec, revert: { reason }, attempts     (cutover.ts)
//   recheck, error, step                      (apply.ts·cutover.ts 실패)
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
    out.push({ label: `점검 ${pc.length}항목 · 막힘 ${block} · 주의 ${warn}`, tone: block ? "bad" : warn ? "wait" : "ok" });
  }
  const g = detail.gitops;
  if (isObj(g)) {
    if (str(g.skipped)) out.push({ label: `GitOps 건너뜀 (${str(g.skipped)})`, tone: "wait" });
    const c = str(g.commit); if (c) out.push({ label: `커밋 ${c.slice(0, 8)}`, tone: "ok" });
    const a = str(g.argoApp); if (a) out.push({ label: `Argo 앱 ${a}` });
  }
  const d = detail.deploy;
  if (isObj(d)) {
    const e = str(d.error); if (e) out.push({ label: `배포 오류 ${e}`, tone: "bad" });
    const s = str(d.status) ?? str(d.result); if (s && !e) out.push({ label: `배포 ${s}` });
  }
  const w = detail.windowSec; if (typeof w === "number") out.push({ label: `롤백 창 ${w}초` });
  const r = detail.revert; if (isObj(r)) { const why = str(r.reason); out.push({ label: `되돌림${why ? ": " + why : ""}`, tone: "wait" }); }
  const at = detail.attempts; if (typeof at === "number" && at > 1) out.push({ label: `${at}번째 시도`, tone: "wait" });
  if (detail.recheck) out.push({ label: "실행 직전 재검사 실패 (계획 지문 다름)", tone: "bad" });
  const err = str(detail.error); if (err) out.push({ label: err, tone: "bad" });
  if (detail.stub === true) out.push({ label: "흉내(stub)", tone: "wait" });
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
  replication_lag_ms: "복제 지연", cutover_pause_ms: "컷오버 멈춤", reverse_replication_ms: "역방향 복제", initial_copy_ms: "초기 복사",
  sequences_synced: "시퀀스 맞춤", replication_slot_lag_bytes: "슬롯 지연 바이트", replication_slot_safe_wal_bytes: "슬롯 안전 WAL", fence_terminated_sessions: "끊은 세션",
  forward_slot_left: "남은 정방향 슬롯", already_cut_over: "이미 컷오버", p95_ms: "p95", error_rate_pct: "오류율",
};
