import { test } from "node:test";
import assert from "node:assert/strict";
import { adapterFor, normalizeV2, DEMO_INVENTORY } from "@svc/adapters";
import { mockDraftLlm, scriptedLlm, DRAFT_MARKER_KEY, type SpecDraftInput } from "@svc/agent";
import { handleSpecDraft, memorySpecDraftStore } from "../src/handle-spec-draft.js";
import { routeAgentRun } from "../src/route.js";
import { memoryStore, stubDeps } from "../src/handle-agent-run.js";

const T = "11111111-1111-4111-8111-111111111111";
const R = "66666666-6666-4666-8666-666666666666";
const M = "44444444-4444-4444-8444-444444444444";

// 진짜 어댑터의 discover(STUB)·가져오기 변환(normalizeV2) 결과로 입력을 만든다: AWS(ECS+RDS) → GCP
async function input(): Promise<SpecDraftInput> {
  const src = adapterFor("aws"), dst = adapterFor("gcp");
  const inv = await src.discover({ accountId: "dev", expiresAt: "" }, { kind: "container", selector: "*" });
  const { spec, fieldMeta, unmapped } = normalizeV2(inv).result;
  return { migrationId: M, source: { provider: "aws" },
    target: { provider: "gcp", region: "default", capabilities: dst.capabilities() },
    inventory: { provider: inv.provider, items: inv.items, coverage: inv.coverage },
    baseline: { version: 1, spec, fieldMeta, unmapped }, plan: null };
}

test("spec_draft 한 건: 가짜 공급자로 DRAFT(ai) 판 저장, 단계 기록, 두 번 온 작업은 건너뜀", async () => {
  const store = memorySpecDraftStore({ [R]: { status: "queued", migrationId: M, input: await input() } });
  const job = { tenantId: T, requestId: "req-1", agentRunId: R };
  const r = await handleSpecDraft(job, { store, llm: mockDraftLlm() });
  assert.equal(r.skipped, false);
  if (r.skipped || r.state !== "finished") throw new Error("finished 여야 함");
  assert.equal(r.version, 2);
  assert.equal(store.drafts[0]!.result.model, "mock-draft");
  assert.equal(DRAFT_MARKER_KEY in store.drafts[0]!.result.fieldMeta, false);   // 초안 표시는 저장소가 field_meta 칸에 넣는다
  assert.equal(store.steps.length, 7);
  assert.deepEqual(await handleSpecDraft(job, { store, llm: mockDraftLlm() }), { skipped: true });
  assert.equal(DEMO_INVENTORY.aws.items.length, 5);
});

test("LLM 실패는 저장 없이 failed 로 남고, 작업 모양이 틀리면 거부", async () => {
  const store = memorySpecDraftStore({ [R]: { status: "queued", migrationId: M, input: await input() } });
  const llm = { model: "x", create: async () => { throw new Error("down"); } };
  const r = await handleSpecDraft({ tenantId: T, requestId: "a", agentRunId: R }, { store, llm });
  assert.deepEqual(r, { skipped: false, state: "failed", reason: "LLM 호출 실패: LLM_UNKNOWN" });
  assert.equal(store.drafts.length, 0);
  await assert.rejects(handleSpecDraft({ tenantId: T, agentRunId: R }, { store, llm }));
});

test("agent-run 큐 나누기: kind=spec_draft 는 초안 처리기, 나머지는 기존 장애 분석 처리기", async () => {
  const specStore = memorySpecDraftStore({ [R]: { status: "queued", migrationId: M, input: await input() } });
  const remStore = memoryStore({ [R]: { status: "queued", task: "x", repo: new Map([["deploy/web.yaml", "memory: \"128Mi\"\n"]]) } });
  const deps = (kind: "spec_draft" | null) => ({ kindOf: async () => kind, remediate: stubDeps(remStore),
    specDraft: { store: specStore, llm: scriptedLlm([]) } });
  const job = { tenantId: T, requestId: "r", agentRunId: R };
  const a = await routeAgentRun(job, deps(null));
  assert.equal(a.kind, "remediate");
  const b = await routeAgentRun(job, deps("spec_draft"));
  assert.equal(b.kind, "spec_draft");
  assert.equal(specStore.failures.length, 1);  // 빈 대본 LLM → submit 없이 종료
});
