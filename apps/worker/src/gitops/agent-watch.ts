// W4: 온프레(agent-pull) 배포 확인. 워커는 온프레 클러스터에 들어가지 않는다 (ADR-005 D2)
//   커밋 뒤 → 고객 클러스터 안 Argo CD 가 당겨 적용 → Agent 가 Application 상태를 deploy 보고로 보냄 → 여기서 그 보고를 기다린다
//   짝짓기: 같은 환경 · app = argoAppName(b) · bundleHash = 우리가 민 커밋. applied = 성공, failed = 실패, 시간 안에 없으면 실패
// DRAFT(ai): 기본 켬 (2026-11-04 온프레 영역 결정). AGENT_DEPLOY_CONFIRM=0 이면 예전처럼 커밋만 하고 applied.
//   Agent 가 없는 온프레(예: 워커가 k3d 에 직접 까는 로컬 시연)는 600초 뒤 AGENT_DEPLOY_TIMEOUT 으로 실패하므로 0 으로 끈다 (오케스트레이터 영역 검토 전)
import { AgentDeployProgress, envNumber } from "@svc/contracts";
import { withTenant } from "@svc/core";
import { argoAppName, DELIVERY, type BundleRef } from "./bundle.js";
import { argoWatcherFromEnv, type ArgoDeps } from "./argo-watch.js";
import { revisionMatcher } from "./revision-check.js";
import type { SyncWatcher, SyncWatchResult } from "./index.js";
import type { CommitResult } from "./repo.js";
import type { StopHint } from "../jobs/_stop-hint.js";
import { agentStaleSec } from "../jobs/verify-connection.js";

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

// ---- #373 D2: 진행 보고 · Agent 끊김 조기 멈춤 ----------------------------------------------------------
//   위 짝짓기(dbAgentDeployLookup 의 app + 커밋 술어)는 건드리지 않는다. 진행 보고·하트비트는 따로 읽어
//   (1) Agent 하트비트가 AGENT_OFFLINE_SEC 넘게 끊기면 600초를 다 기다리지 않고 AGENT_OFFLINE 으로 멈추고
//   (2) 멈출 때(시간 초과·끊김) 이유에 마지막 progressing 상태(예: CNPG Cluster 준비 대기)를 싣는다.
//   progressing 은 끝이 아니다: 짝짓기 lookup 은 applied·failed 만 돌려준다 (가장 최근 보고가 progressing 이면 null = 계속 기다림)
export interface AgentProgressRow extends AgentDeployProgress { receivedAt: string }
export type AgentProgressLookup = (app: string, commit: string) => Promise<AgentProgressRow | null>;
/** 그 환경의 마지막 Agent 하트비트 나이(초). 한 번도 없으면 null */
export type AgentHeartbeatLookup = () => Promise<number | null>;

export function dbAgentProgressLookup(tenantId: string, envId: string): AgentProgressLookup {
  return (app, commit) => withTenant(tenantId, async (tx) => {
    const r = await tx.query(
      `SELECT body->'progress' AS progress, received_at
         FROM agent_reports
        WHERE env_id = $1 AND kind = 'deploy' AND body->>'status' = 'progressing' AND body->>'app' = $2 AND body->>'bundleHash' = $3
        ORDER BY received_at DESC LIMIT 1`, [envId, app, commit]);
    const row = r.rows[0];
    // 본문은 받을 때 AgentReport 로 검사했다. 그래도 모양이 다르면 지어내지 않고 없음으로
    const p = row ? AgentDeployProgress.safeParse(row.progress) : null;
    return p?.success ? { ...p.data, receivedAt: new Date(row.received_at).toISOString() } : null;
  });
}

// 폐기된 키의 하트비트는 세지 않는다 (사전 점검 onpremAgentInfo·연결 확인과 같은 기준)
export function dbAgentHeartbeatLookup(tenantId: string, envId: string): AgentHeartbeatLookup {
  return () => withTenant(tenantId, async (tx) => {
    const r = await tx.query<{ age: number }>(
      `SELECT GREATEST(0, floor(extract(epoch FROM now() - r.received_at)))::int AS age
         FROM agent_reports r JOIN agent_keys k ON k.id = r.key_id AND k.revoked_at IS NULL
        WHERE r.env_id = $1 AND r.kind = 'heartbeat' ORDER BY r.received_at DESC LIMIT 1`, [envId]);
    return r.rows[0]?.age ?? null;
  });
}

// DRAFT(ai): 기본 = AGENT_STALE_SEC(기본 120초). 화면의 "끊김"·사전 점검 AGENT_HEARTBEAT_STALE 과 같은 순간에 멈춘다.
//   Agent 는 10초마다(#373 A3) 하트비트를 보내니 12번 연속 빠져야 멈춘다. 0 = 끔 (예전처럼 600초 기다림)
export const agentOfflineSec = (env: NodeJS.ProcessEnv = process.env) => {
  const v = envNumber(env.AGENT_OFFLINE_SEC, agentStaleSec(env));
  return Number.isFinite(v) && v > 0 ? v : 0;
};

/** 멈춘 이유 뒤에 붙이는 마지막 진행 상태. 예: "마지막 상태 Synced/Progressing: Cluster/app-shop/shop-db Progressing (Setting up primary), 03:05:10Z 보고" */
export function progressNote(p: AgentProgressRow | null): string {
  if (!p) return "이 커밋의 진행 보고 없음 (온프레 Argo 가 아직 커밋을 당기지 않았거나, Agent 가 못 봤거나, 진행 보고를 모르는 예전 Agent)";
  const w = p.waitingOn;
  const what = w ? `${w.resource} ${w.health ?? w.sync ?? "?"}${w.message ? ` (${w.message})` : ""}` : (p.message ?? "");
  return `마지막 상태 ${p.sync}/${p.health}${what ? `: ${what}` : ""}, ${p.receivedAt.slice(11, 19)}Z 보고`;
}

const heartbeatNote = (age: number | null) => (age === null ? "Agent 하트비트가 한 번도 오지 않았다" : `Agent 하트비트 ${age}초 전`);

// AGENT_OFFLINE·AGENT_DEPLOY_* 는 이유 앞머리에서 failureCode 가 된다 (deploy.ts, paused). core FAILURE_CODES 에는 아직 안 넣었다:
//   웹 시험(apps/web/test/stop-reason.test.ts)이 목록의 모든 코드에 웹 멈춤 문장(apps/web/src/lib/failure.ts)을 요구한다.
//   웹 문장을 넣는 변경에서 목록에도 같이 넣는다. 그때까지 웹은 "알 수 없는 사유" 머리 + 아래 도움말(missing·hint)을 그린다
/** 멈춤 화면 도움말 (detail 맨 위 missing·hint, 웹 stopHelpOf 가 그린다). 해당 없는 코드면 빈 객체 */
export function agentStopHint(code: string): Partial<StopHint> {
  if (code === "AGENT_OFFLINE") return {
    missing: ["온프레 Agent 하트비트 (AGENT_OFFLINE_SEC 안)"],
    hint: "온프레 Agent 신호가 끊겨 배포를 확인할 수 없어 멈췄습니다. 고객 서버에서 kubectl -n svc-agent get pods 로 Agent 파드가 도는지, VM 이 켜져 있는지, "
      + "플랫폼 API(443)로 나가는 네트워크가 되는지 확인한 뒤 재개해 주세요. 커밋은 이미 gitops 에 있어 재개하면 그 반영 보고를 다시 기다립니다.",
  };
  if (code === "AGENT_DEPLOY_TIMEOUT") return {
    hint: "정해진 시간 안에 온프레 앱이 Synced+Healthy 가 되지 않았거나 Agent 반영 보고가 오지 않았습니다. 멈춘 이유의 마지막 상태(기다리는 자원)와 Agent 하트비트를 고객 클러스터에서 확인한 뒤 재개해 주세요.",
  };
  return {};
}

export interface AgentWatchDeps {
  sleep?: (ms: number) => Promise<void>; now?: () => number;
  /** #373 D2: 없으면 끊김 조기 멈춤을 안 한다 (시험이 lookup 만 바꿔 끼울 때) */
  heartbeat?: AgentHeartbeatLookup;
  /** #373 D2: 없으면 멈춘 이유에 진행 상태를 안 싣는다 */
  progress?: AgentProgressLookup;
}

export function agentPullWatcher(lookup: AgentDeployLookup, env: NodeJS.ProcessEnv = process.env, d: AgentWatchDeps = {}): SyncWatcher {
  // DRAFT(ai): 기다림 600초. 온프레 Argo 의 git 확인 주기(설치 스크립트 ARGO_POLL, Argo 기본 약 3분) + Agent 주기(--every) + 파드 준비 시간
  //   #373 D2: Agent 가 끊기면 이 시간을 다 기다리지 않는다 (아래 AGENT_OFFLINE)
  const waitMs = envNumber(env.AGENT_DEPLOY_WAIT_SEC, 600) * 1000;
  const tickMs = envNumber(env.AGENT_DEPLOY_TICK_MS, 5000);
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = d.now ?? Date.now;
  const offlineSec = agentOfflineSec(env);
  // #373 D2: 하트비트 나이. 읽기 실패(DB 일시 오류)는 판단하지 않고 계속 기다린다 (새 멈춤 길을 만들지 않는다)
  const heartbeatAge = async (): Promise<number | null | undefined> => {
    if (!d.heartbeat || offlineSec <= 0) return undefined;
    try { return await d.heartbeat(); } catch { return undefined; }
  };
  const lastProgress = async (app: string, commit: string): Promise<AgentProgressRow | null | undefined> => {
    if (!d.progress) return undefined;
    try { return await d.progress(app, commit); } catch { return undefined; }
  };
  // 멈출 때만 진행 상태를 한 번 읽어 이유·observed 에 싣는다
  const stopWith = async (app: string, commit: string, head: string, age: number | null | undefined, observed: NonNullable<SyncWatchResult["observed"]>): Promise<SyncWatchResult> => {
    const p = await lastProgress(app, commit);
    const notes = [...(p !== undefined ? [progressNote(p)] : []), ...(age !== undefined ? [heartbeatNote(age)] : [])];
    return { ok: false, reason: notes.length ? `${head} — ${notes.join(" · ")}`.slice(0, 2000) : head,
      observed: { ...observed, ...(p ? { sync: p.sync, health: p.health } : {}) } };
  };
  return {
    async wait(b: BundleRef, c: CommitResult): Promise<SyncWatchResult> {
      const app = argoAppName(b);
      const t0 = now();
      for (let polls = 1; ; polls++) {
        const row = await lookup(app, c.commit);
        const observed = { source: "agent", app, polls, ms: now() - t0, revision: c.commit, ...(row ? { last: row.receivedAt } : {}) };
        if (row?.status === "applied") return { ok: true, observed };
        if (row?.status === "failed") return { ok: false, reason: `AGENT_DEPLOY_FAILED: ${app} ${c.commit.slice(0, 12)} ${row.reason ?? ""}`.trim(), observed };
        const age = await heartbeatAge();
        if (age === null || (age !== undefined && age > offlineSec)) {
          const gone = age === null ? "Agent 하트비트가 한 번도 오지 않았다" : `Agent 하트비트가 ${age}초째 없다 (기준 ${offlineSec}초)`;
          return stopWith(app, c.commit, `AGENT_OFFLINE: ${app} 커밋 ${c.commit.slice(0, 12)} 반영을 기다리는 중 ${gone}. Agent 파드·VM·네트워크를 확인하고 재개`, undefined, observed);
        }
        if (now() - t0 >= waitMs) {
          return stopWith(app, c.commit, `AGENT_DEPLOY_TIMEOUT: ${Math.round(waitMs / 1000)}초 안에 ${app} 커밋 ${c.commit.slice(0, 12)} 의 Agent 배포 보고가 없다`, age, observed);
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
  // #373 D2: 하트비트·진행 보고도 같은 환경(이 Agent 키의 환경)에서 읽는다. 시험이 lookup 만 바꿔 끼우면 DB 로 가지 않게 둘 다 끈다
  const heartbeat = d.heartbeat ?? (d.lookup ? undefined : dbAgentHeartbeatLookup(ctx.tenantId, ctx.targetEnvId));
  const progress = d.progress ?? (d.lookup ? undefined : dbAgentProgressLookup(ctx.tenantId, ctx.targetEnvId));
  // D3 (#373) 후손 보고(lookupFor) + D2 (#373) 하트비트·진행 보고를 한 감시에
  return { wait: (b, c) => (DELIVERY[b.env] === "agent-pull" ? agentPullWatcher(lookupFor(b), env, { ...d, heartbeat, progress }).wait(b, c) : argo.wait(b, c)) };
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
