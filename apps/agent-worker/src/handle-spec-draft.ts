import { AgentRunJob } from "@svc/contracts";
import { runSpecDraft, type DraftStep, type LlmProvider, type SpecDraftInput, type SpecDraftResult } from "@svc/agent";

// agent-run 큐 중 kind = "spec_draft" 처리기.
// 흐름: 실행 한 건을 DB에서 다시 읽음 → 읽기 전용 에이전트 실행 → 결과를 spec_versions 에 DRAFT(ai) 새 판으로 저장.
// 이 처리기는 상태(advance)를 바꾸지 않는다. 초안은 사람이 검토 화면에서 보고 고르기 전까지 계획에 쓰이지 않는다.
export interface SpecDraftStore {
  // 회사 벽 안에서 다시 읽는다. 큐 내용은 믿지 않는다
  load(tenantId: string, agentRunId: string): Promise<{ status: string; migrationId: string; input: SpecDraftInput } | null>;
  // queued → running. 이미 다른 워커가 가져갔으면 false (두 번 온 작업)
  claim(tenantId: string, agentRunId: string): Promise<boolean>;
  step(tenantId: string, agentRunId: string, s: DraftStep): Promise<void>;
  // 초안 저장: spec_versions 다음 판 + 위험·설명. baseVersion = 에이전트가 본 기준 판. 저장한 판 번호를 돌려준다
  saveDraft(tenantId: string, agentRunId: string, migrationId: string, r: SpecDraftResult, baseVersion: number): Promise<{ version: number }>;
  fail(tenantId: string, agentRunId: string, reason: string, usage: { input: number; output: number }): Promise<void>;
}
export interface SpecDraftDeps { store: SpecDraftStore; llm: LlmProvider }

export async function handleSpecDraft(raw: unknown, d: SpecDraftDeps) {
  const job = AgentRunJob.parse(raw);
  const run = await d.store.load(job.tenantId, job.agentRunId);
  if (!run || run.status !== "queued") return { skipped: true as const };
  if (!(await d.store.claim(job.tenantId, job.agentRunId))) return { skipped: true as const };
  // M6: claim 뒤 예외가 나면 running에 영원히 갇힌다(agent-run 큐는 재시도 0, 재시도가 있어도 queued가 아니라 건너뜀).
  // 그래서 예외도 failed로 적고 다시 던진다. 메시지 본문 대신 오류 이름만 남긴다 (요청 내용이 섞일 수 있어서, agent run.ts와 같은 원칙)
  let r: Awaited<ReturnType<typeof runSpecDraft>>;
  try {
    r = await runSpecDraft({
      llm: d.llm, input: run.input,
      onStep: (s) => d.store.step(job.tenantId, job.agentRunId, s),
    });
  } catch (e) {
    await failQuietly(d, job, `예외: ${errName(e)}`, { input: 0, output: 0 });
    throw e;
  }
  if (r.state === "failed") {
    await d.store.fail(job.tenantId, job.agentRunId, r.reason, r.usage);
    return { skipped: false as const, state: "failed" as const, reason: r.reason };
  }
  let version: number;
  try {
    ({ version } = await d.store.saveDraft(job.tenantId, job.agentRunId, run.migrationId, r.result, run.input.baseline.version));
  } catch (e) {
    await failQuietly(d, job, `초안 저장 실패: ${errName(e)}`, r.result.usage);
    throw e;
  }
  return {
    skipped: false as const, state: "finished" as const, version,
    risks: r.result.risks.length, rejected: r.result.rejectedChanges.length, model: r.result.model,
  };
}

const errName = (e: unknown) => (e instanceof Error ? e.name : typeof e);
// fail 자체가 실패해도(DB 끊김 등) 원래 예외를 가리지 않는다
async function failQuietly(d: SpecDraftDeps, job: { tenantId: string; agentRunId: string }, reason: string,
  usage: { input: number; output: number }) {
  await d.store.fail(job.tenantId, job.agentRunId, reason, usage).catch((e2) => console.error("[spec-draft] fail() 실패", errName(e2)));
}

// STUB: 메모리 저장소 (시험·DB 없는 데모용)
export function memorySpecDraftStore(seed: Record<string, { status: string; migrationId: string; input: SpecDraftInput }> = {}) {
  const runs = new Map(Object.entries(seed));
  const steps: DraftStep[] = [];
  const drafts: Array<{ migrationId: string; version: number; result: SpecDraftResult }> = [];
  const failures: string[] = [];
  const store: SpecDraftStore & { steps: typeof steps; drafts: typeof drafts; failures: typeof failures } = {
    steps, drafts, failures,
    async load(_t, id) { return runs.get(id) ?? null; },
    async claim(_t, id) { const x = runs.get(id); if (!x || x.status !== "queued") return false; x.status = "running"; return true; },
    async step(_t, _id, s) { steps.push(s); },
    async saveDraft(_t, id, migrationId, result) {
      const x = runs.get(id)!;
      const version = Math.max(x.input.baseline.version, ...drafts.filter((d) => d.migrationId === migrationId).map((d) => d.version)) + 1;
      drafts.push({ migrationId, version, result }); x.status = "finished";
      return { version };
    },
    async fail(_t, id, reason) { failures.push(reason); const x = runs.get(id); if (x) x.status = "failed"; },
  };
  return store;
}
