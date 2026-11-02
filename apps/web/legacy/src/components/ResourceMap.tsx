// 표시 메모: 자원 대응표 6칸(항목, 출발, 방법, 도착, 단계, 끝난 뒤 출발). 도착 칸에 Terraform 타입까지 보인다. 5초 폴링.
import { api, isApiDown } from "../api";
import type { EnvironmentView, MigrationStatus } from "../types";
import { isTerminal } from "../status";
import { usePoll } from "../usePoll";
import { ErrorBox } from "./ErrorBox";
import type { PlanResourcesView, StepState } from "../resourceMap";

// Z83-08: 계획서 칸 "출발 → 도착 자원 대응표" = 서버 GET /migrations/:id/plan/resources (Z86) 값.
// Z101: 예전 404 → 정적 표(staticRows) 대체는 지웠다. 서버 값이 없으면 오류를 그대로 보인다

const STATE_MARK: Record<StepState, { mark: string; cls: string; label: string }> = {
  todo: { mark: "○", cls: "", label: "예정" }, doing: { mark: "●", cls: "tone-run", label: "진행 중" },
  done: { mark: "✓", cls: "tone-ok", label: "끝" }, skipped: { mark: "–", cls: "", label: "건너뜀" }, undone: { mark: "↩", cls: "tone-wait", label: "되돌림" },
};

export function ResourceMap(p: { id: string; status: MigrationStatus; envs: EnvironmentView[]; sourceEnvId: string; targetEnvId: string }) {
  const done = isTerminal(p.status);
  const r = usePoll<PlanResourcesView>(() => api.planResources(p.id), done ? null : 5000, [p.id, p.status]);
  const srv = r.data;
  const src = p.envs.find((e) => e.id === p.sourceEnvId), dst = p.envs.find((e) => e.id === p.targetEnvId);
  if (!srv) {
    if (r.error && !isApiDown(r.error)) return <div className="rmap" data-testid="resource-map" data-source="error"><h4>자원 대응표</h4><ErrorBox error={r.error} /></div>;
    return <p className="muted small">자원 대응표 읽는 중…</p>;
  }
  const rows = srv.rows;
  return (
    <div className="rmap" data-testid="resource-map" data-source="server">
      <div className="card-head">
        <h4>자원 대응표 <span className="muted small">{src?.name ?? srv.source.name} → {dst?.name ?? srv.target.name}</span></h4>
        <span className="muted small">{srv.specKnown ? "서버 계획서 기준" : "서버 기준(명세 아직 없음)"}</span>
      </div>
      <table className="rmap-tbl">
        <thead><tr><th>항목</th><th>출발</th><th>어떻게</th><th>도착</th><th>단계</th><th>끝난 뒤 출발 쪽</th></tr></thead>
        <tbody>
          {rows.map((row) => {
            const st = STATE_MARK[row.stepState];
            return (
              <tr key={row.category} data-category={row.category}>
                <td className="rl">{row.label}</td>
                <td>{row.source ? <><b>{row.source.service}</b>{row.source.detail && <div className="muted small">{row.source.detail}</div>}</> : <span className="muted">—</span>}</td>
                <td className="muted small">{row.methodLabel}</td>
                <td>{row.target ? <><b>{row.target.service}</b>{row.target.detail && <div className="muted small">{row.target.detail}</div>}
                  {row.target.tfTypes && row.target.tfTypes.length > 0 && <div className="small"><code>{row.target.tfTypes.join(" ")}</code></div>}</> : <span className="muted">—</span>}</td>
                <td><span className={`chip ${st.cls}`}><span className="mk" aria-hidden="true">{st.mark}</span>{st.label}{row.step && <span className="muted small"> · {row.step}</span>}</span></td>
                <td className="muted small">{row.afterSource ?? "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
