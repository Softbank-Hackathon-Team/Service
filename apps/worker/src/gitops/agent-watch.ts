// W4: 온프레(agent-pull) 배포 확인. 워커는 온프레 클러스터에 들어가지 않는다 (ADR-005 D2)
//   커밋 뒤 → 고객 클러스터 안 Argo CD 가 당겨 적용 → Agent 가 Application 상태를 deploy 보고로 보냄 → 여기서 그 보고를 기다린다
//   짝짓기: 같은 환경 · app = argoAppName(b) · bundleHash = 우리가 민 커밋. applied = 성공, failed = 실패, 시간 안에 없으면 실패
// DRAFT(ai): 기본 켬 (2026-11-04 온프레 영역 결정). AGENT_DEPLOY_CONFIRM=0 이면 예전처럼 커밋만 하고 applied.
//   Agent 가 없는 온프레(예: 워커가 k3d 에 직접 까는 로컬 시연)는 600초 뒤 AGENT_DEPLOY_TIMEOUT 으로 실패하므로 0 으로 끈다 (오케스트레이터 영역 검토 전)
import { envNumber } from "@svc/contracts";
import { withTenant } from "@svc/core";
import { argoAppName, DELIVERY, type BundleRef } from "./bundle.js";
import { argoWatcherFromEnv, type ArgoDeps } from "./argo-watch.js";
import type { SyncWatcher, SyncWatchResult } from "./index.js";
import type { CommitResult } from "./repo.js";

export interface AgentDeployRow { status: "applied" | "failed"; reason?: string; receivedAt: string }
// 보고 찾기는 바꿔 끼울 수 있다 (시험은 고정 줄을 돌려준다)
export type AgentDeployLookup = (app: string, commit: string) => Promise<AgentDeployRow | null>;

export function dbAgentDeployLookup(tenantId: string, envId: string): AgentDeployLookup {
  return (app, commit) => withTenant(tenantId, async (tx) => {
    const r = await tx.query(
      `SELECT body->>'status' AS status, body->>'reason' AS reason, received_at
         FROM agent_reports
        WHERE env_id = $1 AND kind = 'deploy' AND body->>'app' = $2 AND body->>'bundleHash' = $3
        ORDER BY received_at DESC LIMIT 1`, [envId, app, commit]);
    const row = r.rows[0];
    if (!row || (row.status !== "applied" && row.status !== "failed")) return null;
    return { status: row.status, ...(row.reason ? { reason: String(row.reason) } : {}), receivedAt: new Date(row.received_at).toISOString() };
  });
}

export interface AgentWatchDeps { sleep?: (ms: number) => Promise<void>; now?: () => number }

export function agentPullWatcher(lookup: AgentDeployLookup, env: NodeJS.ProcessEnv = process.env, d: AgentWatchDeps = {}): SyncWatcher {
  // DRAFT(ai): 기다림 600초. 온프레 Argo 의 git 확인 주기(기본 약 3분) + Agent 주기(30초) + 파드 준비 시간
  const waitMs = envNumber(env.AGENT_DEPLOY_WAIT_SEC, 600) * 1000;
  const tickMs = envNumber(env.AGENT_DEPLOY_TICK_MS, 5000);
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = d.now ?? Date.now;
  return {
    async wait(b: BundleRef, c: CommitResult): Promise<SyncWatchResult> {
      const app = argoAppName(b);
      const t0 = now();
      for (let polls = 1; ; polls++) {
        const row = await lookup(app, c.commit);
        const observed = { source: "agent", app, polls, ms: now() - t0, revision: c.commit, ...(row ? { last: row.receivedAt } : {}) };
        if (row?.status === "applied") return { ok: true, observed };
        if (row?.status === "failed") return { ok: false, reason: `AGENT_DEPLOY_FAILED: ${app} ${c.commit.slice(0, 12)} ${row.reason ?? ""}`.trim(), observed };
        if (now() - t0 >= waitMs) {
          return { ok: false, reason: `AGENT_DEPLOY_TIMEOUT: ${Math.round(waitMs / 1000)}초 안에 ${app} 커밋 ${c.commit.slice(0, 12)} 의 Agent 배포 보고가 없다`, observed };
        }
        await sleep(tickMs);
      }
    },
  };
}

/** 배포 단계가 쓰는 반영 확인. argocd-push = Argo 폴링(예전 그대로), agent-pull = Agent 보고 기다림 (AGENT_DEPLOY_CONFIRM=0 이면 예전처럼 바로 ok) */
export function syncWatcherFor(ctx: { tenantId: string; targetEnvId: string }, env: NodeJS.ProcessEnv = process.env, d: ArgoDeps & AgentWatchDeps & { lookup?: AgentDeployLookup } = {}): SyncWatcher {
  const argo = argoWatcherFromEnv(env, d);
  if (env.MOCK_ARGO === "1" || env.AGENT_DEPLOY_CONFIRM === "0") return argo;
  const agent = agentPullWatcher(d.lookup ?? dbAgentDeployLookup(ctx.tenantId, ctx.targetEnvId), env, d);
  return { wait: (b, c) => (DELIVERY[b.env] === "agent-pull" ? agent.wait(b, c) : argo.wait(b, c)) };
}
