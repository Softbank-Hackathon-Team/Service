import { QUEUES } from "@svc/contracts";
import { boss, startBoss, withTenant, createLogger, withLogContext, contextFromJob, currentLogContext, assertConfig, logEffectiveConfig } from "@svc/core";
import { llmBudgetFromEnv } from "@svc/contracts";
import { llmFromEnv, remediateLlmFromEnv, sandboxFromEnv, cachedLlm, llmCacheConfigFromEnv, llmCallOptionsFromEnv, withLlmCacheTally, budgetedLlm,
  rehearsalFromEnv, hostAccessFromEnv, type LlmCallLogger, type LlmProvider } from "@svc/agent";
import { handleRehearsal } from "./handle-rehearsal.js";
import { pgSandboxRunStore } from "./pg-sandbox-run-store.js";
import { startSandboxSweeper } from "./sweeper.js";
import { pgLlmCacheStore } from "./pg-llm-cache-store.js";
import { pgLlmSpendStore } from "./pg-llm-spend-store.js";
import { DEMO_SCRIPT, memoryStore } from "./handle-agent-run.js";
import { pgAgentRunStore } from "./pg-agent-run-store.js";
import { gitopsWorkcopyFromEnv } from "./gitops-workcopy.js";
import { pgSpecDraftStore } from "./pg-spec-draft-store.js";
import { routeAgentRun, type AgentRunKind } from "./route.js";

// agent-worker: agent-run 큐와 sandbox-rehearsal 큐를 받는다. 클라우드 실행 권한(IRSA 등)을 주지 않는 별도 배포다
// LLM 공급자는 환경변수로 고른다 (키 값은 SDK가 직접 읽고, 여기서는 쓰지 않는다)
// 작업 Z90: 기본 = 실제 Claude API. 가짜는 FAKE_LLM=1(시험)만. 키가 없으면 워커는 뜨되 실행마다 LLM_KEY_MISSING 으로 실패한다
// Z81-09: 설정을 먼저 본다 (LLM·샌드박스 선택 전). 틀린 값을 하나씩이 아니라 한 번에 목록으로
assertConfig("agent-worker");
// Z81-10: 실제로 쓰는 설정 값 5개를 한 줄로 (rehearse 가 이 줄을 본다)
logEffectiveConfig("agent-worker");
const log = createLogger("agent-worker");
// 호출마다 비용·시간 한 줄 (글 내용·키 없음)
const onCall: LlmCallLogger = (rec) => (rec.ok ? log.info({ ...rec }, "llm call") : log.warn({ ...rec }, "llm call failed"));
const choice = llmFromEnv(process.env, { onCall });
log.info({ provider: choice.provider, model: choice.model, why: choice.why }, "agent-worker LLM");
// 점검·수정(remediate): LLM 은 위와 같은 규칙, SANDBOX_MODE=memory|k3d
const rLlm = remediateLlmFromEnv(DEMO_SCRIPT, process.env, { onCall });
const rSbx = sandboxFromEnv();
log.info({ llm: rLlm.mode, model: rLlm.model, why: rLlm.why, sandbox: rSbx.describe }, "agent-worker remediate");
// 리허설 (deploying 안, 커밋 전): MOCK_SANDBOX=1 이면 정해진 결과, 그 밖은 플랫폼 클러스터 vCluster. LLM 을 쓰지 않는다
const rehearsal = rehearsalFromEnv();
log.info({ backend: rehearsal.describe }, "agent-worker rehearsal");
for (const w of new Set([...choice.warnings, ...rLlm.warnings])) log.warn({ setting: w }, "agent-worker 예전 LLM 설정 무시");
// z75-59: 실제 API 응답 캐시 (회사별, 기본 24시간). 실제 제공자일 때만 씌운다 (가짜·키 없음은 그대로). AGENT_LLM_CACHE=0 이면 끔
const cacheCfg = llmCacheConfigFromEnv();
const callCfg = choice.provider === "anthropic" ? llmCallOptionsFromEnv(process.env) : null;
const cacheStore = pgLlmCacheStore();
// z75-64: 실제 호출 지출 상한 (회사·회차 누적, 기본 $2). 캐시 안쪽에 씌워 캐시 응답은 0원. 넘으면 LLM_BUDGET_EXCEEDED 로 실패
const budget = llmBudgetFromEnv();
const spendStore = pgLlmSpendStore();
const withBudget = (llm: LlmProvider): LlmProvider => budgetedLlm(llm, {
  store: spendStore, tenantOf: () => currentLogContext().tenant_id, budgetUsd: budget.budgetUsd, round: budget.round, globalUsd: budget.globalUsd,
  onError: (where, e) => log.warn({ where, err: (e as Error).message?.slice(0, 200) }, "llm spend 표 오류"),
});
const withCache = (raw: LlmProvider, real: boolean, kind: string): LlmProvider => {
  if (!real) return raw;
  const llm = withBudget(raw);
  return cacheCfg.enabled ? cachedLlm(llm, {
    store: cacheStore, ttlSec: cacheCfg.ttlSec, tenantOf: () => currentLogContext().tenant_id,
    salt: `${kind}:effort=${callCfg?.effort ?? ""}`,
    onError: (where, e) => log.warn({ where, err: (e as Error).message?.slice(0, 200) }, "llm cache 오류 (실제 호출로 계속)"),
  }) : llm;
};
const specLlm = withCache(choice.llm, choice.provider === "anthropic", "spec_draft");
const remediateLlm = withCache(rLlm.llm, rLlm.mode === "real", "remediate");
log.info({ enabled: cacheCfg.enabled && (choice.provider === "anthropic" || rLlm.mode === "real"), ttl_sec: cacheCfg.ttlSec }, "agent-worker llm cache");
log.info({ budget_usd: budget.budgetUsd, global_budget_usd: budget.globalUsd, round: budget.round }, "agent-worker llm budget");
if (choice.provider === "key_missing") log.warn({ need: "ANTHROPIC_API_KEY" }, "AI 키 없음: 명세 초안·장애 점검 실행은 LLM_KEY_MISSING 으로 실패한다");

async function kindOf(tenantId: string, agentRunId: string): Promise<AgentRunKind | null> {
  try {
    return await withTenant(tenantId, async (tx) =>
      ((await tx.query("SELECT kind FROM agent_runs WHERE id=$1", [agentRunId])).rows[0]?.kind ?? null) as AgentRunKind | null);
  } catch (e) {
    if ((e as { code?: string }).code === "42P01") return null; // agent_runs 표가 아직 없으면 예전처럼 remediate STUB
    throw e;
  }
}

const deps = {
  kindOf,
  // remediate 저장은 Postgres(agent_runs·agent_steps·감사, 작업 Z65). 작업 복사본은 아직 STUB demoRepo() (TODO(human): GitOps 레포)
  // DRAFT(ai): AGENT_REMEDIATE_STORE=memory 면 예전 메모리 저장소 (표 없는 DB에서 띄울 때)
  // LLM·샌드박스는 env 로 고른 진짜 경로. 맥 단독 실행은 scripts/remediate-demo.ts
  remediate: {
    store: process.env.AGENT_REMEDIATE_STORE === "memory" ? memoryStore() : pgAgentRunStore(),
    llm: remediateLlm, sandbox: rSbx.create,
    // Z90b: 작업 복사본 = GitOps 레포 deploy/ (GITOPS_REPO_DIR|URL). 없으면 실행이 GITOPS_NOT_CONFIGURED. FAKE_LLM=1 시험만 고정 파일
    // 키 없음이면 GitOps 를 읽지 않는다 (실패 이유가 LLM_KEY_MISSING 으로 먼저 보이게)
    ...(rLlm.mode === "real" ? { workcopy: gitopsWorkcopyFromEnv() } : {}),
  },
  specDraft: { store: pgSpecDraftStore(), llm: specLlm },
};

await startBoss();
await boss.work(QUEUES.agentRun, async ([job]) =>
  // 로그 문맥: job_id·queue·tenant_id·agent_run_id (+ migration_id 가 있으면)
  withLogContext(contextFromJob(QUEUES.agentRun, job!.id, job!.data), async () => {
    const t0 = performance.now();
    try {
      // z75-59: 이 실행의 캐시 맞음·안 맞음을 센다 (저장소가 감사 detail.cache_hit 에 쓴다)
      const r = await withLlmCacheTally(() => routeAgentRun(job!.data, deps));
      log.info({ ...r, duration_ms: Math.round(performance.now() - t0) }, "agent-run finished");
    } catch (e) {
      log.error({ err: e, duration_ms: Math.round(performance.now() - t0) }, "agent-run failed");
      throw e;
    }
  }));
// 리허설 큐는 동시 1건 (core boss.ts: singleton + 키 하나). sandbox 노드에 한 번에 한 회사
const rehearsalDeps = { store: pgSandboxRunStore(), rehearse: rehearsal.rehearse };
await boss.work(QUEUES.sandboxRehearsal, async ([job]) =>
  withLogContext(contextFromJob(QUEUES.sandboxRehearsal, job!.id, job!.data), async () => {
    const t0 = performance.now();
    try {
      const r = await handleRehearsal(job!.data, rehearsalDeps);
      log.info({ ...r, duration_ms: Math.round(performance.now() - t0) }, "sandbox-rehearsal finished");
    } catch (e) {
      log.error({ err: e, duration_ms: Math.round(performance.now() - t0) }, "sandbox-rehearsal failed");
      throw e;
    }
  }));
// 만료 샌드박스 청소 (#177): 샌드박스 클러스터 접속 설정이 있을 때만 (vcluster·k3d). 시작 때 한 번 + 5분마다
const sweepHost = hostAccessFromEnv();
if (sweepHost) startSandboxSweeper(sweepHost.kube, log);
log.info("agent-worker ready");

process.on("SIGTERM", async () => { await boss.stop({ graceful: true }); process.exit(0); });
