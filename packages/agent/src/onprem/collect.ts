import { execFile } from "node:child_process";
import type { AgentReport, Finding } from "@svc/contracts";

// Z92: 온프레 Agent 의 모으기 쪽. 진짜 클러스터를 kubectl 로 읽어 보고 3종을 만든다.
//   heartbeat = k3s(쿠버네티스) 버전 + CloudNativePG Cluster 상태
//   security  = Kyverno PolicyReport 결과 → Finding (Kyverno 가 없으면 빈 목록 + unknown 한 줄)
//   deploy    = 이전이 넣은 Deployment 들이 다 준비됐는지 → applied / failed
// kubectl 실행은 바꿔 끼울 수 있다 (시험은 고정 JSON 을 돌려준다). 클러스터에 쓰는 명령은 없다 (get·version 만)
export type Kubectl = (args: string[]) => Promise<string>;

export function kubectlExec(o: { bin?: string; context?: string; timeoutMs?: number } = {}): Kubectl {
  const bin = o.bin ?? "kubectl";
  return (args) => new Promise((resolve, reject) => {
    const full = o.context ? ["--context", o.context, ...args] : args;
    execFile(bin, full, { timeout: o.timeoutMs ?? 15_000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`kubectl ${full.join(" ")}: ${String(stderr || err.message).trim().slice(0, 500)}`));
      else resolve(stdout);
    });
  });
}

export interface CollectBase { kubectl: Kubectl; agentVersion: string; now?: () => Date }
const iso = (o: CollectBase) => (o.now?.() ?? new Date()).toISOString();

// CNPG Cluster status 에서 준비됨 판단: readyInstances == instances 이고 phase 가 healthy
//   【사실】 CloudNativePG API 문서 ClusterStatus: instances, readyInstances, phase("Cluster in healthy state")
// 복제 지연 바이트는 Cluster status 에 없다 → null (psql 로 pg_stat_replication 을 읽는 건 DB 비밀이 필요해 Agent 범위 밖)
export async function collectHeartbeat(o: CollectBase & { namespace: string; cnpgCluster?: string }): Promise<AgentReport> {
  const v = JSON.parse(await o.kubectl(["version", "-o", "json"])) as { serverVersion?: { gitVersion?: string } };
  let cnpg: Extract<AgentReport, { kind: "heartbeat" }>["cnpg"] = null;
  if (o.cnpgCluster) {
    try {
      const c = JSON.parse(await o.kubectl(["get", "clusters.postgresql.cnpg.io", o.cnpgCluster, "-n", o.namespace, "-o", "json"])) as
        { status?: { instances?: number; readyInstances?: number; phase?: string } };
      const s = c.status ?? {};
      const ready = (s.instances ?? 0) > 0 && s.readyInstances === s.instances && /healthy/i.test(s.phase ?? "");
      cnpg = { cluster: o.cnpgCluster, ready, replicationLagBytes: null };
    } catch {
      // 클러스터가 없거나 CRD 가 없으면 "준비 안 됨" 으로 보고한다 (보고 자체는 보낸다)
      cnpg = { cluster: o.cnpgCluster, ready: false, replicationLagBytes: null };
    }
  }
  return { kind: "heartbeat", agentVersion: o.agentVersion, sentAt: iso(o),
    k3sVersion: v.serverVersion?.gitVersion ?? "unknown", cnpg };
}

// Kyverno PolicyReport (wgpolicyk8s.io/v1alpha2) results[] → Finding
//   result: pass | fail | warn | error | skip, severity: info|low|medium|high|critical (없을 수 있음)
interface PolicyResult { policy?: string; rule?: string; result?: string; severity?: string; message?: string;
  resources?: Array<{ kind?: string; name?: string; namespace?: string }> }
const SEV = new Set(["info", "low", "medium", "high", "critical"]);
// 정책 이름 → 통제 번호 (packages/security controls.ts). 레포의 온프레 정책(infra/permissions/onprem-kyverno-platform.yaml)
//   platform-namespace-pod-security = 파드 보안 기준(privileged·root 막기) → SEC-VIO-03. Kyverno 기본 정책 묶음 이름도 같이 맞춘다. 모르면 null
const CONTROL_OF: Record<string, string> = {
  "platform-namespace-pod-security": "SEC-VIO-03",
  "disallow-privileged-containers": "SEC-VIO-03", "require-run-as-nonroot": "SEC-VIO-03",
  "restrict-image-registries": "SEC-VIO-02",
};
export function policyReportsToFindings(json: string, observedAt: string): Finding[] {
  const list = JSON.parse(json) as { items?: Array<{ metadata?: { namespace?: string }; results?: PolicyResult[] }> };
  const out: Finding[] = [];
  for (const rep of list.items ?? []) {
    for (const r of rep.results ?? []) {
      if (r.result === "skip") continue;
      const res = r.resources?.[0];
      const ns = res?.namespace ?? rep.metadata?.namespace ?? "-";
      const status = r.result === "pass" ? "pass" : r.result === "fail" ? "fail" : "unknown";
      const sev = SEV.has(r.severity ?? "") ? r.severity as Finding["severity"] : status === "fail" ? "medium" : "info";
      out.push({
        tool: "kyverno", toolCheckId: `${r.policy ?? "?"}/${r.rule ?? "?"}`.slice(0, 200),
        controlId: CONTROL_OF[r.policy ?? ""] ?? null,
        resource: `k3s/ns/${ns}/${(res?.kind ?? "?").toLowerCase()}/${res?.name ?? "?"}`,
        status, severity: sev, kind: "posture", observedAt, evidence: (r.message ?? "").slice(0, 2000),
      });
      if (out.length >= 500) return out;
    }
  }
  return out;
}

export async function collectSecurity(o: CollectBase): Promise<AgentReport> {
  const now = iso(o);
  let findings: Finding[];
  try {
    findings = policyReportsToFindings(await o.kubectl(["get", "policyreports.wgpolicyk8s.io", "-A", "-o", "json"]), now);
  } catch (e) {
    // Kyverno 가 안 깔렸으면 PolicyReport CRD 가 없다 → "모름" 한 줄 (통과로 속이지 않는다)
    findings = [{ tool: "agent_script", toolCheckId: "kyverno_policyreport_read", controlId: null, resource: "k3s/cluster",
      status: "unknown", severity: "info", kind: "posture", observedAt: now,
      evidence: `PolicyReport 를 읽지 못함: ${(e as Error).message}`.slice(0, 2000) }];
  }
  return { kind: "security", agentVersion: o.agentVersion, sentAt: now, findings };
}

// 이전이 넣은 Deployment 들이 다 준비됐는지 본다. 하나라도 덜 됐으면 failed + 이유
export async function collectDeploy(o: CollectBase & { namespace: string; migrationId: string; bundleHash: string }): Promise<AgentReport> {
  const list = JSON.parse(await o.kubectl(["get", "deployments", "-n", o.namespace, "-o", "json"])) as
    { items?: Array<{ metadata?: { name?: string }; spec?: { replicas?: number }; status?: { availableReplicas?: number } }> };
  const items = list.items ?? [];
  const notReady = items.filter((d) => (d.status?.availableReplicas ?? 0) < (d.spec?.replicas ?? 1)).map((d) => d.metadata?.name ?? "?");
  const resources = items.map((d) => `Deployment/${o.namespace}/${d.metadata?.name ?? "?"}`).slice(0, 200);
  const failed = items.length === 0 || notReady.length > 0;
  return {
    kind: "deploy", agentVersion: o.agentVersion, sentAt: iso(o), migrationId: o.migrationId, bundleHash: o.bundleHash,
    status: failed ? "failed" : "applied", resources,
    ...(failed ? { reason: items.length === 0 ? `namespace ${o.namespace} 에 Deployment 없음` : `준비 안 됨: ${notReady.join(", ")}`.slice(0, 2000) } : {}),
  };
}
