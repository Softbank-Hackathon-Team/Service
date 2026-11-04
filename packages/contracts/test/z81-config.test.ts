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
  assert.deepEqual([...TEST_ONLY_SWITCHES], ["MOCK_SEED", "MOCK_IAC", "MOCK_ARGO", "MOCK_PRECHECK", "FAKE_LLM", "DEV_AUTH", "MOCK_CREDS", "MOCK_REPL", "MOCK_TRAFFIC",
    "MOCK_SANDBOX", "MOCK_SANDBOX_RESULT"]);
  assert.deepEqual(configProblems("worker", { DEMO_MODE: "1", MOCK_CREDS: "1", MOCK_REPL: "1", MOCK_TRAFFIC: "1" }).filter((x) => /시험 전용/.test(x)).map((x) => x.split(":")[0]), ["MOCK_CREDS", "MOCK_REPL", "MOCK_TRAFFIC"]);
});

test("PRINCIPALUSER: PLATFORM_PRINCIPAL_ARN 은 IAM 역할·사용자만 (:root·assumed-role·모양 틀림 거부)", () => {
  const p = (v: string) => configProblems("api", { DATABASE_URL: "postgres://u@localhost:5432/d", PLATFORM_PRINCIPAL_ARN: v })
    .filter((x) => x.startsWith("PLATFORM_PRINCIPAL_ARN"));
  assert.deepEqual(p("arn:aws:iam::123456789012:role/svc-platform"), []);
  assert.deepEqual(p("arn:aws:iam::123456789012:role/aws-reserved/sso.amazonaws.com/ap-northeast-2/AWSReservedSSO_X"), []);
  assert.deepEqual(p("arn:aws:iam::123456789012:user/jeong-cli"), []);
  assert.equal(p("arn:aws:iam::123456789012:root").length, 1);
  assert.equal(p("arn:aws:sts::123456789012:assumed-role/x/y").length, 1);
  assert.equal(p("arn:aws:iam::1234:user/x").length, 1);
});

test("리허설 설정 (worker): 정상 값 통과 / 틀린 값은 이름: 이유, 켰는데 복사 자리 없으면 거부 (흉내면 통과)", () => {
  const base = { DATABASE_URL: "postgres://u@h/d" };
  const ecr = "123456789012.dkr.ecr.ap-northeast-2.amazonaws.com/sandbox";
  assert.deepEqual(configProblems("worker", { ...base, SANDBOX_REHEARSAL: "on", SANDBOX_IMAGE_REGISTRY: ecr, REHEARSAL_TIMEOUT_SEC: "1200", REHEARSAL_QUEUE_TIMEOUT_SEC: "3600", REHEARSAL_POLL_SEC: "60" }), []);
  // 실행 기한 200초: agent-worker 가 기한 120초 전에 멈추면 샌드박스를 만들 시간도 안 남는다
  assert.deepEqual(configProblems("worker", { ...base, SANDBOX_REHEARSAL: "yes", REHEARSAL_TIMEOUT_SEC: "200", REHEARSAL_QUEUE_TIMEOUT_SEC: "10", REHEARSAL_POLL_SEC: "1.5",
    SANDBOX_IMAGE_REGISTRY: "https://ecr/sandbox", MOCK_SANDBOX: "true" }).map((x) => x.split(":")[0]).sort(),
    ["MOCK_SANDBOX", "REHEARSAL_POLL_SEC", "REHEARSAL_QUEUE_TIMEOUT_SEC", "REHEARSAL_TIMEOUT_SEC", "SANDBOX_IMAGE_REGISTRY", "SANDBOX_REHEARSAL"]);
  assert.deepEqual(configProblems("worker", { ...base, SANDBOX_REHEARSAL: "on" }).map((x) => x.split(":")[0]), ["SANDBOX_IMAGE_REGISTRY"]);
  assert.deepEqual(configProblems("worker", { ...base, SANDBOX_REHEARSAL: "on", MOCK_SANDBOX: "1" }), []);
  assert.deepEqual(configProblems("worker", { ...base, SANDBOX_REHEARSAL: "off" }), []);
});

test("샌드박스 설정 (agent-worker): vcluster·gVisor 이름·만료·차트 / RuntimeClass 없이도 통과 (리허설은 baseline 이라 묶지 않음)", () => {
  const base = { DATABASE_URL: "postgres://u@h/d" };
  assert.deepEqual(configProblems("agent-worker", { ...base, SANDBOX_MODE: "vcluster" }), []);
  assert.deepEqual(configProblems("agent-worker", { ...base, SANDBOX_MODE: "vcluster", SANDBOX_RUNTIME_CLASS: "gvisor", SANDBOX_TTL_SEC: "1800",
    SANDBOX_VCLUSTER_CHART: "/app/vendor/vcluster-0.37.6.tgz" }), []);
  assert.deepEqual(configProblems("agent-worker", { ...base, SANDBOX_RUNTIME_CLASS: "GVisor_X", SANDBOX_TTL_SEC: "60", SANDBOX_VCLUSTER_CHART: "/app/vendor/vcluster" })
    .map((x) => x.split(":")[0]).sort(), ["SANDBOX_RUNTIME_CLASS", "SANDBOX_TTL_SEC", "SANDBOX_VCLUSTER_CHART"]);
});

test("MOCK_SANDBOX (agent-worker): 켜고 결과 고르기 통과 / 틀린 결과·흉내 없이 결과만 고르면 거부 / DEMO_MODE=1 이면 두 스위치 모두 거부", () => {
  const base = { DATABASE_URL: "postgres://u@h/d" };
  assert.deepEqual(configProblems("agent-worker", { ...base, MOCK_SANDBOX: "1" }), []);
  assert.deepEqual(configProblems("agent-worker", { ...base, MOCK_SANDBOX: "1", MOCK_SANDBOX_RESULT: "fail" }), []);
  assert.deepEqual(configProblems("agent-worker", { ...base, MOCK_SANDBOX: "1", MOCK_SANDBOX_RESULT: "maybe" }).map((x) => x.split(":")[0]), ["MOCK_SANDBOX_RESULT"]);
  assert.deepEqual(configProblems("agent-worker", { ...base, MOCK_SANDBOX_RESULT: "fail" }), ["MOCK_SANDBOX_RESULT: MOCK_SANDBOX=1 일 때만 씀"]);
  for (const s of ["worker", "agent-worker"] as const)
    assert.deepEqual(configProblems(s, { ...base, DEMO_MODE: "1", MOCK_SANDBOX: "1", MOCK_SANDBOX_RESULT: "pass" }).filter((x) => /시험 전용/.test(x))
      .map((x) => x.split(":")[0]), ["MOCK_SANDBOX", "MOCK_SANDBOX_RESULT"], s);
});
