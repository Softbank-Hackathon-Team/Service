// 작업 Z58: AI 점검 결과 경로 (GET /migrations/:id/agent-review). DB 없이 돈다
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Fastify from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { errorsPlugin } from "../src/plugins/errors.js";
import { authPlugin } from "../src/plugins/auth.js";
import {
  AgentReview, STUB_REMEDIATE, agentLlmForApi, agentReviewRoutes, buildAgentReview, type AgentReviewInput, type RunRow,
} from "../src/routes/agent-review.js";
// 표류 확인용: agent-worker 대본 실행을 실제로 한 번 돌린다 (API 런타임은 이것을 import 하지 않음)
import { handleAgentRun, memoryStore, stubDeps } from "../../agent-worker/src/handle-agent-run.js";

const T = "11111111-1111-4111-8111-111111111111";
const M = "22222222-2222-4222-8222-222222222222";
const R = "55555555-5555-4555-8555-555555555555";

const specRow = (over: Partial<RunRow> = {}): RunRow => ({
  id: "66666666-6666-4666-8666-666666666666", kind: "spec_draft", status: "finished", model: "claude-sonnet-5-5",
  result: {
    version: 2, planExplanation: "Postgres 는 논리 복제로 옮긴다.",
    risks: [
      { id: "RISK-01", level: "high", title: "DB 크기 미확인", detail: "x", source: "rule" },
      { id: "AI-01", level: "low", title: "세션 고정", detail: "y", source: "ai" },
    ],
    rejectedChanges: [{ field: "image", reason: "고정 칸" }],
  },
  reason: null, usage: { input: 1200, output: 300 },
  created_at: new Date(Date.UTC(2026, 10, 7, 3, 0, 0)), finished_at: new Date(Date.UTC(2026, 10, 7, 3, 0, 9)),
  steps: [{ seq: 1, tool: "read_inventory", ok: true, note: "items=3" }],
  ...over,
});

test("STUB 값은 agent-worker 대본(DEMO_SCRIPT + stubSandbox) 실제 실행 결과와 같다", async () => {
  const repo = new Map([["deploy/web.yaml",
    "kind: Deployment\nspec:\n  containers:\n    - image: reg.example/web@sha256:aa\n      resources:\n        limits:\n          memory: \"128Mi\"\n"]]);
  const store = memoryStore({ [R]: { status: "queued", task: "web 재시작 원인", repo } });
  await handleAgentRun({ tenantId: T, requestId: "z58", agentRunId: R }, stubDeps(store));
  const res = store.results[0] as { reason: string; finish: Record<string, unknown>; gate: unknown; usage: unknown };
  assert.deepEqual(STUB_REMEDIATE.steps, store.steps.map((s) => ({ seq: s.step, tool: s.tool, ok: s.ok, note: s.note })));
  assert.deepEqual(
    { outcome: STUB_REMEDIATE.outcome, title: STUB_REMEDIATE.title, reason: STUB_REMEDIATE.rationale,
      checked: STUB_REMEDIATE.checked, notDone: STUB_REMEDIATE.notDone },
    res.finish);
  assert.deepEqual(STUB_REMEDIATE.gate, res.gate);
  assert.deepEqual(STUB_REMEDIATE.usage, res.usage);
  assert.equal(STUB_REMEDIATE.reason, res.reason);
  // 웹 가짜 API(apps/web/mock)도 같은 값
  const mock = JSON.parse(readFileSync(new URL("../../web/mock/agent-review-fixture.json", import.meta.url), "utf8"));
  assert.deepEqual(mock, STUB_REMEDIATE);
});

test("Z90: 기록이 없으면 기본은 둘 다 null (가짜 결과 없음), stub 은 FAKE_LLM 시험 때만 / llm 상태가 실린다", () => {
  const v = AgentReview.parse(buildAgentReview(M, []));
  assert.equal(v.remediate, null);
  assert.equal(v.specDraft, null);
  assert.equal(v.llm.state, "key_missing");
  const fake = AgentReview.parse(buildAgentReview(M, [], { stub: true, llm: { state: "fake", model: "fake", why: "FAKE_LLM=1" } }));
  assert.equal(fake.remediate?.source, "stub");
  assert.equal(fake.llm.state, "fake");
});

test("Z90: API 의 LLM 상태 = 키 값 없이 '있음' 표시만으로, 틀린 설정도 500 대신 key_missing + 이유", () => {
  assert.equal(agentLlmForApi({}).state, "key_missing");
  assert.equal(agentLlmForApi({ AGENT_LLM_KEY_SET: "1" }).state, "ready");
  assert.equal(agentLlmForApi({ ANTHROPIC_API_KEY: "k" }).state, "ready");
  assert.equal(agentLlmForApi({ FAKE_LLM: "1" }).state, "fake");
  assert.equal(agentLlmForApi({ AGENT_LLM_KEY_SET: "1", AGENT_MODEL: "claude-opus-5-5" }).model, "claude-opus-5-5");
  const badCfg = agentLlmForApi({ AGENT_LLM_PROVIDER: "openai", AGENT_LLM_KEY_SET: "1" });
  assert.equal(badCfg.state, "key_missing");
  assert.match(badCfg.why, /AI 설정 오류/);
  assert.match(agentLlmForApi({ AGENT_LLM_PROVIDER: "mock", AGENT_LLM_KEY_SET: "1" }).warnings.join(), /무시/);
});

test("DB 기록: 종류별 최신 1건, result 칸을 화면 모양으로, 망가진 result 도 500 없이", () => {
  const remediateRow: RunRow = {
    ...specRow(), id: "77777777-7777-4777-8777-777777777777", kind: "remediate", model: "claude-sonnet-5-5",
    result: { finish: { outcome: "gave_up", title: "원인 못 찾음", reason: "로그 없음", checked: [], notDone: ["로그"] },
      gate: { ok: true, violations: [] } },
  };
  const old = specRow({ id: "88888888-8888-4888-8888-888888888888", created_at: new Date(Date.UTC(2026, 10, 7, 2)) });
  const v = AgentReview.parse(buildAgentReview(M, [old, specRow(), remediateRow]));
  assert.equal(v.specDraft?.runId, "66666666-6666-4666-8666-666666666666");
  assert.equal(v.specDraft?.source, "db");
  assert.equal(v.specDraft?.version, 2);
  assert.deepEqual(v.specDraft?.risks.map((r) => r.id), ["RISK-01", "AI-01"]);
  assert.equal(v.specDraft?.rejectedCount, 1);
  assert.equal(v.specDraft?.createdAt, "2026-11-07T03:00:00.000Z");
  assert.equal(v.remediate?.source, "db");
  assert.equal(v.remediate?.outcome, "gave_up");

  const broken = AgentReview.parse(buildAgentReview(M, [specRow({ result: "garbage", usage: null, status: "failed", reason: "LLM_AUTH" })]));
  assert.equal(broken.specDraft?.risks.length, 0);
  assert.deepEqual(broken.specDraft?.usage, { input: 0, output: 0 });
  assert.equal(broken.specDraft?.reason, "LLM_AUTH");
});

async function appWith(load: (t: string, m: string) => Promise<AgentReviewInput>, llmEnv: Record<string, string> = { FAKE_LLM: "1" }) {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(errorsPlugin);
  await app.register(authPlugin);
  await app.register(agentReviewRoutes, { prefix: "/api/v1", load, llmEnv });
  return app;
}

test("경로: 200 + 계약 모양 + no-store, 남의 이전 404, 헤더 없으면 401, uuid 아니면 400", async () => {
  const app = await appWith(async (t, m) => ({ migrationExists: t === T && m === M, runs: [specRow()] }));
  const url = `/api/v1/migrations/${M}/agent-review`;
  const ok = await app.inject({ url, headers: { "x-dev-tenant": T } });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.headers["cache-control"], "no-store");
  const body = AgentReview.parse(ok.json());
  assert.equal(body.remediate?.title, "web 메모리 상한 128Mi→512Mi");
  assert.equal(body.specDraft?.model, "claude-sonnet-5-5");
  const other = await app.inject({ url, headers: { "x-dev-tenant": "99999999-9999-4999-8999-999999999999" } });
  assert.equal(other.statusCode, 404);
  assert.equal((await app.inject({ url })).statusCode, 401);
  assert.equal((await app.inject({ url: "/api/v1/migrations/x/agent-review", headers: { "x-dev-tenant": T } })).statusCode, 400);
});

test("Z90: 실제 모드 경로 — 기록 없으면 remediate null + llm 상태, 키 없으면 실행 요청 409 LLM_KEY_MISSING (큐에 안 넣음)", async () => {
  let sent = 0;
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(errorsPlugin);
  await app.register(authPlugin);
  await app.register(agentReviewRoutes, { prefix: "/api/v1", llmEnv: {},
    load: async () => ({ migrationExists: true, runs: [] }), send: async () => { sent++; return "job"; } });
  const get = await app.inject({ url: `/api/v1/migrations/${M}/agent-review`, headers: { "x-dev-tenant": T } });
  assert.equal(get.statusCode, 200);
  const body = AgentReview.parse(get.json());
  assert.equal(body.remediate, null);
  assert.equal(body.llm.state, "key_missing");
  for (const payload of [{}, { kind: "spec_draft" }]) {
    const post = await app.inject({ method: "POST", url: `/api/v1/migrations/${M}/agent-review/run`,
      headers: { "x-dev-tenant": T, "content-type": "application/json" }, payload });
    assert.equal(post.statusCode, 409, post.body);
    assert.equal(post.json().code, "LLM_KEY_MISSING");
  }
  assert.equal(sent, 0);
  await app.close();
});

test("z75-64: 실제 LLM 이면 GET 에 이번 회차 지출, 상한을 넘으면 POST 409 LLM_BUDGET_EXCEEDED (큐에 안 넣음)", async () => {
  let sent = 0, usd = 0.004;
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(errorsPlugin);
  await app.register(authPlugin);
  await app.register(agentReviewRoutes, { prefix: "/api/v1", llmEnv: { AGENT_LLM_KEY_SET: "1", LLM_BUDGET_USD: "0.01", LLM_BUDGET_ROUND: "r1" },
    load: async () => ({ migrationExists: true, runs: [] }), send: async () => { sent++; return "job"; },
    loadSpend: async (t: string, round: string) => (t === T && round === "r1" ? { usd, calls: 2 } : null) });
  const get = await app.inject({ url: `/api/v1/migrations/${M}/agent-review`, headers: { "x-dev-tenant": T } });
  assert.equal(get.statusCode, 200, get.body);
  assert.deepEqual(AgentReview.parse(get.json()).llm.spend, { round: "r1", usd: 0.004, budgetUsd: 0.01, calls: 2, exceeded: false });
  usd = 0.0123;
  const post = await app.inject({ method: "POST", url: `/api/v1/migrations/${M}/agent-review/run`,
    headers: { "x-dev-tenant": T, "content-type": "application/json" }, payload: {} });
  assert.equal(post.statusCode, 409, post.body);
  assert.equal(post.json().code, "LLM_BUDGET_EXCEEDED");
  assert.equal(sent, 0);
  await app.close();
});
