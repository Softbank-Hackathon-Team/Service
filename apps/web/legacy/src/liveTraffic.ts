// 작업 Z35 (Z15 제안 3): 이전 상세 "가동 중 앱" 칸이 읽는 모양 (서버 apps/api/src/live-traffic.ts LiveTrafficView 와 같다)
// TODO(통합): contracts 로 옮기면 여기 타입은 지운다
export type LiveReason = "not_configured" | "unreachable" | "bad_shape" | "other_migration" | "no_counters";
export interface LiveTrafficView {
  migrationId: string;
  available: boolean;
  reason?: LiveReason;
  source: "proxy";
  fetchedAt: string;
  total: number; ok: number; fail: number; c4xx: number;
  p50Ms: number | null; p95Ms: number | null;
  held: number; maxHoldMs: number;
  mode: string | null; switchedAt: string | null; since: string | null;
  byState: { state: string; n: number; fail: number; p95Ms: number | null }[];
}
// Z83: 트래픽 전환 실측 — GET /migrations/:id/traffic-shift (Z75 z75-38 TrafficShiftProgress, 23:01Z 확정).
//   %, 정수 0~100. reached=true 목표 ±tolerancePct 안(성공색) / false "엣지에 퍼지는 중" / null 실측 없음. available=false 면 전환 기록 없음(목표만).
//   워커가 최대 초당 1회 갱신 → 화면은 shifting 동안 1초마다 읽는다
export const SHIFT_TOL_PCT = 10; // 서버 tolerancePct 가 없을 때만
export interface TrafficShiftProgress {
  migrationId: string;
  available: boolean;
  targetWeightPct: number | null;
  observedWeightPct: number | null;
  reached: boolean | null;
  tolerancePct: number;
  reobserve: number;
  stepStartedAt: string | null;
  observedAt: string | null;
}
// 숫자가 없을 때 화면에 쓸 한 문장 (무엇을 켜면 나오는지까지)
export const REASON_TEXT: Record<LiveReason, string> = {
  not_configured: "앱 앞 프록시가 연결 안 됨. API 에 LIVE_TRAFFIC_URL=http://localhost:8090/__stats 를 주고 switch-proxy 를 켜면 나와.",
  unreachable: "프록시에 못 닿음 (꺼졌거나 주소가 틀림). 마지막으로 본 숫자가 아니라 '모름'이야.",
  bad_shape: "프록시가 모르는 모양으로 답함. 프록시 버전을 확인해.",
  other_migration: "프록시가 다른 이전을 보고 있어. 이 이전으로 POST <프록시>/__track/<이전 번호> 를 보내면 바뀌어.",
  no_counters: "프록시가 옛 판이라 요청 수를 안 셈 (붙잡은 요청 수만 있음). Z35 판 switch-proxy 로 바꿔.",
};

// 맨 위 한 줄. 실패 0 이면 초록, 아니면 빨강으로 칠할 수 있게 tone 도 준다
export function liveHeadline(v: LiveTrafficView): { text: string; tone: "ok" | "bad" | "muted" } {
  if (!v.available) return { text: "숫자 없음", tone: "muted" };
  const p95 = v.p95Ms === null ? "—" : `${v.p95Ms} ms`;
  const failPct = v.total ? ` (${(v.fail / v.total * 100).toFixed(2)}%)` : "";
  return {
    text: `요청 ${v.total.toLocaleString("en-US")}건 · 실패 ${v.fail}${failPct} · p95 ${p95}`,
    tone: v.fail === 0 ? "ok" : "bad",
  };
}
