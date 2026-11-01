import { useState } from "react";
import { api, HttpError } from "../../api";
import { usePoll } from "../../usePoll";
import { isTerminal } from "../../status";
import { StatusChip } from "../../components/StatusChip";
import { SecurityPanel } from "../../components/SecurityPanel";
import { Timeline } from "../../components/Timeline";
import { usePoll404 } from "../../components/Optional";
import type { LiveCheckState, RegressionChange, SecurityRegression } from "../../security-types";
import { ago, isTestMigration, pageApi, shortId, type EvidenceReport } from "../common";
import "./page.css";

// Z85: 보안·감사 페이지. 사용자가 확인하는 것
//   1) 감사 기록이 안 고쳐졌나 (해시 사슬 재검증) — 이전 전체를 한 표로 (GET /migrations/:id/report)
//   2) 고른 이전: 누가 무엇을 승인했고 지문이 맞나, 거부·오류 기록, 리포트에 빈 칸
//   3) 고른 이전의 보안 통제 표(임시 자격·최소 권한·비밀값·런타임·통제 12개 × 출발/도착) — 기존 SecurityPanel
//   3-1) 이전 전후 보안 회귀: 출발 vs 도착 실점검을 항목별로 비교 (GET /security/regression, Z95·Z91)
//   4) 상태 변화 타임라인(감사 기록으로 만든 것, 기존 Timeline) + 증적 리포트 HTML (심사·고객 제출용)

const MAX_ROWS = 10;
const REASON: Record<string, string> = {
  hash_mismatch: "줄 내용이 지문과 다름", prev_link_broken: "앞 줄과 고리가 끊김", not_from_genesis: "처음부터 이어지지 않음",
};
const ts = (iso: string) => iso.replace("T", " ").slice(0, 19);

export function SecurityPage(p: { migrationId?: string }) {
  return (
    <div className="page pg-sec">
      <ChainOverview selected={p.migrationId} />
      {p.migrationId ? <Selected id={p.migrationId} /> : (
        <section className="card"><h2>고른 이전의 승인·감사·보안 통제</h2>
          <p className="muted">위 "이전 고르기"에서 하나를 고르면 승인 지문, 거부·오류 기록, 보안 통제 표, 상태 변화 기록을 보여 줘.</p></section>
      )}
    </div>
  );
}

// ---- 1) 감사 사슬 전체 ----
function ChainOverview(p: { selected?: string }) {
  const q = usePoll(async () => {
    const [ms, envs] = await Promise.all([pageApi.listMigrations(), pageApi.listEnvironments().catch(() => [])]);
    const real = ms.filter((m) => !isTestMigration(m, envs)).slice(0, MAX_ROWS);
    const rows = await Promise.all(real.map(async (m) => {
      try { return { m, r: await pageApi.report(m.id) as EvidenceReport | null, missing: false }; }
      catch (e) { return { m, r: null, missing: e instanceof HttpError && e.status === 404 }; }
    }));
    return rows;
  }, 30000, []);
  const rows = q.data ?? [];
  const withR = rows.filter((x) => x.r);
  const broken = withR.filter((x) => !x.r!.integrity.ok).length;
  const checked = withR.reduce((a, x) => a + x.r!.integrity.checked, 0);
  const denied = withR.reduce((a, x) => a + x.r!.summary.deniedOrError, 0);
  const badHash = withR.reduce((a, x) => a + x.r!.approvals.filter((ap) => !ap.hashMatches).length, 0);

  return (
    <section className="card" id="sec-chain">
      <div className="card-head"><h2>감사 기록 위변조 점검</h2><span className="small muted">최근 이전 {MAX_ROWS}건 · 30초마다 다시 계산</span></div>
      <div className="pg-kpis">
        <div className={broken ? "k-bad" : "k-ok"}><span className="k">{broken ? "✕ 사슬 끊김" : "✓ 사슬 온전"}</span>
          <span className="v num">{withR.length - broken} / {withR.length}</span></div>
        <div><span className="k">다시 계산한 기록 줄</span><span className="v num">{checked.toLocaleString()}</span></div>
        <div className={badHash ? "k-bad" : ""}><span className="k">승인 지문 불일치</span><span className="v num">{badHash}</span></div>
        <div className={denied ? "k-wait" : ""}><span className="k">거부·오류 기록</span><span className="v num">{denied}</span></div>
      </div>
      {q.loading && <p className="muted">불러오는 중…</p>}
      {rows.length > 0 && (
        <table className="tbl">
          <thead><tr><th>이전</th><th>상태</th><th>경로</th><th>감사 사슬</th><th className="r">기록 줄</th><th className="r">승인</th><th className="r">거부·오류</th><th className="r">빈 칸</th></tr></thead>
          <tbody>{rows.map(({ m, r, missing }) => (
            <tr key={m.id} className={m.id === p.selected ? "sel" : ""}>
              <td><code>{shortId(m.id)}</code></td><td><StatusChip status={m.status} /></td>
              <td className="small">{r ? `${r.migration.source.name} → ${r.migration.target.name}` : "—"}</td>
              <td className={r ? (r.integrity.ok ? "ok" : "bad") : "muted"}>
                {r ? (r.integrity.ok ? "✓ 온전" : `✕ ${r.integrity.brokenAtSeq ?? "?"}번 줄 (${REASON[r.integrity.reason ?? ""] ?? r.integrity.reason})`)
                  : missing ? "리포트 경로 없음" : "읽기 실패"}
                {r?.integrity.partial && <span className="muted small"> · 앞부분 생략</span>}</td>
              <td className="r num">{r?.integrity.checked ?? "—"}</td>
              <td className="r num">{r ? `${r.approvals.filter((a) => a.hashMatches).length}/${r.approvals.length}` : "—"}</td>
              <td className={`r num ${r && r.summary.deniedOrError > 0 ? "wait" : ""}`}>{r?.summary.deniedOrError ?? "—"}</td>
              <td className="r num">{r?.gaps.length ?? "—"}</td>
            </tr>
          ))}</tbody>
        </table>
      )}
      <p className="small muted">감사 기록은 줄마다 앞 줄의 지문(SHA-256)을 품는다. 한 줄이라도 고치면 그 뒤 고리가 전부 어긋나서 여기서 ✕ 로 보여.</p>
    </section>
  );
}

// ---- 2)~4) 고른 이전 ----
function Selected(p: { id: string }) {
  const q = usePoll(() => pageApi.report(p.id), 10000, [p.id], { keepOnError: false });
  const r = q.data;
  const live = r ? !isTerminal(r.migration.status) : true;
  const [opening, setOpening] = useState(false);
  const [openErr, setOpenErr] = useState<string | null>(null);
  const openReport = async () => {
    setOpening(true); setOpenErr(null);
    try {
      const html = await api.reportHtml(p.id);
      const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
      window.open(url, "_blank", "noopener");
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) { setOpenErr(e instanceof Error ? e.message : String(e)); }
    finally { setOpening(false); }
  };

  return (
    <>
      <section className="card" id="sec-approvals">
        <div className="card-head"><h2>승인 기록</h2>
          <span className="pg-actions">
            <button onClick={openReport} disabled={opening}>{opening ? "여는 중…" : "증적 리포트 열기 (HTML)"}</button>
          </span></div>
        {openErr && <p className="bad small">리포트 열기 실패: {openErr}</p>}
        {q.error ? <p className="muted small">리포트를 못 읽었어 ({q.error instanceof HttpError ? q.error.status : "연결"}).</p> : null}
        {r && <>
          <div className="kv">
            <span>이전</span><span><code>{shortId(r.migration.id)}</code> {r.migration.source.name} → {r.migration.target.name} <StatusChip status={r.migration.status} /></span>
            <span>걸린 시간</span><span className="num">{r.summary.totalMs !== null ? `${(r.summary.totalMs / 1000).toFixed(1)}초` : "진행 중"} · 전이 {r.summary.transitions}번
              {r.summary.reachedCutover ? " · 컷오버 지남" : ""}{r.summary.rolledBack ? " · 되돌림" : ""}</span>
            <span>리포트 지문</span><span><code className="small">{r.reportHash.slice(0, 16)}…</code> <span className="muted small">{ago(r.generatedAt)} 생성</span></span>
          </div>
          {r.approvals.length === 0
            ? <p className="muted small">아직 승인·거절 기록이 없어.</p>
            : <table className="tbl"><thead><tr><th>결정</th><th>누가</th><th>언제</th><th>사람이 본 지문</th><th>저장된 지문</th><th>일치</th></tr></thead>
                <tbody>{r.approvals.map((a) => (
                  <tr key={`${a.planId}-${a.at}`}><td>{a.decision === "approve" ? "승인" : "거절"}</td><td>{a.approvedBy}</td>
                    <td className="small num">{ts(a.at)}</td><td><code className="small">{a.approvedPlanHash.slice(0, 12)}</code></td>
                    <td><code className="small">{a.storedPlanHash?.slice(0, 12) ?? "—"}</code></td>
                    <td className={a.hashMatches ? "ok" : "bad"}>{a.hashMatches ? "✓" : "✕ 다름"}</td></tr>
                ))}</tbody></table>}
        </>}
      </section>

      {r && (
        <section className="card" id="sec-incidents">
          <div className="card-head"><h2>거부·오류 기록</h2><span className="small muted">권한 없음·가드 거부·작업 오류</span></div>
          {r.incidents.length === 0
            ? <p className="muted small">✓ 이 이전에는 거부·오류 기록이 없어.</p>
            : <table className="tbl"><thead><tr><th className="r">번호</th><th>언제</th><th>누가</th><th>무엇을</th><th>결과</th><th>메모</th></tr></thead>
                <tbody>{r.incidents.map((x) => (
                  <tr key={x.seq}><td className="r num">{x.seq}</td><td className="small num">{ts(x.at)}</td><td>{x.actor}</td>
                    <td><code className="small">{x.action}</code></td><td className={x.result === "denied" ? "wait" : "bad"}>{x.result === "denied" ? "◐ 거부" : "✕ 오류"}</td>
                    <td className="small">{x.note}</td></tr>
                ))}</tbody></table>}
          {r.gaps.length > 0 && <>
            <h3>리포트에 비어 있는 것 <span className="small muted">숨기지 않고 적는다</span></h3>
            <ul className="small">{r.gaps.map((g) => <li key={g}>{g}</li>)}</ul>
          </>}
        </section>
      )}

      <Regression id={p.id} live={live} />

      <section className="card" id="sec-controls">
        <div className="card-head"><h2>보안 통제 표</h2><span className="small muted">임시 자격 · 최소 권한 · 감사 · 비밀값 · 런타임 · 통제 12개</span></div>
        <SecurityPanel id={p.id} live={live} />
      </section>

      <section className="card" id="sec-timeline">
        <div className="card-head"><h2>상태 변화 기록</h2><span className="small muted">감사 기록에서 만든 전이 타임라인 · 누가·언제·얼마나</span></div>
        <Timeline id={p.id} live={live} />
      </section>
    </>
  );
}

// ---- 3-1) 이전 전후 보안 회귀 (Z95) ----
const STATE: Record<LiveCheckState, { mk: string; text: string; cls: string }> = {
  pass: { mk: "✓", text: "통과", cls: "ok" }, warn: { mk: "◐", text: "약점", cls: "wait" }, fail: { mk: "✕", text: "실패", cls: "bad" },
  unavailable: { mk: "○", text: "못 읽음", cls: "muted" }, n_a: { mk: "–", text: "해당 없음", cls: "muted" },
};
const CHANGE: Record<RegressionChange, { text: string; cls: string }> = {
  worse: { text: "✕ 나빠짐", cls: "bad" }, better: { text: "✓ 좋아짐", cls: "ok" }, same: { text: "같음", cls: "muted" }, unknown: { text: "○ 비교 불가", cls: "muted" },
};
const VERDICT: Record<SecurityRegression["verdict"], { text: string; cls: string }> = {
  regressed: { text: "✕ 도착 환경이 출발보다 약해진 항목이 있어", cls: "k-bad" },
  no_regression: { text: "✓ 나빠진 항목 없음", cls: "k-ok" },
  unavailable: { text: "○ 아직 비교할 점검 기록이 없어", cls: "" },
};
function Cell(p: { s: LiveCheckState | null; ev: string | null }) {
  if (!p.s) return <td className="muted">—</td>;
  const x = STATE[p.s];
  return <td className={x.cls} title={p.ev ?? undefined}>{x.mk} {x.text}{p.ev && <div className="small muted">{p.ev}</div>}</td>;
}
function Regression(p: { id: string; live: boolean }) {
  const q = usePoll404<SecurityRegression>(() => api.securityRegression(p.id), p.live ? 10000 : null, [p.id, p.live]);
  const r = q.data?.v;
  const head = (h: SecurityRegression["source"]) => h ? `${h.provider} · ${ago(h.checkedAt)}${h.origin === "snapshot" ? " (저장본)" : ""}` : "기록 없음";
  return (
    <section className="card" id="sec-regression">
      <div className="card-head"><h2>이전 전후 보안 비교</h2><span className="small muted">출발 환경 vs 도착 환경 실점검, 항목별</span></div>
      {q.error ? <p className="muted small">비교 결과를 못 읽었어 ({q.error instanceof HttpError ? q.error.status : "연결"}).</p> : null}
      {!q.data && !q.error && <p className="muted">불러오는 중…</p>}
      {q.data && !r && <p className="muted small">서버에 비교 경로가 아직 없어(404). 보안 회귀 기능이 들어간 회차부터 보여.</p>}
      {r && <>
        <div className="pg-kpis">
          <div className={VERDICT[r.verdict].cls}><span className="k">판정</span><span className="v" style={{ fontSize: 14 }}>{VERDICT[r.verdict].text}</span></div>
          <div className={r.summary.worse ? "k-bad" : ""}><span className="k">나빠짐</span><span className="v num">{r.summary.worse}</span></div>
          <div className={r.summary.better ? "k-ok" : ""}><span className="k">좋아짐</span><span className="v num">{r.summary.better}</span></div>
          <div><span className="k">같음 · 비교 불가</span><span className="v num">{r.summary.same} · {r.summary.unknown}</span></div>
        </div>
        <div className="kv">
          <span>출발 점검</span><span>{head(r.source)}</span>
          <span>도착 점검</span><span>{head(r.target)}</span>
        </div>
        {r.items.length === 0
          ? <p className="muted small">비교할 항목이 없어. 출발·도착 환경의 보안 실점검이 한 번씩 돌아야 여기 표가 생겨(점검은 이전이 진행되며 워커가 기록).</p>
          : <table className="tbl"><thead><tr><th>항목</th><th>분류</th><th>출발</th><th>도착</th><th>변화</th></tr></thead>
              <tbody>{r.items.map((it) => (
                <tr key={it.key}><td>{it.title} <code className="small muted">{it.key}</code></td><td className="small">{it.category}</td>
                  <Cell s={it.before} ev={it.beforeEvidence} /><Cell s={it.after} ev={it.afterEvidence} />
                  <td className={CHANGE[it.change].cls}>{CHANGE[it.change].text}</td></tr>
              ))}</tbody></table>}
        {!r.recorded && r.verdict !== "unavailable" && <p className="small muted">이 비교는 아직 감사 기록에 남지 않았어(조회 시점 계산).</p>}
      </>}
    </section>
  );
}
