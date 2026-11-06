import { readFileSync } from "node:fs";
import { WorkcopyError, type OpenWorkcopy, type Proposal, type WorkcopyFactory } from "./gitops-workcopy.js";
import { AgentRunJob, type AgentFinish, type AgentRunSandbox } from "@svc/contracts";
import { createLogger, type Logger } from "@svc/core";
import {
  gateChanges, llmErrorCode, runAgent, scriptedLlm, stubSandbox, KubeError,
  type LlmProvider, type RunResult, type Sandbox, type SandboxFactoryCtx, type StepRecord, type WorkingCopy,
} from "@svc/agent";

// agent-run 큐 처리기. DB·LLM·샌드박스는 주입한다 (시험은 DB 없이 돈다)
export interface AgentRunStore {
  // 회사 벽 안에서 실행 한 건을 다시 읽는다. 큐 내용은 믿지 않는다
  load(tenantId: string, agentRunId: string): Promise<{ status: string; task: string; repo: WorkingCopy } | null>;
  // queued → running. 이미 다른 워커가 가져갔으면 false (큐는 "적어도 한 번" 배달이라 같은 작업이 두 번 올 수 있다) (Z65)
  claim(tenantId: string, agentRunId: string): Promise<boolean>;
  step(tenantId: string, agentRunId: string, s: StepRecord): Promise<void>;
  finish(tenantId: string, agentRunId: string, r: RemediateFinish): Promise<void>;
}
// 작업 Z65: store.finish 인자. pg 저장소는 { finish, gate } 를 agent_runs.result 에 넣는다
// (apps/api/src/routes/agent-review.ts 의 RemediateResult 가 이 모양을 읽는다)
export interface RemediateFinish {
  state: RunResult["state"]; reason: string; model: string;
  finish: AgentFinish | null; gate: { ok: boolean; violations: string[] }; usage: RunResult["usage"];
  // Z90b: 게이트 통과 수정안을 올린 브랜치·커밋. 없으면 null, 올리다 실패하면 { error }
  proposal?: Proposal | { error: string } | null;
  // 이 실행이 받은 샌드박스. 화면은 k3d·vcluster 일 때만 샌드박스 확인으로 본다. 샌드박스를 만들기 전에 끝났으면 null
  sandbox: AgentRunSandbox | null;
}
// sandbox: 실행 한 건마다 새로 만든다 (memory 는 바로, k3d 는 네임스페이스 생성 + 씨앗 적용). 끝나면 dispose
// workcopy (Z90b): 있으면 작업 복사본을 진짜 GitOps 레포 deploy/ 에서 읽고, 게이트 통과 수정안을 브랜치에 커밋한다.
//   없으면 store.load 가 준 repo 를 쓴다 (시험)
export interface Deps {
  store: AgentRunStore; llm: LlmProvider; sandbox: (ctx: SandboxFactoryCtx) => Sandbox | Promise<Sandbox>;
  workcopy?: WorkcopyFactory;
  log?: Pick<Logger, "warn">;
}
const defaultLog = createLogger("agent-worker");

export async function handleAgentRun(raw: unknown, d: Deps) {
  const job = AgentRunJob.parse(raw);
  const run = await d.store.load(job.tenantId, job.agentRunId);
  if (!run || run.status !== "queued") return { skipped: true as const }; // 두 번 온 작업이면 아무것도 안 함
  if (!(await d.store.claim(job.tenantId, job.agentRunId))) return { skipped: true as const }; // 다른 워커가 먼저 잡음 (Z65)
  let wc: OpenWorkcopy | null = null;
  if (d.workcopy) {
    try { wc = await d.workcopy({ runId: job.agentRunId }); }
    catch (e) {
      const code = e instanceof WorkcopyError ? e.code : "GITOPS_READ_FAILED";
      await d.store.finish(job.tenantId, job.agentRunId, { state: "failed", reason: code, model: d.llm.model, finish: null,
        gate: { ok: true, violations: [] }, usage: { input: 0, output: 0 }, proposal: null, sandbox: null });
      return { skipped: false as const, state: "failed" as const, outcome: null, gateOk: true };
    }
  }
  const repo = wc?.repo ?? run.repo;
  const before = new Map(repo);
  let r: RunResult;
  let sandbox: Sandbox | null = null;
  try {
    sandbox = await d.sandbox({ tenantId: job.tenantId, runId: job.agentRunId, seed: before });
    r = await runAgent({
      llm: d.llm, sandbox, repo, task: run.task,
      onStep: (s) => d.store.step(job.tenantId, job.agentRunId, s),
    });
  } catch (e) {
    // LLM 오류(LLM_AUTH 등)·샌드박스 만들기 실패(SANDBOX_WRONG_CLUSTER 등)는 실패 이유 코드만 남긴다 (본문·키 없음)
    const code = e instanceof KubeError ? e.code : llmErrorCode(e);
    r = { state: "failed", reason: code, finish: null, steps: [], usage: { input: 0, output: 0 }, changedFiles: [] };
  } finally {
    // 일회용 샌드박스는 성공·실패와 상관없이 지운다. 지우기 실패는 경고로 남기고, 만료 청소(sweeper.ts)가 마무리한다 (#177)
    await sandbox?.dispose?.().catch((e: unknown) => (d.log ?? defaultLog).warn(
      { agent_run_id: job.agentRunId, namespace: sandbox?.namespace ?? null, err: (e as Error).message ?? String(e) }, "sandbox 지우기 실패"));
  }
  // PR은 에이전트가 아니라 플랫폼이 만든다. 게이트를 통과한 제안만 PR 후보가 된다
  const gate = r.finish?.outcome === "proposed" ? gateChanges(before, repo) : { ok: true, violations: [] };
  // Z90b: 게이트 통과 수정안만 GitOps 레포 새 브랜치에 커밋 (main 은 안 바뀜, 운영 반영은 사람이 PR 로)
  let proposal: RemediateFinish["proposal"] = null;
  try {
    if (wc && r.finish?.outcome === "proposed" && gate.ok) {
      const changed: WorkingCopy = new Map([...repo].filter(([k, v]) => before.get(k) !== v));
      proposal = await wc.propose(changed, r.finish.title).catch((e) => ({ error: e instanceof WorkcopyError ? e.code : "GITOPS_COMMIT_FAILED" }));
    }
  } finally { await wc?.dispose().catch(() => {}); }
  await d.store.finish(job.tenantId, job.agentRunId, {
    state: r.state, reason: r.reason, model: d.llm.model, finish: r.finish, gate, usage: r.usage, proposal, sandbox: sandbox?.mode ?? null });
  // GitHub PR 생성 API 는 아직 없음: proposal.pr = null, 사람이 브랜치로 PR 을 연다
  // TODO(human): DB 역할(app_agent) 분리는 db/migrations 0006 TODO 그대로 (지금은 app_user)
  return { skipped: false as const, state: r.state, outcome: r.finish?.outcome ?? null, gateOk: gate.ok };
}

// 메모리 저장소 (시험·DB 없는 데모용). 운영 경로는 pg-agent-run-store.ts (작업 Z65)
export function memoryStore(seed: Record<string, { status: string; task: string; repo: WorkingCopy }> = {}) {
  const runs = new Map(Object.entries(seed));
  const steps: StepRecord[] = [];
  const results: unknown[] = [];
  const store: AgentRunStore & { steps: StepRecord[]; results: unknown[] } = {
    steps, results,
    async load(_t, id) { return runs.get(id) ?? null; },
    async claim(_t, id) { const x = runs.get(id); if (!x || x.status !== "queued") return false; x.status = "running"; return true; },
    async step(_t, _id, s) { steps.push(s); },
    async finish(_t, id, r) { results.push(r); const x = runs.get(id); if (x) x.status = r.state; },
  };
  return store;
}

// 대본 LLM 의 데모 대본 (AGENT_LLM=scripted). memory·k3d 샌드박스 둘 다에서 같은 흐름이 돈다
// k3d 에서는 deploy/web.yaml 이 apps/agent-worker/scripts/fixtures/oom-web.yaml 모양이어야 맞는다 (memory: "128Mi" 문자열)
export const DEMO_SCRIPT = [
  { name: "sandbox_get", input: { kind: "Deployment", name: "web" } },
  { name: "sandbox_get", input: { kind: "Pod", name: null } },
  { name: "sandbox_logs", input: { pod: "web", tail: 50 } },
  { name: "repo_read", input: { path: "deploy/web.yaml" } },
  { name: "repo_edit", input: { path: "deploy/web.yaml", old: "memory: \"128Mi\"", new: "memory: \"512Mi\"" } },
  { name: "sandbox_apply", input: { path: "deploy/web.yaml" } },
  { name: "run_check", input: { check: "stability", seconds: 60 } },
  { name: "finish", input: { outcome: "propose", title: "web 메모리 상한 128Mi→512Mi",
      rationale: "OOMKilled 로 재시작. 상한을 올린 뒤 샌드박스 60초 재시작 0 (대본)",
      verified: ["샌드박스 60초 재시작 0"], not_verified: ["운영 부하에서의 메모리 사용량"] } },
];
// 작업 Z65: 워커는 deps 를 한 번 만들고 작업마다 다시 쓴다. scriptedLlm 은 호출 횟수를 속에 세서
// 두 번째 실행부터 대본이 바닥나 "finish 없이 종료"로 failed 가 됐다.
// 그래서 대본 위치를 대화 기록(assistant 턴 수)에서 구한다. 실행마다 대화가 새로 시작하므로 매번 처음부터 돈다
export function demoLlm(script = DEMO_SCRIPT, model = "stub-scripted"): LlmProvider {
  return {
    model,
    async create(req) {
      const i = req.messages.filter((m) => m.role === "assistant").length;
      const s = script[i];
      if (!s) return { content: [{ type: "text", text: "끝" }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 2 } };
      return { content: [{ type: "tool_use", id: `tu_${i + 1}`, name: s.name, input: s.input }],
        stop_reason: "tool_use", usage: { input_tokens: 1200, output_tokens: 80 } };
    },
  };
}

// 시험 전용 (Z90b: FAKE_LLM=1 일 때만 main.ts 가 씀): 점검할 고정 작업 복사본 (Z65). 데모 앱 scripts/fixtures/oom-web.yaml 한 개 (memory 상한 128Mi, k3d 샌드박스 씨앗과 같음)
// 번들 이미지처럼 파일이 없으면 같은 128Mi 상한의 최소 매니페스트로 대신한다 (memory 샌드박스는 이것만으로 돈다)
// TODO(human): 진짜는 GitOps 레포(GITOPS_REPO_URL)를 읽기 토큰으로 얕게 받아 deploy/ 아래만 올린다
const MIN_WEB_YAML = "kind: Deployment\nspec:\n  containers:\n    - image: reg.example/web@sha256:aa\n      resources:\n        limits:\n          memory: \"128Mi\"\n";
let demoWebYaml: string | null = null;
export function demoRepo(): WorkingCopy {
  if (demoWebYaml === null) {
    try { demoWebYaml = readFileSync(new URL("../scripts/fixtures/oom-web.yaml", import.meta.url), "utf8"); }
    catch { demoWebYaml = MIN_WEB_YAML; }
  }
  return new Map([["deploy/web.yaml", demoWebYaml]]);
}

// 시험 전용 의존성. 진짜 LLM 없이 데모 대본 + 메모리 샌드박스
export const stubDeps = (store: AgentRunStore): Deps => ({
  store, llm: demoLlm(), sandbox: stubSandbox,
});
