// 표시 메모: Azure Mock 환경 카드. Mock 배지, 건강, 모의 환경 설명, 리전, 확인 시각, 자원 표(자원, 이름, 상태). 5초 폴링.
import { api, is404, isApiDown } from "../api";
import { usePoll } from "../usePoll";
import type { EnvironmentView, ResourceState } from "../types";
import { ErrorBox } from "./ErrorBox";
import { MockBadge } from "./MockBadge";

// Azure 도착 환경 카드. 서버 GET /environments/:id/status 가 Mock 실행기 결과를 준다
// (리소스 그룹·VNet·AKS·ACR 이름과 상태. 전부 가짜 값, 클라우드 호출 없음)
const TONE: Record<ResourceState, string> = {
  Succeeded: "tone-ok", Creating: "tone-run", Deleting: "tone-wait", Deleted: "", Failed: "tone-bad",
};
const SHORT: Record<string, string> = {
  azurerm_resource_group: "리소스 그룹", azurerm_virtual_network: "가상 네트워크",
  azurerm_kubernetes_cluster: "AKS 클러스터", azurerm_container_registry: "컨테이너 레지스트리",
};

export function AzureMockCard({ env }: { env: EnvironmentView }) {
  const st = usePoll(() => api.envStatus(env.id), 5000, [env.id]);
  const s = st.data;
  const missing = is404(st.error);
  return (
    <div className="card azure-mock" data-testid="azure-mock-card">
      <div className="dhead-mock">
        <h2>{env.name} <MockBadge /></h2>
        {s && <span className={`chip ${s.health === "healthy" ? "tone-ok" : "tone-wait"}`}>{s.health}</span>}
      </div>
      <p className="note">실제 Azure 계정 없이 도는 모의 환경이야. 계획·적용·상태는 진짜 번역 결과에 가짜 출력을 붙인 것.</p>
      {missing ? <p className="muted small">서버에 GET /environments/:id/status 가 아직 없어.</p>
        : isApiDown(st.error) ? <p className="muted small">API 응답 없음 — 마지막으로 읽은 값이야 (위 띠 참고).</p>
        : <ErrorBox error={st.error} />}
      {!s && !st.error && <p className="muted small">상태 읽는 중…</p>}
      {s && (
        <>
          <div className="kv">
            <span>리전</span><span><code>{s.region}</code></span>
            <span>마지막 확인</span><span className="small">{new Date(s.checkedAt).toLocaleTimeString()}</span>
          </div>
          <table className="tbl" style={{ marginTop: 8 }}>
            <thead><tr><th>자원</th><th>이름</th><th>상태</th></tr></thead>
            <tbody>
              {s.resources.map((r) => (
                <tr key={r.id} title={r.id}>
                  <td className="small">{SHORT[r.type] ?? r.type}</td>
                  <td><code>{r.name}</code></td>
                  <td><span className={`chip ${TONE[r.state]}`}>{r.state}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
