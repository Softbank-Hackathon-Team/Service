import { useState } from "react";
import { api, HttpError } from "../api";
import { AgentReviewPanel } from "../components/AgentReviewPanel";
import { ErrorBox } from "../components/ErrorBox";
import { NeedMigration } from "./NeedMigration";

// Z83-05: "AI 점검 돌리기". 결과 보기(GET agent-review) + 장애 점검 실행(POST agent-review/run).
// 실행은 상태 머신을 안 바꾸고, 샌드박스에서 원인을 찾아 GitOps 수정안을 낸다. 허용 목록 게이트를 지나야 수정안이 나온다.

export function AgentPage(p: { migrationId?: string }) {
  const [task, setTask] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [accepted, setAccepted] = useState<{ runId: string; at: string } | null>(null);
  const [bump, setBump] = useState(0);
  if (!p.migrationId) return <NeedMigration what="AI 점검" />;
  const id = p.migrationId;

  const [kindDone, setKindDone] = useState<"remediate" | "spec_draft">("remediate");
  const run = (kind: "remediate" | "spec_draft") => async () => {
    setBusy(true); setErr(null);
    try {
      const r = await api.agentRun(id, task.trim() || undefined, kind);
      setAccepted({ runId: r.runId, at: new Date().toLocaleTimeString() }); setKindDone(kind);
      setBump((b) => b + 1);
    } catch (e) { setErr(e); }
    finally { setBusy(false); }
  };
  // Z90: 키 없음(409 LLM_KEY_MISSING)은 오류 상자 대신 한 줄로
  const keyMissing = err instanceof HttpError && err.status === 409 && err.body?.code === "LLM_KEY_MISSING";

  return (
    <div className="page pg-agent">
      <div className="card">
        <div className="card-head"><h3>장애 점검 실행</h3><span className="muted small">샌드박스(k3d)에서 원인 찾기 → 배포 파일 수정안 · 상태 머신은 안 건드림</span></div>
        <label className="field">
          점검 지시 (선택, 2000자까지)
          <textarea value={task} onChange={(e) => setTask(e.target.value.slice(0, 2000))} rows={3}
            placeholder="예: 도착 쪽 앱이 502 를 내. 원인을 찾고 Helm 값 수정안을 내 줘." />
        </label>
        <div className="actions">
          <button type="button" className="primary" onClick={run("remediate")} disabled={busy}>{busy ? "보내는 중…" : "장애 점검 실행"}</button>
          <button type="button" onClick={run("spec_draft")} disabled={busy} title="가져온 결과로 AI 명세 초안·위험 목록을 다시 만든다 (사람이 고르기 전엔 계획에 안 쓰임)">명세 초안 다시 만들기</button>
          {accepted && <span className="ok small">접수됨 · {kindDone === "spec_draft" ? "명세 초안" : "장애 점검"} run <code>{accepted.runId.slice(0, 8)}</code> · {accepted.at} — 아래 결과가 5초마다 새로 읽혀</span>}
        </div>
        {keyMissing
          ? <p className="bad small" data-testid="agent-key-missing">AI 키가 없어 못 돌려(LLM_KEY_MISSING). 서버 .env 에 ANTHROPIC_API_KEY 를 넣고 API 를 다시 띄워. 시험만 할 거면 FAKE_LLM=1.</p>
          : err ? <ErrorBox error={err} /> : null}
        <p className="muted small">AI 상태(실제 / 키 없음 / 가짜)는 아래 결과 칸 맨 위에 보여. 수정안은 사람이 보고 GitOps 에 반영해야 적용돼.</p>
      </div>
      <div className="card">
        <div className="card-head"><h3>AI 점검 결과</h3><span className="muted small">종류별 최신 실행 1건 · 기록 없으면 STUB 대본</span></div>
        <AgentReviewPanel key={`${id}:${bump}`} id={id} live={true} />
      </div>
    </div>
  );
}
