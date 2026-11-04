// Z20 (리뷰 Z10 M6): claim(queued → running) 뒤 예외가 나도 running 에 갇히지 않는다
import { test } from "node:test";
import assert from "node:assert/strict";
import { adapterFor, normalizeV2 } from "@svc/adapters";
import { mockDraftLlm, type SpecDraftInput } from "@svc/agent";
import { handleSpecDraft, memorySpecDraftStore } from "../src/handle-spec-draft.js";

const T = "11111111-1111-4111-8111-111111111111";
const R = "66666666-6666-4666-8666-666666666666";
const M = "44444444-4444-4444-8444-444444444444";
const job = { tenantId: T, requestId: "req-z20", agentRunId: R };

async function input(): Promise<SpecDraftInput> {
  const src = adapterFor("aws"), dst = adapterFor("gcp");
  const inv = await src.discover({ accountId: "dev", expiresAt: "" }, { kind: "container", selector: "*" });
  const { spec, fieldMeta, unmapped } = normalizeV2(inv).result;
  return { migrationId: M, source: { provider: "aws" },
    target: { provider: "gcp", region: "default", capabilities: dst.capabilities() },
    inventory: { provider: inv.provider, items: inv.items, coverage: inv.coverage },
    baseline: { version: 1, spec, fieldMeta, unmapped }, plan: null };
}

test("M6: 단계 기록(DB)이 예외 → failed('예외: <이름>'), 예외는 다시 던짐, 메시지 본문은 안 남김", async () => {
  const store = memorySpecDraftStore({ [R]: { status: "queued", migrationId: M, input: await input() } });
  store.step = async () => { const e = new Error("secret prompt text"); e.name = "DbDown"; throw e; };
  await assert.rejects(handleSpecDraft(job, { store, llm: mockDraftLlm() }), /secret prompt text/);
  assert.deepEqual(store.failures, ["예외: DbDown"]);
  assert.equal((await store.load(T, R))?.status, "failed");
});

test("M6: 초안 저장 예외 → failed('초안 저장 실패: <이름>')", async () => {
  const store = memorySpecDraftStore({ [R]: { status: "queued", migrationId: M, input: await input() } });
  store.saveDraft = async () => { throw new TypeError("x"); };
  await assert.rejects(handleSpecDraft(job, { store, llm: mockDraftLlm() }), TypeError);
  assert.deepEqual(store.failures, ["초안 저장 실패: TypeError"]);
  assert.equal((await store.load(T, R))?.status, "failed");
});

test("M6: fail 자체가 실패해도 원래 예외가 보인다", async () => {
  const store = memorySpecDraftStore({ [R]: { status: "queued", migrationId: M, input: await input() } });
  store.saveDraft = async () => { throw new RangeError("orig"); };
  store.fail = async () => { throw new Error("db gone"); };
  await assert.rejects(handleSpecDraft(job, { store, llm: mockDraftLlm() }), RangeError);
});
