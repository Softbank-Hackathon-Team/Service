// 표시 메모: 이전 상세, 제품의 중심. 위에서 아래로 긴 한 페이지이고 상태에 따라 칸이 켜진다.
//   머리: 번호, 큰 상태 칩, 경로, 버전, 갱신 시각, 리포트 링크, 상태 이름·설명, 실패 코드, 롤백 창 끝 시각, 할 일 버튼(명세 확정, 승인·거절, 실행 시작, 이어 가기), 비상 버튼.
//   진행: 15칸 레일, 이 화면에서 본 변화, 다음 가능한 상태, 새로고침 주기, 타임라인. 그 아래 계획서, 가동 중 앱, 비용, 보안, AI 점검 칸.
//   폴링: 워커 칸 0.7초, 사람 칸 1.5초, 끝나면 멈춤. 계획서 5초. 승인은 planHash 를 그대로 보낸다. 내부 상태 코드와 내부 설명이 그대로 보인다.
import { useEffect, useState } from "react";
import { api, HttpError, is404, or404 } from "../api";
import { usePoll } from "../usePoll";
import type { EnvironmentView, MigrationStatus, MigrationView, PlanDoc } from "../types";
import { VALID } from "../types";
import { HAS_PLAN, HUMAN_STEP, HUMAN_WAIT, LABEL, STATE_HINT, WORKER_PREP, isTerminal, markOf, toneOf } from "../status";
import { envNameOf, isMockEnv } from "../envs";
import { Stepper } from "./Stepper";
import { Timeline } from "./Timeline";
import { PlanView } from "./PlanView";
import { ErrorBox } from "./ErrorBox";
import { PrecheckResult } from "./PrecheckResult";
import { ResourceMap } from "./ResourceMap";
import { MockBadge } from "./MockBadge";
import { CostCompare } from "./CostCompare";
import { LiveTraffic } from "./LiveTraffic";
import { Loading } from "./Loading";
import { EmergencyActions } from "./EmergencyActions";
import { SecurityPanel } from "./SecurityPanel";
import { AgentReviewPanel } from "./AgentReviewPanel";
import { StatusChip } from "./StatusChip";
import { ReasonInput } from "./ReasonInput";
import { emergencyState } from "../emergency";

// DRAFT(ai): 폴링 간격. SSE가 생기면 지운다
//   워커가 일하는 칸: 0.7초 (빠른 칸을 덜 놓치게) / 사람이 누를 칸: 1.5초 / 끝난 상태: 멈춤
export const POLL_MS = { worker: 700, human: 1500 } as const;
export function pollMsFor(s: MigrationStatus | undefined): number | null {
  if (!s) return POLL_MS.human;
  if (isTerminal(s)) return null;
  if (HUMAN_STEP.includes(s) || HUMAN_WAIT.includes(s)) return POLL_MS.human;
  return POLL_MS.worker;
}

// 버튼을 누른 뒤 보여 줄 한 문장 (응답 JSON 대신)
const DONE_MSG: Record<string, string> = {
  "명세 확정": "명세를 확정했어. 워커가 사전 점검과 계획서를 만드는 중이야.",
  "승인": "승인했어. 이제 '실행 시작'을 누를 수 있어.",
  "거절": "거절했어. 명세나 계획을 고친 뒤 다시 계획을 만들 수 있어.",
  "실행 시작": "실행을 시작했어. 이제부터는 워커가 칸을 하나씩 옮겨.",
  "이어 가기": "이어 가기를 보냈어. 워커가 멈췄던 칸부터 다시 일해.",
  "롤백": "롤백을 시작했어. 워커가 트래픽을 출발 쪽 100%로 되돌리는 중이야.",
  "취소": "취소했어. 이 이전은 끝났고 환경 잠금도 풀렸어.",
};

// Z41: 할 일 칸 한 줄. 예전엔 paused·failed·rejected·stale·rolling_back 에서도 "워커가 일하는 중"이라고 나왔다
//   (paused·failed 는 워커가 멈추고 사람을 기다리는 상태라 반대 말이었다)
export function waitNote(m: Pick<MigrationView, "status" | "rollbackWindowEndsAt">, done: boolean): string {
  if (done) return "끝난 이전이야.";
  switch (m.status) {
    case "paused":
      return "일시 정지야. 워커가 멈추고 사람 판단을 기다려. 원인이 풀렸으면 '이어 가기', 문제가 보이면 아래 '롤백'으로 출발로 되돌려.";
    case "failed":
      return "실패해서 멈췄어. 위 실패 코드와 멈춘 칸을 보고, 남은 자원을 직접 정리한 뒤 아래 '취소'로 끝내.";
    case "rejected":
      return "계획을 거절했어. 다시 하려면 명세를 고쳐 새 계획을 만들거나, 아래 '취소'로 끝내.";
    case "stale":
      return "계획이 낡았어(만료됐거나 출발 환경이 바뀜). 새 계획을 만들거나 아래 '취소'로 끝내.";
    case "rolling_back":
      return "워커가 출발 쪽으로 되돌리는 중이야. 끝나면 '롤백 완료'가 돼.";
  }
  return emergencyState(m).rollback.allowed
    ? "지금은 워커가 일하는 중이야. 문제가 보이면 아래 '롤백'으로 되돌릴 수 있어."
    : "지금은 워커가 일하는 중이야. 사람이 누를 버튼이 없어.";
}

const fmtTime = (iso: string) => new Date(iso).toLocaleString("ko-KR", { hour12: false });

// inList: 서버 목록(GET /migrations)에 이 번호가 있나. false 면 404 의 뜻이 "회사 벽"이 아니라 "기록이 사라짐"일 가능성이 크다 (Z83-07, Jeong 23:32Z)
export function MigrationDetail(p: { id: string; envs: EnvironmentView[]; inList?: boolean; onNotFound?: (id: string) => void; onChanged: () => void; onClose: () => void }) {
  const [status, setStatus] = useState<MigrationStatus | undefined>(undefined);
  const mig = usePoll(() => api.getMigration(p.id), pollMsFor(status), [p.id], { keepOnError: false });
  const m = mig.data;
  const gone = is404(mig.error) && p.inList === false;
  useEffect(() => { if (gone) p.onNotFound?.(p.id); }, [gone]); // Z83-08
  useEffect(() => { if (m) setStatus(m.status); }, [m?.status]);

  const wantPlan = m ? HAS_PLAN.includes(m.status) : false;
  // 상태가 바뀔 때마다(version) 계획서를 다시 읽는다. 끝난 이전은 한 번만
  const plan = usePoll<PlanDoc | null>(wantPlan ? () => or404(api.latestPlan(p.id)) : null,
    m && isTerminal(m.status) ? null : 5000, [p.id, wantPlan, m?.version]);

  const [busy, setBusy] = useState<string | null>(null);
  const [actErr, setActErr] = useState<unknown>(null);
  const [reason, setReason] = useState("");
  const [ruleCleared, setRuleCleared] = useState(false);
  const [lastMsg, setLastMsg] = useState<{ text: string; at: MigrationStatus } | null>(null);

  // 이 화면에서 본 상태 변화 (폴링 사이에 지나간 칸은 서버 감사 기록 = 아래 타임라인에 있다)
  const [trail, setTrail] = useState<{ s: MigrationStatus; t: number }[]>([]);
  useEffect(() => {
    if (!m) return;
    const s = m.status;
    setTrail((tr) => (tr.at(-1)?.s === s ? tr : [...tr, { s, t: Date.now() }]));
  }, [m?.status]);

  const run = (name: string, f: () => Promise<unknown>) => async () => {
    setBusy(name); setActErr(null); setLastMsg(null);
    try {
      await f();
      await mig.reload(); await plan.reload(); p.onChanged();
      setLastMsg({ text: DONE_MSG[name] ?? `${name} 완료.`, at: (mig.data ?? m)?.status ?? "draft" });
    } catch (e) {
      setActErr(e);
      // Z83-12: 계획서가 그 사이 바뀌었으면(더 새 계획·지문 다름) 새 계획서를 바로 다시 읽어, 다음 승인은 새 지문으로 나간다
      if (e instanceof HttpError && e.status === 409 && (e.body?.code === "PLAN_SUPERSEDED" || e.body?.code === "PLAN_HASH_MISMATCH"))
        void plan.reload();
    } finally { setBusy(null); }
  };
  // "방금 한 일" 문장은 8초 뒤(상태가 바뀌면 그때부터 다시 8초) 내린다
  useEffect(() => {
    if (!lastMsg || !m) return;
    const t = setTimeout(() => setLastMsg(null), 8000);
    return () => clearTimeout(t);
  }, [lastMsg, m?.status]);

  // Z83: 증적 리포트(HTML)를 새 탭에. 회사 헤더가 필요해 일반 링크로는 못 연다
  const openReport = async () => {
    try {
      const html = await api.reportHtml(p.id);
      const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
      window.open(url, "_blank", "noopener");
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) { setActErr(e); }
  };

  if (!m) {
    const notFound = is404(mig.error);
    return (
      <div className="card">
        {mig.error ? (
          <>
            <h2>이전 <code className="muted">{p.id}</code></h2>
            {notFound && (p.inList === false
              ? <p>이 번호는 지금 목록에 없어. 서버를 다시 띄워 기록이 지워졌거나(모의 API 는 기록을 메모리에만 둬), 다른 회사 번호로 만든 이전이야. 화면이 마지막으로 보던 번호를 기억하고 있었을 뿐이야.</p>
              : <p>이 회사 번호로는 이 이전이 안 보여. 다른 회사 것이거나 지워진 것이야.</p>)}
            <ErrorBox error={mig.error} />
            <div className="actions"><button onClick={p.onClose}>선택 해제</button>{p.inList === false && <span className="muted small">왼쪽 목록에서 다른 이전을 고르면 돼.</span>}</div>
          </>
        ) : <Loading text="이전을 불러오는 중…" />}
      </div>
    );
  }
  const envName = (id: string) => envNameOf(p.envs, id, (x) => `${x.slice(0, 8)}…(목록에 없는 환경)`);
  const pd = plan.data;
  const done = isTerminal(m.status);
  const seen = trail;
  const tone = toneOf(m.status);
  const needsRuleCleared = m.status === "paused" && !m.failureCode;

  return (
    <div className="detail">
      {/* 머리: 가장 시끄러운 것 = 상태 이름 28px + 할 일 버튼 하나. 나머지는 12~14px */}
      <div className="card" id="sec-head">
        <div className="dhead">
          <h2>이전 <code>{m.id}</code></h2>
          <StatusChip status={m.status} big withCode />
        </div>
        <p className="muted meta">
          <span>{envName(m.sourceEnvId)} <span className="arrow">→</span> {envName(m.targetEnvId)}</span>
          {isMockEnv(p.envs, m.targetEnvId) && <MockBadge />}
          <span>· v{m.version}</span>
          {m.updatedAt && <span>· 갱신 {fmtTime(m.updatedAt)}</span>}
          <button className="link small" onClick={() => void openReport()} title="GET /migrations/:id/report?format=html">증적 리포트 열기</button>
        </p>
        <div className="state-head">
          <span className={`state-name tone-${tone}`} data-status={m.status}>
            <span className="mk" aria-hidden="true">{markOf(m.status)}</span>{LABEL[m.status]}
          </span>
          <span className="state-hint">{STATE_HINT[m.status]}</span>
        </div>
        {m.failureCode && <div className="error">실패 코드: <code>{m.failureCode}</code>{m.failedAtStatus && <> · 멈춘 칸 {LABEL[m.failedAtStatus]}</>}</div>}
        {m.status === "spec_review" && <PrecheckResult id={m.id} version={m.version} />}
        {m.rollbackWindowEndsAt && <p className="note">{LABEL.rollback_window} 끝: {fmtTime(m.rollbackWindowEndsAt)} — 그 전엔 아래 '롤백'으로 되돌릴 수 있어.</p>}
        <ErrorBox error={mig.error} />

        <div className="actions" aria-busy={!!busy}>
          {m.status === "spec_review" && (
            <button className="primary" disabled={!!busy} onClick={run("명세 확정", () => api.confirmSpec(m.id))}>
              명세 확정 → 사전 점검·계획 시작
            </button>
          )}
          {m.status === "awaiting_approval" && pd && (
            <>
              <ReasonInput value={reason} onChange={setReason} label="승인·거절 사유 (선택)" />
              <button className="primary" disabled={!!busy}
                onClick={run("승인", () => api.decide(pd.planId, "approve", pd.planHash, reason || undefined, pd.acknowledgements?.map((a) => a.id)))}>승인</button>
              <button className="danger" disabled={!!busy}
                onClick={run("거절", () => api.decide(pd.planId, "reject", pd.planHash, reason || undefined))}>거절</button>
              <span className="muted small why">아래 계획서를 보고 승인해야 '실행 시작' 버튼이 생겨. 승인 전 실행은 서버도 409로 막아.</span>
            </>
          )}
          {m.status === "awaiting_approval" && !pd && <Loading text="계획서를 불러오는 중…" />}
          {m.status === "approved" && (
            <button className="primary" disabled={!!busy || !pd} onClick={run("실행 시작", () => api.start(m.id, pd?.planHash))}>
              실행 시작 (Terraform)
            </button>
          )}
          {m.status === "paused" && (
            <>
              <ReasonInput value={reason} onChange={setReason} label="이어 가기 사유 (선택)" />
              {needsRuleCleared && (
                <label className="resume-ok" title="가드레일 규칙으로 멈춘 경우라 사람이 '풀렸다'고 확인해야 서버가 받는다 (ruleCleared)">
                  <input type="checkbox" checked={ruleCleared} onChange={(e) => setRuleCleared(e.target.checked)} /> 멈춘 규칙이 풀렸음을 확인
                </label>
              )}
              <button className="primary" disabled={!!busy || (needsRuleCleared && !ruleCleared)}
                onClick={run("이어 가기", () => api.resume(m.id, reason || undefined, needsRuleCleared ? ruleCleared : undefined))}>
                이어 가기 ({m.pausedFrom ? LABEL[m.pausedFrom] : "멈춘 칸"}부터)
              </button>
            </>
          )}
          {WORKER_PREP.includes(m.status) && (
            <Loading text="워커가 점검·계획 중이야. 끝나면 계획서와 승인 버튼이 나와." />
          )}
          {!HUMAN_STEP.includes(m.status) && !WORKER_PREP.includes(m.status) && (
            <span className="muted">
              {waitNote(m, done)}
            </span>
          )}
          {busy && <Loading text={`${busy} 중…`} />}
        </div>
        {/* 버튼 오류 상자는 .actions 바로 뒤에 둔다 (S e2e가 '.actions + .error'로 찾는다). 비상 버튼 오류도 여기 뜬다 */}
        <ErrorBox error={actErr} />
        {lastMsg && <p className="ok small">{lastMsg.text}</p>}
        {!done && (
          <>
            <h3 className="small muted" style={{ marginTop: 16, marginBottom: 6 }}>비상 버튼</h3>
            <EmergencyActions m={m} busy={busy} run={run} />
          </>
        )}
      </div>

      <div className="card" id="sec-progress">
        <div className="card-head">
          <h3>진행</h3>
          <span className="muted small">정상 경로 15칸 · 전체 상태 22개</span>
        </div>
        <Stepper m={m} />
        <div className="rail-foot">
          {seen.length > 1 && (
            <span className="trail" title="화면이 읽은 순간의 상태만 보여. 그 사이 지나간 칸은 아래 타임라인(서버 감사 기록)에 있어">
              이 화면에서 본 변화: {seen.map((x, i) => (
                <span key={i}>{i > 0 && " → "}{LABEL[x.s]}{i > 0 && <span className="t"> +{((x.t - seen[0]!.t) / 1000).toFixed(1)}초</span>}</span>
              ))}
            </span>
          )}
          <span>
            다음에 갈 수 있는 상태: {done ? "없음 (끝난 상태)" :
              VALID[m.status].map((s) => `${LABEL[s]}(${s})`).join(", ")}
          </span>
          <span>{done ? "자동 새로고침 멈춤" : `${(pollMsFor(m.status)! / 1000).toFixed(1)}초마다 새로고침`}</span>
        </div>
        <Timeline id={m.id} live={!done} version={m.version} />
      </div>

      {wantPlan && (
        <div className="card" id="sec-plan">
          <div className="card-head">
            <h3>계획서</h3>
            {pd && <span className="muted small">승인 요청은 지문(planHash)을 그대로 보낸다</span>}
          </div>
          <ErrorBox error={plan.error} />
          <ResourceMap id={m.id} status={m.status} envs={p.envs} sourceEnvId={m.sourceEnvId} targetEnvId={m.targetEnvId} />
          {pd ? <PlanView plan={pd} />
            : plan.loading ? <Loading text="계획서를 불러오는 중…" />
            : <p className="muted">계획서 없음 (아직 안 만들어졌거나 서버가 404).</p>}
        </div>
      )}

      <div className="two">
        <div className="card" id="sec-live">
          <div className="card-head"><h3>가동 중 앱</h3><span className="muted small">이전 동안 들어온 요청</span></div>
          <LiveTraffic id={m.id} done={done} status={m.status} planWeights={pd?.steps.find((st) => st.id === "shift")?.weights} />
        </div>
        <div className="card" id="sec-cost">
          <div className="card-head"><h3>비용 비교 <span className="tag-est">【추정】</span></h3><span className="muted small">출발 vs 도착 월 비용</span></div>
          <CostCompare id={m.id} />
        </div>
      </div>

      <div className="card" id="sec-security">
        <div className="card-head"><h3>보안</h3><span className="muted small">임시 자격 · 최소 권한 · 감사 체인 · 비밀값</span></div>
        <SecurityPanel id={m.id} live={!done} />
      </div>

      <div className="card" id="sec-agent">
        <div className="card-head"><h3>AI 점검 결과</h3><span className="muted small">샌드박스 원인 분석 · 수정안 · 게이트</span></div>
        <AgentReviewPanel id={m.id} live={!done} />
      </div>
    </div>
  );
}
