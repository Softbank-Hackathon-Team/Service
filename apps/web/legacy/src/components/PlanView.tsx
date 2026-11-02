// 표시 메모: 계획서. 계획 번호, 지문, 만료, 어댑터, 롤백 기준. 단계 표 6칸(단계, 누가, 예상, 관문·비율, 롤백 방법). 사전 점검 목록(등급, 번호, 문구, 고치는 법). tf·helm 해시.
import type { PlanDoc } from "../types";
import { LABEL, PLAN_STEP_STATUS } from "../status";

// 단계 이름은 상태 이름표(LABEL)에서 꺼낸다: provision → provisioning → "자원 생성"
const stepName = (id: string) => {
  const s = PLAN_STEP_STATUS[id as keyof typeof PLAN_STEP_STATUS];
  return s ? LABEL[s] : id;
};

export function PlanView({ plan }: { plan: PlanDoc }) {
  const expired = Date.parse(plan.expiresAt) <= Date.now();
  return (
    <div className="plan">
      <div className="kv">
        <span>계획 번호</span><code>{plan.planId}</code>
        <span>지문(planHash)</span><code title="승인 요청에 이 값을 그대로 보낸다">{plan.planHash}</code>
        <span>만료</span><span className={expired ? "bad" : ""}>{new Date(plan.expiresAt).toLocaleString()}{expired && " (만료됨)"}</span>
        <span>어댑터</span><span>{plan.adapterVersion}</span>
        <span>롤백 기준</span>
        <span>오류율 {plan.rollbackCriteria.errorRatePct}% 초과 또는 p95 {plan.rollbackCriteria.p95Multiplier}배, {plan.rollbackCriteria.windowSec}초 동안</span>
      </div>

      <h3>단계</h3>
      <table className="tbl">
        <thead><tr><th>#</th><th>단계</th><th>누가</th><th>예상</th><th>관문·비율</th><th>롤백 방법</th></tr></thead>
        <tbody>
          {plan.steps.map((s, i) => (
            <tr key={s.id}>
              <td>{i + 1}</td>
              <td>{stepName(s.id)}</td>
              <td>{s.owner}</td>
              <td>{s.estSec ? `${s.estSec}초` : "-"}</td>
              <td>{[s.gate, s.weights?.join("→") && `${s.weights!.join("→")}%`, s.holdSec && `각 ${s.holdSec}초`].filter(Boolean).join(" · ") || "-"}</td>
              <td className="small">{s.rollback ?? "-"}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3>사전 점검</h3>
      {plan.precheck.length === 0 ? <p className="muted">항목 없음</p> : (
        <ul className="pc">
          {plan.precheck.map((c) => (
            <li key={c.id}><span className={`chip lv-${c.level}`}>{c.level}</span> <code>{c.id}</code> {c.message}
              {c.fix && <div className="muted small">고치는 법: {c.fix}</div>}</li>
          ))}
        </ul>
      )}
      <p className="muted small">tfPlanHash {plan.tfPlanHash} · helmValuesHash {plan.helmValuesHash}</p>
    </div>
  );
}
