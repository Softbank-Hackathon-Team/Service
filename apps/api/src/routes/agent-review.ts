import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { QUEUES, LLM_KEY_MISSING, LLM_BUDGET_EXCEEDED, agentLlmStatusFromEnv, llmBudgetFromEnv, llmSpendView, type AgentLlmStatus, type LlmSpendView } from "@svc/contracts";
import { boss, asBossDb, jobKey, parseJobData, writeAudit, DomainError, NotFound, withTenant, type Tx } from "@svc/core";
import { errors } from "./responses.js";

// 작업 Z58: 데모 S7 "AI 점검 결과"를 화면에서 보여 주는 읽기 전용 경로.
// agent-worker 가 agent_runs·agent_steps 표(db/migrations/0006)에 남긴 것을 읽는다. 상태를 바꾸지 않고 감사도 남기지 않는다.
// API 는 @svc/agent 를 import 하지 않는다 (agent-worker 는 따로 배포되는 앱, API 에 LLM SDK 를 들이지 않는다)

const Usage = z.object({ input: z.number().int(), output: z.number().int() }).strict();
const Step = z.object({ seq: z.number().int(), tool: z.string(), ok: z.boolean(), note: z.string() }).strict();
const RunMeta = {
  // db = agent_runs 표에서 읽음 / stub = 표에 기록이 없어 대본(STUB) 실행 결과를 보여 줌
  source: z.enum(["db", "stub"]),
  runId: z.string().nullable(),
  status: z.enum(["queued", "running", "finished", "failed"]),
  model: z.string().nullable(),
  createdAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  reason: z.string().nullable(),
  usage: Usage,
  steps: z.array(Step),
};

// 장애 점검(remediate): 샌드박스에서 원인을 찾고 GitOps 수정안을 낸 결과
export const RemediateReview = z.object({
  ...RunMeta,
  outcome: z.enum(["proposed", "no_change", "gave_up"]).nullable(),
  title: z.string(),
  rationale: z.string(),
  checked: z.array(z.string()),
  notDone: z.array(z.string()),
  gate: z.object({ ok: z.boolean(), violations: z.array(z.string()) }).strict().nullable(),
}).strict();

// 명세 초안(spec_draft): 가져오기 결과로 만든 위험 목록·계획 설명. 초안 판은 사람 검토 전
export const SpecDraftReview = z.object({
  ...RunMeta,
  version: z.number().int().nullable(),
  risks: z.array(z.object({
    id: z.string(), level: z.enum(["high", "medium", "low"]), title: z.string(), source: z.enum(["rule", "ai"]),
  }).strict()),
  planExplanation: z.string(),
  rejectedCount: z.number().int(),
}).strict();

// 작업 Z90: 이 서버 설정으로 AI 가 어떤 LLM 으로 도는지. 화면이 "키 없음"·"가짜(시험)" 를 그대로 보여 준다
export const AgentLlm = z.object({
  state: z.enum(["ready", "key_missing", "fake"]),
  model: z.string(),
  why: z.string(),
  // z75-64: 이 회사·이 회차의 실제 LLM 지출 (달러 추정). 화면 "AI 비용 $x / $상한". 표를 못 읽으면 없음
  spend: z.object({ round: z.string(), usd: z.number(), budgetUsd: z.number(), calls: z.number().int(), exceeded: z.boolean(),
    totalUsd: z.number().optional(), globalUsd: z.number().optional() }).strict().optional(),
}).strict();
export type AgentLlm = z.infer<typeof AgentLlm>;

export const AgentReview = z.object({
  migrationId: z.uuid(),
  llm: AgentLlm,
  remediate: RemediateReview.nullable(),
  specDraft: SpecDraftReview.nullable(),
}).strict();
export type AgentReview = z.infer<typeof AgentReview>;
export type RemediateReview = z.infer<typeof RemediateReview>;
export type SpecDraftReview = z.infer<typeof SpecDraftReview>;

// agent_runs.result 칸 모양. 모르는 칸이 있어도 깨지지 않게 느슨하게 읽는다
// remediate: agent-worker pg-agent-run-store.ts finish 가 { finish, gate } 를 넣는다 (작업 Z65)
const RemediateResult = z.object({
  finish: z.object({
    outcome: z.enum(["proposed", "no_change", "gave_up"]),
    title: z.string(), reason: z.string(),
    checked: z.array(z.string()), notDone: z.array(z.string()),
  }).nullable().optional(),
  gate: z.object({ ok: z.boolean(), violations: z.array(z.string()) }).optional(),
});
// spec_draft: pg-spec-draft-store.ts saveDraft 가 넣는 { version, risks, planExplanation, rejectedChanges }
const SpecDraftResult = z.object({
  version: z.number().int().optional(),
  risks: z.array(z.object({
    id: z.string(), level: z.enum(["high", "medium", "low"]), title: z.string(), source: z.enum(["rule", "ai"]),
  }).passthrough()).optional(),
  planExplanation: z.string().optional(),
  rejectedChanges: z.array(z.unknown()).optional(),
});

// 시험 전용 (작업 Z90): FAKE_LLM=1 일 때만 쓰인다. 기록이 없는 이전에 agent-worker 대본(DEMO_SCRIPT + stubSandbox) 실행 결과를 보여 준다.
// 실제 모드(기본)에서는 기록이 없으면 null = "아직 점검 안 함". 가짜 결과를 진짜처럼 내보내지 않는다.
// 값은 손으로 지은 게 아니라 handleAgentRun(stubDeps) 출력이다. 대본이 바뀌면 apps/api/test/agent-review.test.ts 가 깨진다
export const STUB_REMEDIATE: RemediateReview = {
  source: "stub", runId: null, status: "finished", model: "stub-scripted",
  createdAt: null, finishedAt: null, reason: "finish 호출",
  usage: { input: 9600, output: 640 },
  steps: [
    { seq: 1, tool: "sandbox_get", ok: true, note: "Deployment" },
    { seq: 2, tool: "sandbox_get", ok: true, note: "Pod" },
    { seq: 3, tool: "sandbox_logs", ok: true, note: "web" },
    { seq: 4, tool: "repo_read", ok: true, note: "deploy/web.yaml" },
    { seq: 5, tool: "repo_edit", ok: true, note: "deploy/web.yaml" },
    { seq: 6, tool: "sandbox_apply", ok: true, note: "deploy/web.yaml" },
    { seq: 7, tool: "run_check", ok: true, note: "check_ok" },
    { seq: 8, tool: "finish", ok: true, note: "proposed" },
  ],
  outcome: "proposed",
  title: "web 메모리 상한 128Mi→512Mi",
  // Z46 웹 병합(2c): Z22 대본이 바뀌어(Pod 확인 1단계 추가, 문구 "대본") handleAgentRun 출력으로 다시 맞춤
  rationale: "OOMKilled 로 재시작. 상한을 올린 뒤 샌드박스 60초 재시작 0 (대본)",
  checked: ["샌드박스 60초 재시작 0"],
  notDone: ["운영 부하에서의 메모리 사용량"],
  gate: { ok: true, violations: [] },
};

// DB 에서 읽은 줄 (시험에서 바꿔 끼울 수 있게 모양을 따로 둔다)
export interface RunRow {
  id: string; kind: "remediate" | "spec_draft"; status: RemediateReview["status"]; model: string | null;
  result: unknown; reason: string | null; usage: unknown; created_at: Date | string; finished_at: Date | string | null;
  steps: { seq: number; tool: string; ok: boolean; note: string }[];
}
export interface AgentReviewInput { migrationExists: boolean; runs: RunRow[] }

const iso = (d: Date | string | null) => (d == null ? null : new Date(d).toISOString());
const usageOf = (u: unknown) => {
  const p = Usage.safeParse(u);
  return p.success ? p.data : { input: 0, output: 0 };
};
function meta(r: RunRow) {
  return {
    source: "db" as const, runId: r.id, status: r.status, model: r.model,
    createdAt: iso(r.created_at), finishedAt: iso(r.finished_at), reason: r.reason,
    usage: usageOf(r.usage), steps: r.steps,
  };
}

// 종류별로 가장 최근 실행 한 건씩. 기록이 없으면 null (FAKE_LLM=1 시험 때만 remediate 에 대본 결과)
const DEFAULT_LLM: AgentLlm = { state: "key_missing", model: "claude-sonnet-5-5", why: "설정 안 읽음" };
export function buildAgentReview(migrationId: string, runs: RunRow[],
  opts: { stub?: boolean; llm?: AgentLlm } = {}): AgentReview {
  const latest = (k: RunRow["kind"]) => runs.filter((r) => r.kind === k)
    .sort((a, b) => +new Date(b.created_at) - +new Date(a.created_at))[0];

  const rm = latest("remediate");
  let remediate: RemediateReview | null = opts.stub ? STUB_REMEDIATE : null;
  const llm = opts.llm ?? DEFAULT_LLM;
  if (rm) {
    const res = RemediateResult.safeParse(rm.result ?? {});
    const f = res.success ? res.data.finish ?? null : null;
    remediate = {
      ...meta(rm),
      outcome: f?.outcome ?? null, title: f?.title ?? "", rationale: f?.reason ?? "",
      checked: f?.checked ?? [], notDone: f?.notDone ?? [],
      gate: res.success ? res.data.gate ?? null : null,
    };
  }

  const sd = latest("spec_draft");
  let specDraft: SpecDraftReview | null = null;
  if (sd) {
    const res = SpecDraftResult.safeParse(sd.result ?? {});
    const d = res.success ? res.data : {};
    specDraft = {
      ...meta(sd),
      version: d.version ?? null,
      risks: (d.risks ?? []).map((x) => ({ id: x.id, level: x.level, title: x.title, source: x.source })),
      planExplanation: d.planExplanation ?? "",
      rejectedCount: d.rejectedChanges?.length ?? 0,
    };
  }
  return { migrationId, llm, remediate, specDraft };
}

export async function loadAgentReviewDb(tx: Tx, migrationId: string): Promise<AgentReviewInput> {
  const m = await tx.query(`SELECT 1 FROM migrations WHERE id=$1`, [migrationId]);
  if (m.rowCount === 0) return { migrationExists: false, runs: [] };
  let runs: Omit<RunRow, "steps">[];
  try {
    // 종류별 최신 한 건만 (DISTINCT ON). 인덱스 agent_runs_migration (migration_id, created_at DESC)
    runs = (await tx.query(
      `SELECT DISTINCT ON (kind) id, kind, status, model, result, reason, usage, created_at, finished_at
         FROM agent_runs WHERE migration_id=$1 ORDER BY kind, created_at DESC`, [migrationId])).rows;
  } catch (e) {
    if ((e as { code?: string }).code === "42P01") return { migrationExists: true, runs: [] }; // 표가 아직 없는 DB
    throw e;
  }
  const out: RunRow[] = [];
  for (const r of runs) {
    const steps = (await tx.query(
      `SELECT seq, tool, ok, note FROM agent_steps WHERE run_id=$1 ORDER BY seq LIMIT 40`, [r.id])).rows;
    out.push({ ...r, steps });
  }
  return { migrationExists: true, runs: out };
}

// ---- 작업 Z65: 장애 점검 시작 (POST /migrations/:id/agent-review/run) ----
// agent_runs 에 queued 한 줄 + agent-run 큐 작업을 같은 트랜잭션에 넣는다 (둘 중 하나만 남는 일이 없게)
// 상태 머신(advance)은 건드리지 않는다. 점검은 이전 상태와 상관없이 언제든 돌릴 수 있는 읽기·제안 작업이다
export const RunBody = z.object({
  // 작업 Z90: 어떤 AI 를 돌릴지. 비우면 remediate(장애 점검, 예전과 같음). spec_draft = 명세 초안 다시 만들기
  kind: z.enum(["remediate", "spec_draft"]).optional(),
  // 점검 요청 문장. 비우면 데모 기본 문장. LLM 에 들어가는 글이라 길이를 막는다 (spec_draft 는 안 씀)
  task: z.string().trim().min(1).max(2000).optional(),
}).strict();
export const RunAccepted = z.object({
  runId: z.uuid(), migrationId: z.uuid(), kind: z.enum(["remediate", "spec_draft"]), status: z.literal("queued"),
}).strict();
export type AgentRunKind = RunAccepted["kind"];
export type RunAccepted = z.infer<typeof RunAccepted>;
export const DEFAULT_REMEDIATE_TASK = "web 이 계속 재시작한다. 원인을 찾고 고칠 수 있으면 deploy/ 수정안을 내라";

// 큐 넣기를 바꿔 끼울 수 있게 (시험). 기본은 pg-boss, 같은 트랜잭션 연결로 넣는다
export type SendAgentJob = (tx: Tx, data: unknown, singletonKey: string | undefined) => Promise<string | null>;
const bossSend: SendAgentJob = (tx, data, singletonKey) =>
  boss.send(QUEUES.agentRun, data as object, { ...(singletonKey ? { singletonKey } : {}), db: asBossDb(tx) });

export const DEFAULT_SPEC_DRAFT_TASK = "가져오기 결과로 명세 초안·위험·계획 설명 만들기";
export async function startRemediateRun(tx: Tx, o: {
  tenantId: string; migrationId: string; requestId: string; actor: string; task?: string; send?: SendAgentJob; kind?: AgentRunKind;
}): Promise<RunAccepted> {
  const kind = o.kind ?? "remediate";
  // 이전 줄을 잠가 같은 이전에 대한 시작 요청을 한 줄로 세운다. 회사 벽 밖(남의 회사)이면 안 보여서 404
  const m = await tx.query(`SELECT 1 FROM migrations WHERE id=$1 FOR UPDATE`, [o.migrationId]);
  if (m.rowCount === 0) throw new NotFound("migration", o.migrationId);
  // DRAFT(ai): 같은 이전에 아직 안 끝난 점검이 있으면 409. LLM 비용이 두 번 드는 걸 막는다 (agent-run 큐는 재시도 0)
  const busy = (await tx.query(
    `SELECT id FROM agent_runs WHERE migration_id=$1 AND kind=$2 AND status IN ('queued','running')
      ORDER BY created_at DESC LIMIT 1`, [o.migrationId, kind])).rows[0];
  if (busy) throw new DomainError(409, "AGENT_RUN_IN_PROGRESS", `${kind} run ${busy.id} is still queued or running`);

  const runId = randomUUID();
  const task = kind === "spec_draft" ? DEFAULT_SPEC_DRAFT_TASK : o.task ?? DEFAULT_REMEDIATE_TASK;
  await tx.query(
    `INSERT INTO agent_runs (id, tenant_id, migration_id, kind, task) VALUES ($1,$2,$3,$4,$5)`,
    [runId, o.tenantId, o.migrationId, kind, task]);
  const data = parseJobData(QUEUES.agentRun, { tenantId: o.tenantId, requestId: o.requestId, agentRunId: runId });
  const jobId = await (o.send ?? bossSend)(tx, data, jobKey(QUEUES.agentRun, { agentRunId: runId }));
  if (!jobId) throw new DomainError(409, "JOB_NOT_CREATED", "agent-run job was not created");
  await writeAudit(tx, o.tenantId, {
    actor: o.actor, action: `agent.${kind}.requested`, target: o.migrationId, result: "ok",
    detail: { agentRunId: runId, jobId, taskChars: task.length },
  });
  return { runId, migrationId: o.migrationId, kind, status: "queued" };
}

export interface AgentReviewRouteOpts {
  // 시험에서 DB 없이 돌리려고 바꿔 끼운다. 기본은 회사 벽(withTenant) 안에서 DB 읽기
  load?: (tenantId: string, migrationId: string) => Promise<AgentReviewInput>;
  // 시험에서 큐 대신 끼운다 (Z65)
  send?: SendAgentJob;
  // 작업 Z90: LLM 상태를 읽을 환경변수 (시험에서 바꿔 끼운다). 기본 process.env
  llmEnv?: Record<string, string | undefined>;
  // z75-64: 지출 읽기 (시험에서 바꿔 끼운다). 기본은 DB llm_spend. load 를 바꿔 낀 DB 없는 시험에서는 기본으로 안 읽는다
  loadSpend?: (tenantId: string, round: string) => Promise<{ usd: number; calls: number; totalUsd?: number } | null>;
}

// z75-64: llm_spend 한 줄 읽기. 표가 없는 옛 DB(42P01)면 null
async function loadSpendDb(tenantId: string, round: string): Promise<{ usd: number; calls: number; totalUsd?: number } | null> {
  try {
    return await withTenant(tenantId, async (tx: Tx) => {
      const r = (await tx.query("SELECT usd, calls FROM llm_spend WHERE round = $1", [round])).rows[0];
      const t = (await tx.query("SELECT llm_spend_round_total($1) AS t", [round])).rows[0];
      return { usd: r ? Number(r.usd) : 0, calls: r ? r.calls : 0, totalUsd: Number(t.t) };
    });
  } catch (e) {
    // 42P01 표 없음, 42883 합 함수 없음 (옛 DB) → 표시 없음
    if (["42P01", "42883"].includes((e as { code?: string }).code ?? "")) return null;
    throw e;
  }
}

// 설정이 틀려도(예전 값 오타 등) 화면 경로가 500 이 되지 않게 key_missing 으로 보여 주고 이유를 적는다
export function agentLlmForApi(env: Record<string, string | undefined> = process.env): AgentLlm & { warnings: string[] } {
  try {
    const s: AgentLlmStatus = agentLlmStatusFromEnv(env, { keyFlag: true });
    return { state: s.state, model: s.model, why: s.why, warnings: s.warnings };
  } catch (e) {
    return { state: "key_missing", model: env.AGENT_MODEL?.trim() || "claude-sonnet-5-5", why: `AI 설정 오류: ${(e as Error).message}`, warnings: [] };
  }
}

export async function agentReviewRoutes(app: FastifyInstance, opts: AgentReviewRouteOpts = {}) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const load = opts.load ?? ((t: string, id: string) => withTenant(t, (tx: Tx) => loadAgentReviewDb(tx, id)));
  // 작업 Z90: 기본 = 실제 LLM. 기록이 없으면 null. 대본 결과는 FAKE_LLM=1(시험)일 때만 (예전 AGENT_REVIEW_STUB 기본 켬은 없앰)
  const llmFull = agentLlmForApi(opts.llmEnv ?? process.env);
  const llm: AgentLlm = { state: llmFull.state, model: llmFull.model, why: llmFull.why };
  for (const w of llmFull.warnings) app.log.warn({ setting: w }, "API 예전 LLM 설정 무시");
  const stub = llm.state === "fake";
  // z75-64: 지출 상한 (agent-worker 와 같은 LLM_BUDGET_USD·LLM_BUDGET_ROUND). 설정이 틀리면 상한 표시 없이 계속 (화면 경로 500 방지)
  const env = opts.llmEnv ?? process.env;
  const loadSpend = opts.loadSpend ?? (opts.load ? undefined : loadSpendDb);
  const spendOf = async (tenantId: string): Promise<LlmSpendView | undefined> => {
    if (!loadSpend || llm.state !== "ready") return undefined;
    let b;
    try { b = llmBudgetFromEnv(env); } catch (e) { app.log.warn({ err: (e as Error).message }, "LLM 지출 상한 설정 틀림"); return undefined; }
    const s = await loadSpend(tenantId, b.round);
    return s ? llmSpendView(b, s) : undefined;
  };

  r.get("/migrations/:id/agent-review", {
    schema: { params: z.object({ id: z.uuid() }), response: { 200: AgentReview, ...errors(400, 401, 404, 500) } },
  }, async (req, reply) => {
    const input = await load(req.tenantId, req.params.id);
    if (!input.migrationExists) throw new NotFound("migration", req.params.id); // 남의 회사 번호도 404
    reply.header("cache-control", "no-store");
    const spend = await spendOf(req.tenantId);
    return buildAgentReview(req.params.id, input.runs, { stub, llm: spend ? { ...llm, spend } : llm });
  });

  // 작업 Z65: 장애 점검 시작. 결과는 agent-worker 가 agent_runs 에 남기고, 위 GET 이 source:"db" 로 읽는다
  // Idempotency-Key 가 있으면 같은 키 두 번째 요청은 첫 응답(같은 runId)을 그대로 돌려준다 (공용 플러그인)
  r.post("/migrations/:id/agent-review/run", {
    schema: { params: z.object({ id: z.uuid() }), body: RunBody.nullish(),
      response: { 202: RunAccepted, ...errors(400, 401, 403, 404, 409, 500) } },
  }, async (req, reply) => {
    // 작업 Z90: 키가 없으면 큐에 넣지 않고 바로 거절한다 (워커가 어차피 LLM_KEY_MISSING 으로 실패). 가짜 결과도 만들지 않는다
    if (llm.state === "key_missing") throw new DomainError(409, LLM_KEY_MISSING, llm.why);
    // z75-64: 이 회차 지출이 상한 이상이면 큐에 안 넣는다 (워커도 같은 규칙으로 막지만, 원인을 바로 보이게)
    const spend = await spendOf(req.tenantId);
    if (spend?.exceeded) throw new DomainError(409, LLM_BUDGET_EXCEEDED,
      spend.usd >= spend.budgetUsd
        ? `AI 지출 상한 넘음: 회차 ${spend.round} $${spend.usd.toFixed(4)} / 상한 $${spend.budgetUsd} (LLM_BUDGET_USD·LLM_BUDGET_ROUND)`
        : `AI 지출 전체 상한 넘음: 회차 ${spend.round} 모든 회사 합 $${(spend.totalUsd ?? 0).toFixed(4)} / 전체 상한 $${spend.globalUsd} (LLM_BUDGET_GLOBAL_USD)`);
    return req.idempotent(reply, async (tx) => ({
      status: 202,
      body: await startRemediateRun(tx, {
        tenantId: req.tenantId, migrationId: req.params.id, requestId: req.id, actor: req.actor,
        task: req.body?.task, send: opts.send, kind: req.body?.kind,
      }),
    }));
  });
}
