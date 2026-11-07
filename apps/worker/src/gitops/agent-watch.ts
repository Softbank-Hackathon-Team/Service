// W4: 온프레(agent-pull) 배포 확인. 워커는 온프레 클러스터에 들어가지 않는다 (ADR-005 D2)
//   커밋 뒤 → 고객 클러스터 안 Argo CD 가 당겨 적용 → Agent 가 Application 상태를 deploy 보고로 보냄 → 여기서 그 보고를 기다린다
//   짝짓기: 같은 환경 · app = argoAppName(b) · bundleHash = 우리가 민 커밋. applied = 성공, failed = 실패, 시간 안에 없으면 실패
// DRAFT(ai): 기본 켬 (2026-11-04 온프레 영역 결정). AGENT_DEPLOY_CONFIRM=0 이면 예전처럼 커밋만 하고 applied.
//   Agent 가 없는 온프레(예: 워커가 k3d 에 직접 까는 로컬 시연)는 600초 뒤 AGENT_DEPLOY_TIMEOUT 으로 실패하므로 0 으로 끈다 (오케스트레이터 영역 검토 전)
import { envNumber } from "@svc/contracts";
import { withTenant } from "@svc/core";
import { argoAppName, DELIVERY, type BundleRef } from "./bundle.js";
import { argoWatcherFromEnv, type ArgoDeps } from "./argo-watch.js";
import { revisionMatcher } from "./revision-check.js";
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
//   D3 (#373): d.covers(GitopsRepo.revisionCovers)가 있으면 Agent 보고도 후손 리비전을 받는다 (withDescendantReports). 기다림마다 판정 캐시를 새로 만든다
export function syncWatcherFor(ctx: { tenantId: string; targetEnvId: string }, env: NodeJS.ProcessEnv = process.env,
    d: ArgoDeps & AgentWatchDeps & { lookup?: AgentDeployLookup; candidates?: AgentDeployCandidates } = {}): SyncWatcher {
  const argo = argoWatcherFromEnv(env, d);
  if (env.MOCK_ARGO === "1" || env.AGENT_DEPLOY_CONFIRM === "0") return argo;
  const exact = d.lookup ?? dbAgentDeployLookup(ctx.tenantId, ctx.targetEnvId);
  const candidates = d.candidates ?? (d.lookup ? undefined : dbAgentDeployCandidates(ctx.tenantId, ctx.targetEnvId));
  const lookupFor = (b: BundleRef): AgentDeployLookup =>
    candidates && d.covers ? withDescendantReports(exact, candidates, revisionMatcher(b, d.covers)) : exact;
  return { wait: (b, c) => (DELIVERY[b.env] === "agent-pull" ? agentPullWatcher(lookupFor(b), env, d).wait(b, c) : argo.wait(b, c)) };
}

// D3 (#373): 같은 커밋 보고가 없을 때 볼 후보 = 이 앱의 다른 리비전마다 가장 최근 보고.
//   후손 리비전은 우리 커밋 뒤에야 생기므로 우리 커밋 전의 낡은 보고가 후보로 받아질 일은 없다
// DRAFT(ai): 최근 리비전 5개까지 (판정은 리비전마다 git 한 번, 기다림 안에서 기억)
export type AgentDeployCandidates = (app: string, commit: string) => Promise<Array<AgentDeployRow & { rev: string }>>;

export function dbAgentDeployCandidates(tenantId: string, envId: string): AgentDeployCandidates {
  return (app, commit) => withTenant(tenantId, async (tx) => {
    const r = await tx.query(
      `SELECT rev, status, reason, received_at FROM (
         SELECT DISTINCT ON (body->>'bundleHash') body->>'bundleHash' AS rev, body->>'status' AS status, body->>'reason' AS reason, received_at
           FROM agent_reports
          WHERE env_id = $1 AND kind = 'deploy' AND body->>'app' = $2 AND body->>'bundleHash' IS DISTINCT FROM $3
          ORDER BY body->>'bundleHash', received_at DESC) x
        ORDER BY received_at DESC LIMIT 5`, [envId, app, commit]);
    return r.rows.flatMap((row) => (row.rev && (row.status === "applied" || row.status === "failed")
      ? [{ rev: String(row.rev), status: row.status as AgentDeployRow["status"], ...(row.reason ? { reason: String(row.reason) } : {}), receivedAt: new Date(row.received_at).toISOString() }]
      : []));
  });
}

/** D3 (#373): 같은 커밋 보고를 먼저 찾고, 없으면 후보 중 accept(후손 + 묶음 폴더 그대로)가 받는 가장 최근 보고. 판정 오류는 안 받음 (정확히 같은 커밋만) */
export function withDescendantReports(exact: AgentDeployLookup, candidates: AgentDeployCandidates,
    accept: (commit: string, rev: string) => Promise<boolean>): AgentDeployLookup {
  return async (app, commit) => {
    const row = await exact(app, commit);
    if (row) return row;
    for (const { rev, ...cand } of await candidates(app, commit)) {
      if (await accept(commit, rev).catch(() => false)) return cand;
    }
    return null;
  };
}
