import type { AgentReport } from "@svc/contracts";
import { signReport } from "@svc/contracts/agent-sig";

// 시험용 고정 보고 (네트워크·클러스터 없이). 진짜 Agent 는 collect.ts(kubectl 읽기) + sender.ts(서명 POST), 실행은 tools/onprem-agent.ts
// 여기서는 고정 보고를 만들고 서명한 HTTP 요청 모양만 돌려준다 (네트워크 호출 없음)
export function stubOnpremAgent(o: { keyId: string; secret: string; version?: string }) {
  const agentVersion = o.version ?? "stub-0.0.0";
  const sign = (report: AgentReport, now: Date) => {
    const body = JSON.stringify(report);
    const ts = Math.floor(now.getTime() / 1000);
    return { headers: { keyId: o.keyId, signature: signReport(o.secret, ts, body), timestamp: String(ts) }, body };
  };
  return {
    heartbeat: (now: Date) => sign({
      kind: "heartbeat", agentVersion, sentAt: now.toISOString(), k3sVersion: "v1.33.5+k3s1 (STUB)",
      cnpg: { cluster: "app-db", ready: true, replicationLagBytes: 0 },
    }, now),
    security: (now: Date, falcoAlert = false) => sign({
      kind: "security", agentVersion, sentAt: now.toISOString(),
      findings: [
        { tool: "kyverno", toolCheckId: "stub_sec_vio_03", controlId: "SEC-VIO-03", resource: "k3s/ns/app",
          status: "pass", severity: "info", kind: "posture", observedAt: now.toISOString(), evidence: "STUB: privileged 0" },
        { tool: "falco", toolCheckId: "stub_terminal_shell", controlId: "SEC-VIO-04", resource: "k3s/ns/app/pod/web",
          status: falcoAlert ? "fail" : "pass", severity: falcoAlert ? "critical" : "info", kind: "threat",
          observedAt: now.toISOString(), evidence: falcoAlert ? "STUB: Terminal shell in container" : "STUB: 경보 없음" },
      ],
    }, now),
    deployed: (now: Date, migrationId: string, bundleHash: string) => sign({
      kind: "deploy", agentVersion, sentAt: now.toISOString(), migrationId, bundleHash,
      status: "applied", resources: ["Deployment/app/web", "Deployment/app/api", "Cluster/app/app-db"],
    }, now),
  };
}
