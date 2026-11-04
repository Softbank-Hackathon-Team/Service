import type { AgentReport } from "@svc/contracts";
import type { CollectBase } from "./collect.js";

// W4: 클러스터 안 Argo CD Application 상태 → deploy 보고 (자동, agent-pull 배포 확인)
//   끝난 것만 보낸다: Synced + Healthy = applied, Degraded 또는 동기화 실패(operationState Failed·Error) = failed. 진행 중은 안 보낸다
//   app = Application 이름 (설치 차트 ApplicationSet = 워커 argoAppName), bundleHash = Argo 가 적용한 커밋(status.sync.revision)
//   워커(apps/worker/src/gitops/agent-watch.ts)가 app + 커밋으로 짝짓는다
export type DeployReport = Extract<AgentReport, { kind: "deploy" }>;

interface ArgoApp {
  metadata?: { name?: string };
  status?: {
    sync?: { status?: string; revision?: string };
    health?: { status?: string; message?: string };
    operationState?: { phase?: string; message?: string };
    resources?: Array<{ kind?: string; namespace?: string; name?: string }>;
  };
}

export async function collectArgoDeploys(o: CollectBase & { argocdNamespace: string; tenant?: string }): Promise<DeployReport[]> {
  const sentAt = (o.now?.() ?? new Date()).toISOString();
  const args = ["get", "applications.argoproj.io", "-n", o.argocdNamespace, ...(o.tenant ? ["-l", `svc.tenant=${o.tenant}`] : []), "-o", "json"];
  const apps = (JSON.parse(await o.kubectl(args)) as { items?: ArgoApp[] }).items ?? [];
  const out: DeployReport[] = [];
  for (const a of apps) {
    const name = a.metadata?.name, rev = a.status?.sync?.revision;
    if (!name || !rev) continue;
    const sync = a.status?.sync?.status, health = a.status?.health?.status, phase = a.status?.operationState?.phase;
    const applied = sync === "Synced" && health === "Healthy";
    const failed = !applied && (health === "Degraded" || phase === "Failed" || phase === "Error");
    if (!applied && !failed) continue;
    const reason = (a.status?.operationState?.message || a.status?.health?.message || `sync ${sync ?? "?"} health ${health ?? "?"}`).slice(0, 2000);
    out.push({
      kind: "deploy", agentVersion: o.agentVersion, sentAt, app: name.slice(0, 253), bundleHash: rev.slice(0, 200),
      status: applied ? "applied" : "failed",
      resources: (a.status?.resources ?? []).map((r) => `${r.kind ?? "?"}/${r.namespace ?? ""}/${r.name ?? "?"}`.slice(0, 300)).slice(0, 200),
      ...(failed ? { reason } : {}),
    });
  }
  return out;
}
