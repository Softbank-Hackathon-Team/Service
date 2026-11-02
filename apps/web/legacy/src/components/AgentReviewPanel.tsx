// 표시 메모: AI 점검 결과. 맨 위에 AI 상태(실제, 가짜, 키 없음, 비용 상한). 장애 점검: 출처, 결과, 게이트, 모델·토큰, 제목, 근거, 확인한 것, 못 한 것, 단계 목록.
//   명세 초안: 출처, 상태, 버전, 위험 목록, 계획 설명, 되돌린 변경 수. STUB 결과는 STUB 칩을 꼭 붙인다.
import { api } from "../api";
import type { AgentLlm, AgentReview, RemediateReview, SpecDraftReview } from "../agent-review-types";
import { ErrorBox } from "./ErrorBox";
import { NotYet, usePoll404 } from "./Optional";

// 작업 Z58: 데모 S7 "AI 점검 결과" (GET /migrations/:id/agent-review).
// 서버가 준 값만 보여 준다. 시험(FAKE_LLM=1)에서 서버가 대본 결과를 주면 "STUB" 칩을 꼭 붙인다 (진짜 실행으로 보이지 않게)

const TOOL_LABEL: Record<string, string> = {
  sandbox_get: "샌드박스 상태 보기",
  sandbox_logs: "로그 읽기",
  repo_read: "배포 파일 읽기",
  repo_edit: "배포 파일 고치기",
  sandbox_apply: "샌드박스에 적용",
  run_check: "안정성 확인",
  finish: "결론",
};
const OUTCOME: Record<NonNullable<RemediateReview["outcome"]>, { label: string; cls: string }> = {
  proposed: { label: "수정안 제안", cls: "tone-ok" },
  no_change: { label: "고칠 것 없음", cls: "" },
  gave_up: { label: "원인 못 찾음", cls: "tone-wait" },
};
const LEVEL: Record<SpecDraftReview["risks"][number]["level"], { label: string; cls: string }> = {
  high: { label: "높음", cls: "tone-bad" },
  medium: { label: "중간", cls: "tone-wait" },
  low: { label: "낮음", cls: "" },
};

function SourceChip(p: { source: "db" | "stub" }) {
  return p.source === "stub"
    ? <span className="chip sec-ni" data-source="stub" title="agent_runs 표에 기록이 없어 대본 LLM + 가짜 샌드박스 실행 결과를 보여 줌">STUB 대본</span>
    : <span className="chip tone-run" data-source="db">DB 기록</span>;
}
// 작업 Z90: AI 가 실제 LLM 인지, 키가 없어 못 도는지, 시험용 가짜인지 늘 맨 위에 보인다
function LlmBanner(p: { llm?: AgentLlm }) {
  const l = p.llm;
  if (!l) return null;
  if (l.state === "ready") return <p className="small" data-testid="agent-llm" data-llm="ready"><span className="chip tone-ok">실제 AI</span> {l.model}
    {l.spend && <span data-testid="agent-llm-spend" data-exceeded={l.spend.exceeded ? "1" : "0"} className={l.spend.exceeded ? "error" : "muted"}>
      {" "}· AI 비용 ${l.spend.usd.toFixed(2)} / ${l.spend.budgetUsd} (회차 {l.spend.round}{l.spend.totalUsd !== undefined ? `, 전체 $${l.spend.totalUsd.toFixed(2)} / $${l.spend.globalUsd}` : ""}{l.spend.exceeded ? ", 상한 넘어 새 점검 막힘" : ""})</span>}</p>;
  if (l.state === "fake") return <p className="small" data-testid="agent-llm" data-llm="fake"><span className="chip sec-ni">가짜 LLM(시험)</span> {l.why}</p>;
  return <div className="error" data-testid="agent-llm" data-llm="key_missing">AI 키 없음: 명세 초안·장애 점검을 돌릴 수 없어. {l.why}</div>;
}
const keyMissing = (reason: string | null) => !!reason && reason.includes("LLM_KEY_MISSING");
// z75-64: 지출 상한 이유는 사람 말로
const budgetOver = (reason: string | null) => !!reason && reason.includes("LLM_BUDGET_EXCEEDED");
const reasonText = (reason: string) => keyMissing(reason) ? "AI 키 없음 (LLM_KEY_MISSING)" : budgetOver(reason) ? "AI 지출 상한 넘음 (LLM_BUDGET_EXCEEDED)" : reason;
const tokens = (u: { input: number; output: number }) => `토큰 ${u.input.toLocaleString()} / ${u.output.toLocaleString()}`;

function Remediate(p: { r: RemediateReview }) {
  const r = p.r;
  const o = r.outcome ? OUTCOME[r.outcome] : null;
  return (
    <div className="air-block" data-testid="agent-remediate">
      <div className="sec-sum">
        <strong>장애 점검</strong>
        <SourceChip source={r.source} />
        {o ? <span className={`chip ${o.cls}`} data-outcome={r.outcome}>{o.label}</span>
          : <span className="chip">{r.status}</span>}
        {r.gate && (r.gate.ok
          ? <span className="chip tone-ok" data-gate="ok">✓ 게이트 통과</span>
          : <span className="chip tone-bad" data-gate="fail">✕ 게이트 위반 {r.gate.violations.length}</span>)}
        <span className="small muted">{r.model ?? "모델 없음"} · {tokens(r.usage)}</span>
      </div>
      {r.title && <p className="air-title">{r.title}</p>}
      {r.rationale && <p className="small">{r.rationale}</p>}
      {r.reason && r.status === "failed" && <div className="error">실패 이유: {reasonText(r.reason)}</div>}
      {r.gate && !r.gate.ok && <ul className="small bad">{r.gate.violations.map((v) => <li key={v}>{v}</li>)}</ul>}
      <div className="air-cols">
        <div>
          <div className="small muted">확인한 것</div>
          <ul className="small">{r.checked.length ? r.checked.map((x) => <li key={x}>✓ {x}</li>) : <li className="muted">없음</li>}</ul>
        </div>
        <div>
          <div className="small muted">못 한 것 (사람이 볼 것)</div>
          <ul className="small">{r.notDone.length ? r.notDone.map((x) => <li key={x}>… {x}</li>) : <li className="muted">없음</li>}</ul>
        </div>
      </div>
      {r.steps.length > 0 && (
        <ol className="air-steps small" aria-label="에이전트 단계">
          {r.steps.map((s) => (
            <li key={s.seq} data-tool={s.tool}>
              <span className={s.ok ? "ok" : "bad"} aria-hidden="true">{s.ok ? "✓" : "✕"}</span>{" "}
              {TOOL_LABEL[s.tool] ?? s.tool} <code className="muted">{s.tool}</code> <span className="muted">{s.note}</span>
            </li>
          ))}
        </ol>
      )}
      <p className="small muted">수정안은 PR 후보일 뿐이야. 운영 반영은 사람이 PR을 승인해야 돼.</p>
    </div>
  );
}

function SpecDraft(p: { d: SpecDraftReview }) {
  const d = p.d;
  return (
    <div className="air-block" data-testid="agent-spec-draft">
      <div className="sec-sum">
        <strong>명세 초안 위험 점검</strong>
        <SourceChip source={d.source} />
        <span className="chip">{d.status}</span>
        {d.version != null && <span className="chip tone-wait">v{d.version} DRAFT(ai) · 사람 검토 전</span>}
        <span className="small muted">{d.model ?? "모델 없음"} · {tokens(d.usage)}</span>
      </div>
      {d.reason && d.status === "failed" && <div className="error">실패 이유: {reasonText(d.reason)}</div>}
      {d.risks.length > 0 && (
        <ul className="small air-risks">
          {d.risks.map((x) => (
            <li key={x.id}>
              <span className={`chip ${LEVEL[x.level].cls}`}>{LEVEL[x.level].label}</span>{" "}
              <code>{x.id}</code> {x.title} <span className="muted">({x.source === "rule" ? "규칙" : "AI"})</span>
            </li>
          ))}
        </ul>
      )}
      {d.planExplanation && <p className="small">{d.planExplanation}</p>}
      {d.rejectedCount > 0 && <p className="small muted">가드가 되돌린 AI 변경 {d.rejectedCount}건</p>}
    </div>
  );
}

export function AgentReviewPanel(p: { id: string; live: boolean }) {
  // 진행 중이면 5초마다 다시 읽는다. 끝난 이전은 한 번만. 404면 { v: null }
  const rev = usePoll404<AgentReview>(() => api.agentReview(p.id), p.live ? 5000 : null, [p.id, p.live]);
  const v = rev.data?.v;

  if (rev.error) return <ErrorBox error={rev.error} />;
  if (!v) return <NotYet answered={!!rev.data} what="AI 점검 결과" />;
  if (!v.remediate && !v.specDraft) return (
    <div className="sec" data-testid="agent-review"><LlmBanner llm={v.llm} /><p className="muted">아직 AI 점검 기록이 없어.</p></div>);
  return (
    <div className="sec" data-testid="agent-review">
      <LlmBanner llm={v.llm} />
      {v.remediate && <Remediate r={v.remediate} />}
      {v.specDraft && <SpecDraft d={v.specDraft} />}
    </div>
  );
}
