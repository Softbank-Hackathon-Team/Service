import { api, is404 } from "../api";
import { usePoll } from "../usePoll";
import { LABEL } from "../status";
import type { MigrationStatus } from "../types";
import { liveHeadline, REASON_TEXT, SHIFT_TOL_PCT, type LiveTrafficView, type TrafficShiftProgress } from "../liveTraffic";
import { usePoll404 } from "./Optional";

// 작업 Z35 (Z15 제안 3): "가동 중 앱을 숫자로". 이전 내내 앱 요청 수·실패 수·p95 가 갱신된다.
// 숫자 출처 = 앱 앞 프록시(tools/load/live-app/switch-proxy.mjs) → API GET /migrations/:id/live-traffic.
// DRAFT(ai): 1초마다 읽고, 끝난 이전은 한 번만 (프록시 숫자는 다음 __track 전까지 남아 있다)
// Z83: 트래픽 전환 칸. 목표 가중치 | 실측 비율 두 칸 (GET /migrations/:id/traffic-shift).
//   reached=true → 실측 칸 성공색 + "퍼짐 끝", false → "엣지에 퍼지는 중", null → 실측 없음, available=false·404 → 목표(계획서 weights)만
export function ShiftPanel(p: { id: string; active: boolean; done: boolean; planWeights?: number[] }) {
  // shifting 동안 1초(워커 갱신 주기), 그 밖엔 5초, 끝난 이전은 1회. 404 = 서버에 경로 없음 → { v: null }
  const r = usePoll404<TrafficShiftProgress>(() => api.trafficShift(p.id), p.done ? null : p.active ? 1000 : 5000, [p.id, p.active, p.done]);
  const v = r.data?.v;
  const s = v?.available ? v : null;
  if (!s && !p.active && !p.planWeights?.length) return null;
  const pct = (x: number | null | undefined) => (x === null || x === undefined ? "—" : `${x}%`);
  const settled = s ? s.reached : null;
  const tol = s?.tolerancePct ?? SHIFT_TOL_PCT;
  const at = (iso: string | null | undefined) => (iso ? ` · ${new Date(iso).toLocaleTimeString("ko-KR", { hour12: false })}` : "");
  return (
    <div className="shift" data-testid="shift-panel" data-reached={settled === null ? "unknown" : settled ? "yes" : "no"}>
      <div className="kpis">
        <div className="kpi">
          <span className="kpi-l">목표 가중치 (도착 쪽)</span>
          <span className="kpi-v">{pct(s?.targetWeightPct)}</span>
          <span className="kpi-s">
            {p.planWeights?.length ? `계획 단계 ${p.planWeights.join(" → ")}%` : "계획서 가중치 없음"}
            {s?.stepStartedAt && ` · 단계 시작${at(s.stepStartedAt)}`}
          </span>
        </div>
        <div className={`kpi${settled ? " kpi-ok" : ""}`}>
          <span className="kpi-l">실측 비율 (엣지가 실제로 보낸 몫)</span>
          <span className={`kpi-v${settled ? " ok" : ""}`}>{pct(s?.observedWeightPct)}</span>
          <span className="kpi-s">
            {!v ? (r.error ? "실측 못 읽음" : r.data ? "서버에 traffic-shift 경로 없음 — 목표만 표시" : "읽는 중…")
              : !v.available ? "전환 기록 없음 — 목표만 표시"
              : settled === null ? "실측값 아직 없음"
              : settled ? `✓ 목표 ±${tol}%p 안 — 퍼짐 끝`
              : "엣지에 퍼지는 중"}
            {s?.observedAt && at(s.observedAt)}
            {s && s.reobserve > 0 && ` · 재관측 ${s.reobserve}`}
          </span>
        </div>
      </div>
    </div>
  );
}

export function LiveTraffic(p: { id: string; done: boolean; status?: MigrationStatus; planWeights?: number[] }) {
  const r = usePoll<LiveTrafficView>(() => api.liveTraffic(p.id), p.done ? null : 1000, [p.id]);
  const v = r.data;
  const shifting = p.status === "shifting";
  const shiftPanel = <ShiftPanel id={p.id} active={shifting} done={p.done} planWeights={p.planWeights} />;
  // 오류 상자(.error)는 쓰지 않는다: 이 칸은 보조 정보라, 서버에 경로가 없거나 꺼져도 화면 오류로 보이면 안 된다 (e2e .error 0개 검사)
  if (!v) {
    if (!r.error) return <>{shiftPanel}<p className="muted small">가동 중 앱 숫자를 읽는 중…</p></>;
    const why = is404(r.error) ? "이 이전을 서버에서 못 찾음 (404)" : String(r.error);
    return <>{shiftPanel}<p className="muted small live-none">숫자 없음: {why}</p></>;
  }
  if (!v.available) return <>{shiftPanel}<p className="muted small live-none">숫자 없음: {REASON_TEXT[v.reason ?? "unreachable"]}</p></>;
  const h = liveHeadline(v);
  return (
    <div className="live">
      {shiftPanel}
      <p className={`live-head ${h.tone}`}><strong>{h.text}</strong></p>
      <p className="muted small">
        4xx {v.c4xx}건(앱이 거절, 이전 탓 아님) · p50 {v.p50Ms ?? "—"} ms
        {v.held > 0 && <> · 컷오버 동안 붙잡은 요청 {v.held}건 (최대 {v.maxHoldMs} ms)</>}
        {v.switchedAt && <> · 도착 쪽으로 넘긴 시각 {new Date(v.switchedAt).toLocaleTimeString()}</>}
        {v.since && <> · 센 시작 {new Date(v.since).toLocaleTimeString()}</>}
      </p>
      {v.byState.length > 0 && (
        <table className="tbl live-tbl">
          <thead><tr><th>요청이 들어온 때의 상태</th><th>요청</th><th>실패</th><th>p95 ms</th></tr></thead>
          <tbody>
            {v.byState.map((b) => (
              <tr key={b.state}>
                <td>{LABEL[b.state as MigrationStatus] ?? (b.state === "before" ? "이전 시작 전" : b.state)}</td>
                <td>{b.n}</td><td className={b.fail ? "bad" : undefined}>{b.fail}</td><td>{b.p95Ms ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="muted small">출처: 앱 앞 프록시가 직접 센 값 【실측】. 프록시를 거치지 않은 요청은 안 들어가.</p>
    </div>
  );
}
