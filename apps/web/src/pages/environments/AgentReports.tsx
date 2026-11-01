import { api, isApiDown } from "../../api";
import { usePoll } from "../../usePoll";
import { ErrorBox } from "../../components/ErrorBox";
import { ago } from "../common";

// Z101: 온프레 Agent 보고 (Z92 GET /environments/:id/agent-reports, packages/contracts/src/agent.ts AgentReportList 를 손으로 옮긴 것).
// Agent 가 서명해 보낸 것만 쌓인다(POST /agent/reports, HMAC). 화면은 읽기만 한다. 고정값 없음 — 보고가 없으면 없다고 쓴다
type Kind = "security" | "deploy" | "heartbeat";
interface Finding { severity?: string; status?: string; resource?: string; toolCheckId?: string }
type Report =
  | { kind: "security"; agentVersion: string; sentAt: string; findings: Finding[] }
  | { kind: "deploy"; agentVersion: string; sentAt: string; migrationId: string; bundleHash: string; status: "applied" | "failed"; resources: string[]; reason?: string }
  | { kind: "heartbeat"; agentVersion: string; sentAt: string; k3sVersion: string; cnpg: { cluster: string; ready: boolean; replicationLagBytes: number | null } | null };
interface ReportView { id: string; kind: Kind; keyId: string; sentAt: string; receivedAt: string; migrationId: string | null; report: Report }
export interface AgentReportList { envId: string; lastHeartbeatAt: string | null; stale: boolean; items: ReportView[] }

const KIND_LABEL: Record<Kind, string> = { heartbeat: "살아 있음", deploy: "배포", security: "보안" };

function summary(r: Report): string {
  if (r.kind === "heartbeat") {
    const c = r.cnpg;
    return `k3s ${r.k3sVersion}${c ? ` · DB ${c.cluster} ${c.ready ? "준비됨" : "준비 안 됨"}${c.replicationLagBytes !== null ? ` · 복제 지연 ${c.replicationLagBytes} B` : ""}` : " · DB 정보 없음"}`;
  }
  if (r.kind === "deploy") return `${r.status === "applied" ? "넣었음" : "실패"} · 자원 ${r.resources.length}개 · ${r.bundleHash.slice(0, 16)}${r.reason ? ` · ${r.reason}` : ""}`;
  const high = r.findings.filter((f) => f.status === "fail" && /high|critical/i.test(f.severity ?? "")).length;
  return `발견 ${r.findings.length}개${high ? ` (높음 ${high})` : ""}`;
}

export function AgentReports(p: { envId: string }) {
  const q = usePoll(() => api.agentReports(p.envId), 15000, [p.envId], { keepOnError: false });
  const d = q.data;
  return (
    <section className="card" id="env-agent" data-testid="agent-reports">
      <div className="card-head">
        <h2>온프레 Agent 보고</h2>
        {d && <span className="small" data-testid="agent-heartbeat" data-stale={d.stale ? "yes" : "no"}>
          {d.lastHeartbeatAt === null ? <span className="muted">아직 한 번도 안 옴</span>
            : <span className={d.stale ? "bad" : ""}>마지막 살아 있음 {ago(d.lastHeartbeatAt)}{d.stale ? " (끊김 의심)" : ""}</span>}
        </span>}
      </div>
      {q.loading && !d ? <p className="muted">읽는 중…</p>
        : q.error && !isApiDown(q.error) ? <ErrorBox error={q.error} />
        : d && d.items.length === 0 ? <p className="muted">받은 보고가 없어. 온프레 클러스터에 Agent 를 깔고 키를 주면 여기에 쌓여 (POST /api/v1/agent/reports).</p>
        : d ? (
          <table className="tbl">
            <thead><tr><th>종류</th><th>내용</th><th>이전</th><th>받은 때</th></tr></thead>
            <tbody>{d.items.map((it) => (
              <tr key={it.id} data-kind={it.kind}>
                <td>{KIND_LABEL[it.kind]}</td>
                <td className="small">{summary(it.report)}</td>
                <td>{it.migrationId ? <code className="small">{it.migrationId.slice(0, 8)}</code> : "—"}</td>
                <td className="small muted">{ago(it.receivedAt)}</td>
              </tr>
            ))}</tbody>
          </table>
        ) : null}
    </section>
  );
}
