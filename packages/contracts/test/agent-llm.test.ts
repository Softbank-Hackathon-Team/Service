// 작업 Z90: AI LLM 상태 규칙 (기본 = 실제 API, 가짜는 FAKE_LLM=1 시험만, 키 없으면 key_missing)
import { test } from "node:test";
import assert from "node:assert/strict";
import { agentLlmStatusFromEnv } from "../src/agent-llm.js";

test("기본은 실제, 키 없으면 key_missing, FAKE_LLM=1 만 가짜", () => {
  assert.equal(agentLlmStatusFromEnv({}).state, "key_missing");
  assert.equal(agentLlmStatusFromEnv({ ANTHROPIC_API_KEY: "k" }).state, "ready");
  assert.equal(agentLlmStatusFromEnv({ ANTHROPIC_API_KEY: "  " }).state, "key_missing");
  assert.equal(agentLlmStatusFromEnv({ ANTHROPIC_API_KEY: "k" }).model, "claude-sonnet-5-5");
  assert.equal(agentLlmStatusFromEnv({ ANTHROPIC_API_KEY: "k", AGENT_MODEL: "claude-opus-5-5" }).model, "claude-opus-5-5");
  assert.equal(agentLlmStatusFromEnv({ FAKE_LLM: "1" }).state, "fake");
  assert.equal(agentLlmStatusFromEnv({ FAKE_LLM: "0", ANTHROPIC_API_KEY: "k" }).state, "ready");
});

test("키 '있음' 표시(AGENT_LLM_KEY_SET)는 API 만 믿는다", () => {
  assert.equal(agentLlmStatusFromEnv({ AGENT_LLM_KEY_SET: "1" }).state, "ready");
  assert.equal(agentLlmStatusFromEnv({ AGENT_LLM_KEY_SET: "1" }, { keyFlag: false }).state, "key_missing");
  assert.equal(agentLlmStatusFromEnv({ AGENT_LLM_KEY_SET: "" }).state, "key_missing");
});

test("예전 mock·scripted 설정은 가짜로 바꾸지 않고 경고만, 틀린 값은 오류", () => {
  const s = agentLlmStatusFromEnv({ AGENT_LLM_PROVIDER: "mock", AGENT_LLM: "scripted", ANTHROPIC_API_KEY: "k" });
  assert.equal(s.state, "ready");
  assert.equal(s.warnings.length, 2);
  assert.equal(agentLlmStatusFromEnv({ AGENT_LLM_PROVIDER: "anthropic", AGENT_LLM: "real" }).warnings.length, 0);
  assert.throws(() => agentLlmStatusFromEnv({ AGENT_LLM_PROVIDER: "openai" }), /AGENT_LLM_PROVIDER/);
  assert.throws(() => agentLlmStatusFromEnv({ AGENT_LLM: "gpt" }), /AGENT_LLM/);
});

test("키 값은 결과 어디에도 안 나온다", () => {
  const s = agentLlmStatusFromEnv({ ANTHROPIC_API_KEY: "sk-ant-SECRET" });
  assert.ok(!JSON.stringify(s).includes("SECRET"));
});
