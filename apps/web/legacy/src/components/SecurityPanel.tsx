// 표시 메모: 보안 표. 요약 칩 4개, 해당 없음 토글. 영역 6개로 묶은 표(상태, 항목, 결과, 근거). 통제 매트릭스 펼치기(통제 × 출발·도착).
//   실제 점검: 출발·도착 요약, 항목 표(상태, 근거, 자원, 출처), 다시 점검 버튼. 값은 서버가 확인한 것만, 없으면 미구현으로 보인다. 5초 폴링.
import { useState } from "react";
import { api } from "../api";
import type { CellState, LiveCheckState, LiveSecurityReport, MatrixRow, SecArea, SecRow, SecState, SecurityView } from "../security-types";
import { ErrorBox } from "./ErrorBox";
import { NotYet, usePoll404 } from "./Optional";

// 작업 Z18: 이전 한 건의 보안 표 (GET /migrations/:id/security).
// 서버가 확인한 값만 보여 준다. 확인할 재료가 없는 칸은 서버가 "미구현"으로 보낸다 (화면이 지어내지 않음)

const AREA_LABEL: Record<SecArea, string> = {
  temp_credentials: "임시 자격",
  least_privilege: "최소 권한",
  audit: "감사 기록",
  secrets: "비밀값",
  runtime: "런타임",
  controls: "통제 매트릭스",
};
const AREAS = Object.keys(AREA_LABEL) as SecArea[];

// 색만으로 구분하지 않게 기호 + 글자를 같이 쓴다
const STATE: Record<SecState, { label: string; mark: string; cls: string }> = {
  ok: { label: "지켜짐", mark: "✓", cls: "tone-ok" },
  warn: { label: "약점", mark: "!", cls: "tone-wait" },
  fail: { label: "위반", mark: "✕", cls: "tone-bad" },
  not_implemented: { label: "미구현", mark: "…", cls: "sec-ni" },
  n_a: { label: "해당 없음", mark: "–", cls: "" },
};

export function StateChip(p: { s: SecState }) {
  const st = STATE[p.s];
  return <span className={`chip ${st.cls}`} data-state={p.s}><span aria-hidden="true">{st.mark}</span> {st.label}</span>;
}

// 작업 Z39: 매트릭스 칸. 근거 종류(정적·실측·없음)를 글자로 같이 쓴다 (정적 = 레포 파일 판정, 실 클라우드 스캔 아님)
const CELL: Record<CellState, { label: string; mark: string; cls: string }> = {
  pass: { label: "통과", mark: "✓", cls: "tone-ok" },
  attested: { label: "사람 확인", mark: "✓", cls: "tone-ok" },
  fail: { label: "위반", mark: "✕", cls: "tone-bad" },
  unknown: { label: "모름", mark: "?", cls: "tone-wait" },
  not_applicable: { label: "해당 없음", mark: "–", cls: "" },
};
const BASIS: Record<MatrixRow["basis"], string> = { static: "정적", measured: "실측", none: "근거 없음", n_a: "" };

export function ControlMatrix(p: { cells: MatrixRow[] }) {
  const sides = (["source", "target"] as const).filter((s) => p.cells.some((c) => c.side === s));
  const ids = [...new Set(p.cells.map((c) => c.controlId))];
  return (
    <div className="sec-scroll" data-testid="control-matrix">
      <table className="tbl sec-tbl sec-matrix">
        <thead><tr><th>통제</th>{sides.map((s) => {
          const k = p.cells.find((c) => c.side === s)!.envKind;
          return <th key={s}>{s === "source" ? "출발" : "도착"} {k}</th>;
        })}</tr></thead>
        <tbody>
          {ids.map((id) => {
            const first = p.cells.find((c) => c.controlId === id)!;
            return (
              <tr key={id} data-control={id}>
                <td><code>{id}</code><div className="small">{first.title}</div></td>
                {sides.map((s) => {
                  const c = p.cells.find((x) => x.controlId === id && x.side === s);
                  if (!c) return <td key={s} />;
                  const st = CELL[c.state];
                  return (
                    <td key={s} data-side={s} data-cell={c.state}>
                      <span className={`chip ${st.cls}`}><span aria-hidden="true">{st.mark}</span> {st.label}</span>
                      {BASIS[c.basis] && <span className="small muted"> {BASIS[c.basis]}</span>}
                      <div className="small muted">{c.reason}</div>
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// 작업 Z91: 실제 점검 (클라우드 읽기 API + k8s API). 못 읽은 칸은 서버가 "못 읽음"과 이유를 보낸다
const LIVE: Record<LiveCheckState, { label: string; mark: string; cls: string }> = {
  pass: { label: "통과", mark: "✓", cls: "tone-ok" },
  warn: { label: "약점", mark: "!", cls: "tone-wait" },
  fail: { label: "위반", mark: "✕", cls: "tone-bad" },
  unavailable: { label: "못 읽음", mark: "?", cls: "sec-ni" },
  n_a: { label: "해당 없음", mark: "–", cls: "" },
};
const CAT_LABEL: Record<string, string> = {
  public_ports: "공개 포트", storage_encryption: "저장소 암호화", tls: "TLS", iam: "과다 권한", secrets: "비밀값 노출",
};
const SIDE_LABEL = { source: "출발", target: "도착" } as const;

function LiveTable(p: { reports: LiveSecurityReport[] }) {
  const keys = [...new Set(p.reports.flatMap((r) => r.checks.map((c) => c.key)))];
  const sides = (["source", "target"] as const).map((s) => p.reports.find((r) => r.side === s) ?? null);
  return (
    <div className="sec-scroll">
      <table className="tbl sec-tbl" data-testid="security-live">
        <thead><tr><th>항목</th>{sides.map((r, i) => <th key={i}>{SIDE_LABEL[i ? "target" : "source"]} {r?.provider ?? ""}</th>)}</tr></thead>
        <tbody>
          {keys.map((k) => {
            const any = p.reports.flatMap((r) => r.checks).find((c) => c.key === k)!;
            return (
              <tr key={k} data-live={k}>
                <td>{any.title}<div className="small muted">{CAT_LABEL[any.category] ?? any.category}</div></td>
                {sides.map((r, i) => {
                  const c = r?.checks.find((x) => x.key === k);
                  if (!c) return <td key={i} className="small muted">—</td>;
                  const st = LIVE[c.state];
                  return (
                    <td key={i} data-state={c.state}>
                      <span className={`chip ${st.cls}`}><span aria-hidden="true">{st.mark}</span> {st.label}</span>
                      <div className="sec-val">{c.evidence}</div>
                      <div className="small muted">{c.resource} · <code>{c.source}</code></div>
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function LiveSection(p: { id: string; reports: LiveSecurityReport[] | null | undefined }) {
  const [fresh, setFresh] = useState<LiveSecurityReport[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  if (p.reports === undefined) return null;   // 실제 점검 전 서버
  const reports = fresh ?? p.reports;
  const run = async () => {
    setBusy(true); setErr(null);
    try { const r = await api.securityCheck(p.id); setFresh([r.source, r.target].filter((x): x is LiveSecurityReport => !!x)); }
    catch (e) { setErr(e); } finally { setBusy(false); }
  };
  return (
    <section className="sec-live" aria-label="실제 점검">
      <h4>실제 점검 (클라우드·k8s 읽기)</h4>
      {!reports ? <p className="small muted">서버에서 실제 점검이 꺼져 있음 (SEC_LIVE=0)</p> : (
        <>
          <div className="sec-sum">
            {reports.map((r) => (
              <span key={r.side} className="small">
                {SIDE_LABEL[r.side]} {r.provider}: ✓ {r.summary.pass} · ! {r.summary.warn} · ✕ {r.summary.fail} · ? {r.summary.unavailable}
                {r.origin === "snapshot" ? " (마지막 기록)" : ""}{r.reason ? ` — ${r.reason}` : ""}
              </span>
            ))}
          </div>
          <LiveTable reports={reports} />
        </>
      )}
      <button type="button" className="btn" onClick={run} disabled={busy} data-testid="security-live-run">
        {busy ? "점검 중…" : "지금 다시 점검하고 기록"}
      </button>
      {err ? <ErrorBox error={err} /> : null}
      <p className="small muted">읽기 명령만 씀(describe·get·list). 기록은 보안 회귀 비교에 쓰인다 — 출발 환경을 지우기 전에 한 번 눌러 둘 것.</p>
    </section>
  );
}

export function SecurityPanel(p: { id: string; live: boolean }) {
  // 진행 중이면 5초마다 다시 읽는다 (장부·감사가 바뀜). 끝난 이전은 한 번만. 404면 { v: null }
  const sec = usePoll404<SecurityView>(() => api.security(p.id), p.live ? 5000 : null, [p.id, p.live]);
  const [showNa, setShowNa] = useState(false);
  const [showMatrix, setShowMatrix] = useState(false);
  const v = sec.data?.v;

  if (sec.error) return <ErrorBox error={sec.error} />;
  if (!v) return <NotYet answered={!!sec.data} what="보안 표" />;

  const rows = showNa ? v.rows : v.rows.filter((r) => r.state !== "n_a");
  const s = v.summary;
  return (
    <div className="sec" data-testid="security-panel">
      <div className="sec-sum" aria-label="보안 표 요약">
        <span className="chip tone-ok">✓ 지켜짐 {s.ok}</span>
        <span className="chip tone-wait">! 약점 {s.warn}</span>
        <span className="chip tone-bad">✕ 위반 {s.fail}</span>
        <span className="chip sec-ni">… 미구현 {s.notImplemented}</span>
        <label className="small muted sec-na">
          <input type="checkbox" checked={showNa} onChange={(e) => setShowNa(e.target.checked)} /> 해당 없음 {s.na}개 보기
        </label>
      </div>
      <div className="sec-scroll">
        <table className="tbl sec-tbl">
          <thead><tr><th>상태</th><th>항목</th><th>결과</th><th>근거</th></tr></thead>
          <tbody>
            {AREAS.map((a) => {
              const rs = rows.filter((r) => r.area === a);
              if (!rs.length) return null;
              return [
                <tr key={a} className="sec-area"><th colSpan={4}>{AREA_LABEL[a]}</th></tr>,
                ...rs.map((r: SecRow) => (
                  <tr key={r.id} data-row={r.id}>
                    <td><StateChip s={r.state} /></td>
                    <td>{r.item}<div className="small muted">{r.scope}</div></td>
                    <td className="sec-val">{r.value}</td>
                    <td className="small muted">
                      {r.ref && <span className="sec-ref">{r.ref}</span>} <code>{r.source}</code>
                    </td>
                  </tr>
                )),
              ];
            })}
          </tbody>
        </table>
      </div>
      {v.controlMatrix && (
        <details className="sec-matrix-box" open={showMatrix} onToggle={(e) => setShowMatrix((e.target as HTMLDetailsElement).open)}>
          <summary>통제 {new Set(v.controlMatrix.map((c) => c.controlId)).size}개 × 환경 매트릭스 펼치기</summary>
          <ControlMatrix cells={v.controlMatrix} />
          <p className="small muted">정적 = 레포의 Terraform·권한 파일·차트를 읽어 판정 (배포하면 이렇게 됨). 실측 = 감사 체인 재계산. 모름 = 실 계정·실행 중 스캔이 필요한 칸.</p>
        </details>
      )}
      <LiveSection id={p.id} reports={v.live} />
      <p className="small muted">
        서버가 읽은 시각 {v.generatedAt.slice(11, 19)} UTC · 값(키·토큰·계정 번호)은 응답에 없음 · 감사 체인 {v.auditChain.checked}줄 다시 계산
      </p>
    </div>
  );
}
