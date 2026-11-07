import type { AgentDeployProgress, AgentReport } from "@svc/contracts";
import type { CollectBase } from "./collect.js";

// W4: 클러스터 안 Argo CD Application 상태 → deploy 보고 (자동, agent-pull 배포 확인)
//   끝난 것: Synced + Healthy = applied, Degraded 또는 동기화 실패(operationState Failed·Error) = failed
//   #373 D2: progress 를 켜면 나머지(진행 중)도 progressing 으로 낸다. 무엇을 실제로 보낼지는 DeployReportGate 가 고른다
//   app = Application 이름 (설치 차트 ApplicationSet = 워커 argoAppName), bundleHash = Argo 가 본 커밋(status.sync.revision)
//   워커(apps/worker/src/gitops/agent-watch.ts)가 app + 커밋으로 짝짓는다
export type DeployReport = Extract<AgentReport, { kind: "deploy" }>;

interface ArgoResource {
  kind?: string; namespace?: string; name?: string; status?: string;
  health?: { status?: string; message?: string };
}
interface ArgoApp {
  metadata?: { name?: string };
  status?: {
    sync?: { status?: string; revision?: string };
    health?: { status?: string; message?: string };
    operationState?: { phase?: string; message?: string };
    resources?: ArgoResource[];
  };
}

const ref = (r: ArgoResource) => `${r.kind ?? "?"}/${r.namespace ?? ""}/${r.name ?? "?"}`.slice(0, 300);

/** 진행 중 앱의 Argo 상태. 기다리는 자원 = Healthy 가 아닌 첫 자원, 없으면 OutOfSync 인 첫 자원 */
export function argoProgress(a: ArgoApp): AgentDeployProgress {
  const res = a.status?.resources ?? [];
  const w = res.find((r) => r.health?.status && r.health.status !== "Healthy") ?? res.find((r) => r.status === "OutOfSync");
  const msg = a.status?.health?.message;
  return {
    sync: (a.status?.sync?.status || "Unknown").slice(0, 40),
    health: (a.status?.health?.status || "Unknown").slice(0, 40),
    ...(msg ? { message: msg.slice(0, 500) } : {}),
    ...(w ? { waitingOn: {
      resource: ref(w),
      ...(w.health?.status ? { health: w.health.status.slice(0, 40) } : {}),
      ...(w.status ? { sync: w.status.slice(0, 40) } : {}),
      ...(w.health?.message ? { message: w.health.message.slice(0, 500) } : {}),
    } } : {}),
  };
}

/** 사람이 읽는 한 줄 (reason 칸). 예: "Synced/Progressing — Cluster/app-shop/shop-db Progressing: Setting up primary" */
export function progressLine(p: AgentDeployProgress): string {
  const w = p.waitingOn;
  const head = `${p.sync}/${p.health}`;
  if (!w) return (p.message ? `${head} — ${p.message}` : head).slice(0, 2000);
  const state = [w.health, w.sync && w.sync !== "Synced" ? w.sync : undefined].filter(Boolean).join("·");
  return `${head} — ${w.resource}${state ? ` ${state}` : ""}${w.message ? `: ${w.message}` : p.message ? `: ${p.message}` : ""}`.slice(0, 2000);
}

export async function collectArgoDeploys(o: CollectBase & { argocdNamespace: string; tenant?: string; progress?: boolean }): Promise<DeployReport[]> {
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
    if (!applied && !failed && !o.progress) continue;
    const resources = (a.status?.resources ?? []).map(ref).slice(0, 200);
    const base = { kind: "deploy" as const, agentVersion: o.agentVersion, sentAt, app: name.slice(0, 253), bundleHash: rev.slice(0, 200), resources };
    if (!applied && !failed) {
      const progress = argoProgress(a);
      out.push({ ...base, status: "progressing", reason: progressLine(progress), progress });
      continue;
    }
    const reason = (a.status?.operationState?.message || a.status?.health?.message || `sync ${sync ?? "?"} health ${health ?? "?"}`).slice(0, 2000);
    out.push({ ...base, status: applied ? "applied" : "failed", ...(failed ? { reason } : {}) });
  }
  return out;
}

// #373 D2: 앱마다 무엇을 보낼지 고른다 (Agent 루프가 매 차례 부른다. 보내기에 성공했을 때만 sent 로 기억한다)
//   applied·failed: (커밋, 결과)가 바뀔 때만 (예전 그대로. 재시작하면 한 번 다시 보낸다 = 해롭지 않음)
//   progressing: 새 커밋이거나 끝난 상태에서 다시 진행 중이 되면 바로. 같은 커밋 안에서 상태(동기화·건강·기다리는 자원·메시지)가 바뀌면
//     앱마다 progressMinGapMs 에 한 번까지만 (메시지가 흔들려도 보고가 쌓이지 않게). 안 바뀌면 다시 보내지 않는다 (살아 있음은 heartbeat 가 말한다)
//   예전 API(progressing 을 모름)가 400 을 주면 progressBackoffMs 동안 progressing 을 안 보낸다 (applied·failed 는 계속)
// DRAFT(ai): 60초 / 10분. 60초 = 이 이슈가 정한 "최대 1분에 한 번", 10분 = 예전 API 에 붙은 새 Agent 가 400 을 10초마다 찍지 않게
export interface DeployGateOpts { now?: () => number; progressMinGapMs?: number; progressBackoffMs?: number }
interface Sent { key: string; status: DeployReport["status"]; bundleHash: string; at: number }

const keyOf = (r: DeployReport) => r.status === "progressing"
  ? `${r.bundleHash}:progressing:${JSON.stringify(r.progress ?? null)}` : `${r.bundleHash}:${r.status}`;

export class DeployReportGate {
  private readonly last = new Map<string, Sent>();
  private progressOffUntil = 0;
  private readonly now: () => number;
  private readonly gapMs: number;
  private readonly backoffMs: number;
  constructor(o: DeployGateOpts = {}) {
    this.now = o.now ?? Date.now;
    this.gapMs = o.progressMinGapMs ?? 60_000;
    this.backoffMs = o.progressBackoffMs ?? 600_000;
  }

  /** 이번 차례에 보낼 보고인가 */
  due(r: DeployReport): boolean {
    const app = r.app ?? "";
    const prev = this.last.get(app);
    if (r.status !== "progressing") return prev?.key !== keyOf(r);
    if (this.now() < this.progressOffUntil) return false;
    if (!prev || prev.bundleHash !== r.bundleHash || prev.status !== "progressing") return true;
    if (prev.key === keyOf(r)) return false;
    return this.now() - prev.at >= this.gapMs;
  }

  /** 보내기 성공 */
  sent(r: DeployReport): void {
    this.last.set(r.app ?? "", { key: keyOf(r), status: r.status, bundleHash: r.bundleHash, at: this.now() });
  }

  /** 보내기 실패. 예전 API 가 progressing 을 400 으로 거절하면 한동안 끈다. true = 지금 막 껐음 (로그 한 줄용) */
  rejected(r: DeployReport, httpStatus: number): boolean {
    if (r.status !== "progressing" || httpStatus !== 400) return false;
    this.progressOffUntil = this.now() + this.backoffMs;
    return true;
  }
}
