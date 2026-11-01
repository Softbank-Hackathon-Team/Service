// Z81-09: 시작 설정 검사 표 시험. DB 없이 돈다
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { configProblems, CONFIG_RULES, TEST_ONLY_SWITCHES, testSwitchesOn, type ConfigService } from "../src/config.js";

const SERVICES = Object.keys(CONFIG_RULES) as ConfigService[];
// .env.example 을 node --env-file 처럼 읽는다 (주석·빈 줄 무시, 값 끝 주석 없음 전제)
function readEnvFile(path: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const l of readFileSync(path, "utf8").split("\n")) {
    const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(l.trim());
    if (m) env[m[1]!] = m[2]!.replace(/^"(.*)"$/, "$1");
  }
  return env;
}

test(".env.example 그대로면 세 서비스 모두 통과 (지금 돌던 설정을 막지 않는다)", () => {
  const env = readEnvFile(new URL("../../../.env.example", import.meta.url).pathname);
  for (const s of SERVICES) assert.deepEqual(configProblems(s, env), [], s);
});

test("운영 compose·시험 회차에서 쓰는 값도 통과", () => {
  const env = { DATABASE_URL: "postgres://app_user:x@db:5432/platform", API_PORT: "3000", METRICS_PORT: "0", WORKER_METRICS_PORT: "0",
    TRAFFIC_OBSERVE_SEC: "0.5", ROLLBACK_WINDOW_SEC: "20", STUB_DELAY_MS: "0", LOG_LEVEL: "info", RATE_LIMIT: "0",
    AGENT_LLM_PROVIDER: "mock", WORKER_POLL_SEC: "0.5" };
  for (const s of SERVICES) assert.deepEqual(configProblems(s, env), [], s);
});

test("틀린 것은 한 번에 모두, 이름: 이유 로 (첫 오류에서 멈추지 않음)", () => {
  const p = configProblems("api", { API_PORT: "abc", METRICS_PORT: "70000", LOG_LEVEL: "loud", DB_POOL_MAX: "0" });
  assert.deepEqual(p.map((x) => x.split(":")[0]).sort(), ["API_PORT", "DATABASE_URL", "DB_POOL_MAX", "LOG_LEVEL", "METRICS_PORT"]);
  assert.ok(p.includes("DATABASE_URL: 없음 (꼭 필요)"));
  assert.ok(p.includes("API_PORT: 숫자가 아님"));
});

test("빈 값은 설정 안 함 (envNumber 와 같은 규칙) → 기본값을 쓰므로 통과", () => {
  assert.deepEqual(configProblems("worker", { DATABASE_URL: "postgres://u@h/d", MAX_CUTOVER_ATTEMPTS: "", STUB_DELAY_MS: "  " }), []);
});

test("값(비밀번호 등)은 메시지에 들어가지 않는다", () => {
  const p = configProblems("worker", { DATABASE_URL: "mysql://user:S3CRET-PW@h/d", MAX_CUTOVER_ATTEMPTS: "S3CRET-2" });
  assert.equal(p.length, 2);
  for (const l of p) assert.ok(!l.includes("S3CRET"), l);
});

test("agent-worker: 선택 값 + 키가 꼭 필요한 조합 (키 값은 안 봄)", () => {
  const base = { DATABASE_URL: "postgres://u@h/d" };
  assert.deepEqual(configProblems("agent-worker", { ...base, AGENT_LLM_PROVIDER: "openai", SANDBOX_MODE: "docker" }).map((x) => x.split(":")[0]).sort(),
    ["AGENT_LLM_PROVIDER", "SANDBOX_MODE"]);
  assert.deepEqual(configProblems("agent-worker", { ...base, AGENT_LLM: "real" }), ["ANTHROPIC_API_KEY: AGENT_LLM=real 이면 있어야 함"]);
  assert.deepEqual(configProblems("agent-worker", { ...base, AGENT_LLM: "real", ANTHROPIC_API_KEY: "k" }), []);
});

test("z75-68: DEMO_MODE=1 에서 시험 전용 스위치가 켜져 있으면 세 서비스 모두 거부 (이름만), 꺼져 있거나 DEMO_MODE 가 없으면 통과", () => {
  const on = { DEMO_MODE: "1", MOCK_IAC: "1", FAKE_LLM: "1", MOCK_SEED: "0", DEV_AUTH: "" };
  for (const s of ["api", "worker", "agent-worker"] as const) {
    const p = configProblems(s, on).filter((x) => /시험 전용/.test(x));
    assert.deepEqual(p.map((x) => x.split(":")[0]), ["MOCK_IAC", "FAKE_LLM"], s);
    assert.equal(configProblems(s, { ...on, DEMO_MODE: "" }).filter((x) => /시험 전용/.test(x)).length, 0, s);
    assert.equal(configProblems(s, { DEMO_MODE: "1", MOCK_SEED: "0" }).filter((x) => /시험 전용/.test(x)).length, 0, s);
  }
  assert.deepEqual(testSwitchesOn({ MOCK_ARGO: " 1 ", MOCK_PRECHECK: "0", DEV_AUTH: "1" }), ["MOCK_ARGO", "DEV_AUTH"]);
  assert.deepEqual([...TEST_ONLY_SWITCHES], ["MOCK_SEED", "MOCK_IAC", "MOCK_ARGO", "MOCK_PRECHECK", "FAKE_LLM", "DEV_AUTH", "MOCK_CREDS", "MOCK_REPL", "MOCK_TRAFFIC"]);
  assert.deepEqual(configProblems("worker", { DEMO_MODE: "1", MOCK_CREDS: "1", MOCK_REPL: "1", MOCK_TRAFFIC: "1" }).filter((x) => /시험 전용/.test(x)).map((x) => x.split(":")[0]), ["MOCK_CREDS", "MOCK_REPL", "MOCK_TRAFFIC"]);
});
