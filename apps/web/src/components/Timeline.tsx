import { useState } from "react";
import { api } from "../api";
import type { MigrationStatus, TimelineItem, TimelineView } from "../types";
import { LABEL, toneOf } from "../status";
import { NotYet, usePoll404 } from "./Optional";
import { MEASURE_LABEL, latestMeasurements, summarizeDetail } from "../timelineDetail";

// Z83: 감사 기록으로 만든 상태 전이 타임라인 (GET /migrations/:id/timeline, openapi Timeline).
// 레퍼런스: Temporal Web UI 타임라인 — 상태별 머문 시간을 막대 길이로, 전이는 시간순 표로.
// 보조 칸이라 오류 상자(.error)를 쓰지 않는다 (e2e ".error 0개" 검사와 섞이지 않게)

const lbl = (s: string | null) => (s && s in LABEL ? LABEL[s as MigrationStatus] : s ?? "—");
const ms = (x: number | null) => (x === null ? "—" : x >= 10_000 ? `${(x / 1000).toFixed(1)}s` : `${x}ms`);
const hhmmss = (iso: string) => {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : d.toLocaleTimeString("ko-KR", { hour12: false }) + "." + String(d.getMilliseconds()).padStart(3, "0");
};
const ACTOR: Record<string, string> = { worker: "워커", api: "API", system: "시스템" };

function TransitionRow({ it }: { it: TimelineItem }) {
  const bad = it.result !== "ok" || !!it.failureCode;
  return (
    <tr data-seq={it.seq} data-kind={it.kind}>
      <td className="at">{hhmmss(it.at)}</td>
      <td>{it.kind === "transition" ? <>{lbl(it.from)} → <b>{lbl(it.to)}</b></> : <span className="muted">{it.action}</span>}</td>
      <td className="muted">{ACTOR[it.actor] ?? it.actor}</td>
      <td className="ms">{ms(it.durationMs)}</td>
      <td className={bad ? "bad" : "muted"}>
        {it.failureCode ?? (it.result === "ok" ? "" : it.result)}
        {it.measurements.length > 0 && (
          <span className="small"> {it.measurements.map((x) => `${MEASURE_LABEL[x.name] ?? x.name} ${x.value}${x.unit}`).join(" · ")}</span>
        )}
        {/* Z83-06: detail(JSON) 중 아는 키만 조각으로 — 점검 항목 수, GitOps 커밋·Argo 앱, 되돌림 이유, 롤백 창 */}
        {summarizeDetail(it.detail).map((c, i) => <span key={i} className={`chip small${c.tone ? ` tone-${c.tone}` : ""}`}>{c.label}</span>)}
      </td>
    </tr>
  );
}

export function Timeline(p: { id: string; live: boolean; version?: number }) {
  // 상태가 바뀔 때(version)마다 다시 읽는다. 진행 중이면 5초마다, 끝난 이전은 한 번만. 404 는 { v: null }
  const r = usePoll404<TimelineView>(() => api.timeline(p.id), p.live ? 5000 : null, [p.id, p.live, p.version]);
  const [all, setAll] = useState(false);
  const v = r.data?.v;
  if (r.error) return <p className="muted small">타임라인 없음: {String(r.error)}</p>;
  if (!v) return <NotYet answered={!!r.data} what="타임라인" />;

  const durs = v.stateDurations.filter((d) => d.ms > 0);
  const max = Math.max(1, ...durs.map((d) => d.ms));
  const transitions = v.items.filter((i) => i.kind === "transition");
  const rows = all ? v.items : transitions;
  const latest = latestMeasurements(v.items);
  return (
    <div className="tl" data-testid="timeline">
      <div className="tl-sum">
        <span>전체 <b>{ms(v.totalMs)}</b></span>
        <span>전이 <b>{transitions.length}</b>번</span>
        <span>기록 <b>{v.items.length}</b>줄</span>
        <span>{v.running ? "진행 중 (서버가 읽은 시각 " + hhmmss(v.generatedAt) + ")" : "끝남"}</span>
      </div>
      {latest.length > 0 && (
        <div className="tl-meas" data-testid="timeline-measurements">
          {latest.map((m) => <span key={m.name} className="kv-chip" title={`${m.name} · ${hhmmss(m.at)}`}><span className="muted">{MEASURE_LABEL[m.name] ?? m.name}</span> <b>{m.value.toLocaleString()}</b>{m.unit}</span>)}
        </div>
      )}
      {durs.length > 0 && (
        <div className="tl-bars" role="list" aria-label="상태별 머문 시간">
          {durs.map((d) => (
            <div key={d.state} role="listitem" style={{ display: "contents" }}>
              <span className="tl-s" title={d.state}>{lbl(d.state)}{d.entries > 1 && <span className="small"> ×{d.entries}</span>}</span>
              <span className="tl-b"><span className={`tone-${d.state in LABEL ? toneOf(d.state as MigrationStatus) : "run"}`} style={{ width: `${(d.ms / max) * 100}%` }} /></span>
              <span className="tl-ms">{ms(d.ms)}</span>
            </div>
          ))}
        </div>
      )}
      <details>
        <summary>전이 기록 {rows.length}줄 {all ? "(이벤트 포함)" : ""}</summary>
        <label className="small muted" style={{ display: "inline-flex", gap: 6, alignItems: "center", margin: "6px 0" }}>
          <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> 전이 아닌 이벤트도 보기
        </label>
        <table className="tbl tl-tbl">
          <thead><tr><th>시각</th><th>전이</th><th>누가</th><th>걸림</th><th>결과·측정</th></tr></thead>
          <tbody>{rows.map((it) => <TransitionRow key={it.seq} it={it} />)}</tbody>
        </table>
      </details>
    </div>
  );
}
