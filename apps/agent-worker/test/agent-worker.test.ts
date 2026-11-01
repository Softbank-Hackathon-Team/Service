import { test } from "node:test";
import assert from "node:assert/strict";
import { handleAgentRun, memoryStore, stubDeps } from "../src/handle-agent-run.js";

const T = "11111111-1111-4111-8111-111111111111";
const R = "55555555-5555-4555-8555-555555555555";
const repo = () => new Map([["deploy/web.yaml",
  "kind: Deployment\nspec:\n  containers:\n    - image: reg.example/web@sha256:aa\n      resources:\n        limits:\n          memory: \"128Mi\"\n"]]);

test("agent-run 작업 하나: 대본 LLM으로 끝까지, 제안은 게이트 통과, 단계 8개 기록", async () => {
  const store = memoryStore({ [R]: { status: "queued", task: "web 재시작 원인", repo: repo() } });
  const r = await handleAgentRun({ tenantId: T, requestId: "req-1", agentRunId: R }, stubDeps(store));
  assert.deepEqual(r, { skipped: false, state: "finished", outcome: "proposed", gateOk: true });
  assert.equal(store.steps.length, 8);
});

test("두 번 온 작업은 건너뛰고, 모양이 틀린 작업은 거부", async () => {
  const store = memoryStore({ [R]: { status: "queued", task: "x", repo: repo() } });
  await handleAgentRun({ tenantId: T, requestId: "a", agentRunId: R }, stubDeps(store));
  const again = await handleAgentRun({ tenantId: T, requestId: "a", agentRunId: R }, stubDeps(store));
  assert.deepEqual(again, { skipped: true });
  await assert.rejects(handleAgentRun({ tenantId: T, agentRunId: R, extra: 1 }, stubDeps(store)));
});

// 작업 Z65: 워커는 deps 를 한 번만 만든다. 두 번째 실행부터 대본이 바닥나 failed 되던 버그의 회귀 시험
test("같은 deps 로 세 번 돌려도 매번 대본 처음부터", async () => {
  const ids = ["a", "b", "c"].map((c) => `55555555-5555-4555-8555-55555555555${c}`);
  const store = memoryStore(Object.fromEntries(ids.map((id) => [id, { status: "queued", task: "x", repo: repo() }])));
  const deps = stubDeps(store);
  for (const id of ids) {
    const r = await handleAgentRun({ tenantId: T, requestId: id, agentRunId: id }, deps);
    assert.deepEqual(r, { skipped: false, state: "finished", outcome: "proposed", gateOk: true });
  }
  assert.equal(store.steps.length, 3 * 8);   // 통합: 실행 1번 = 8단계(위 첫 시험과 같음, Z22 뒤)
});

// 작업 Z65: claim·finish 인자 모양(model)·LLM 예외
test("claim: 진 쪽은 건너뛰고, finish 인자에 model·{finish, gate} 가 실린다", async () => {
  const store = memoryStore({ [R]: { status: "queued", task: "x", repo: repo() } });
  await handleAgentRun({ tenantId: T, requestId: "a", agentRunId: R }, stubDeps(store));
  const res = store.results[0] as { model: string; state: string; finish: { outcome: string }; gate: { ok: boolean } };
  assert.equal(res.model, "stub-scripted");
  assert.equal(res.state, "finished");
  assert.equal(res.finish.outcome, "proposed");
  assert.equal(res.gate.ok, true);
  const lost = memoryStore({ [R]: { status: "queued", task: "x", repo: repo() } });
  lost.claim = async () => false;                                   // load 는 queued 인데 다른 워커가 먼저 잡음
  assert.deepEqual(await handleAgentRun({ tenantId: T, requestId: "b", agentRunId: R }, stubDeps(lost)), { skipped: true });
  assert.equal(lost.steps.length, 0);
  assert.equal(lost.results.length, 0);
});

test("LLM 이 던지면 failed 로 닫고 model 을 남긴다 (예외 메시지는 안 남김)", async () => {
  const store = memoryStore({ [R]: { status: "queued", task: "x", repo: repo() } });
  const boom = { model: "m-x", create: async () => { throw Object.assign(new Error("key=sk-secret"), { status: 401 }); } };
  const r = await handleAgentRun({ tenantId: T, requestId: "c", agentRunId: R }, { ...stubDeps(store), llm: boom });
  assert.equal(r.skipped === false && r.state, "failed");
  const res = store.results[0] as { state: string; reason: string; model: string };
  assert.equal(res.state, "failed"); assert.equal(res.model, "m-x");
  assert.ok(!JSON.stringify(store.results).includes("sk-secret"));
  assert.match(res.reason, /^LLM_/);
});

// 작업 Z65: main.ts 와 똑같이 env 로 고른 대본 LLM·memory 샌드박스를 한 번 만들어 세 번 (int5-2 실워커에서 2번째부터 failed 였음)
test("main.ts 모양 deps(remediateLlmFromEnv + sandboxFromEnv) 를 재사용해도 매번 finished", async () => {
  const { remediateLlmFromEnv, sandboxFromEnv } = await import("@svc/agent");
  const { DEMO_SCRIPT } = await import("../src/handle-agent-run.js");
  const ids = ["d", "e", "f"].map((c) => `55555555-5555-4555-8555-55555555555${c}`);
  const store = memoryStore(Object.fromEntries(ids.map((id) => [id, { status: "queued", task: "x", repo: repo() }])));
  const deps = { store, llm: remediateLlmFromEnv(DEMO_SCRIPT, { FAKE_LLM: "1" }).llm, sandbox: sandboxFromEnv({}).create };
  for (const id of ids) {
    const r = await handleAgentRun({ tenantId: T, requestId: id, agentRunId: id }, deps);
    assert.deepEqual(r, { skipped: false, state: "finished", outcome: "proposed", gateOk: true });
  }
});
