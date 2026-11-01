// Z81-10: 시작 로그 "effective config" 가 각 코드의 진짜 규칙과 같은 값을 내는지. DB·네트워크 없이 돈다
import { test } from "node:test";
import assert from "node:assert/strict";
import { effectiveConfig, logEffectiveConfig, observeMinSec } from "@svc/core";
import { llmFromEnv } from "@svc/agent";
import { rateLimitOptsFromEnv } from "../../api/src/plugins/rate-limit.js";
import { configFromEnv as gitopsFromEnv } from "../../worker/src/gitops/repo.js";

const CASES: NodeJS.ProcessEnv[] = [
  {},
  { TRAFFIC_OBSERVE_SEC: "0.5", ROLLBACK_WINDOW_SEC: "20", RATE_LIMIT: "0", AGENT_LLM_PROVIDER: "mock", GITOPS_DISABLE: "1" },
  { TRAFFIC_OBSERVE_SEC: "", ROLLBACK_WINDOW_SEC: "", RATE_LIMIT: "", ANTHROPIC_API_KEY: "k", GITOPS_REPO_DIR: "/tmp/x" },
  { TRAFFIC_OBSERVE_SEC: "abc", PROM_URL: "http://p", AGENT_LLM_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "k", GITOPS_REPO_URL: "https://h/r.git" },
  { TRAFFIC_OBSERVE_SEC: "4", PROM_URL: "http://p", TRAFFIC_PROVIDER: "cloudflare" },
];

test("값이 진짜 규칙과 같다 (관찰 초·롤백 창·요청 제한·LLM 공급자·GitOps·트래픽 공급자)", () => {
  for (const env of CASES) {
    const e = effectiveConfig(env);
    const tag = JSON.stringify(env);
    assert.equal(e.TRAFFIC_OBSERVE_SEC!.value, observeMinSec(env), tag);
    assert.equal(e.RATE_LIMIT!.value, rateLimitOptsFromEnv(env).enabled ? "on" : "off", tag);
    assert.equal(e.AGENT_LLM_PROVIDER!.value, llmFromEnv(env).provider, tag);
    assert.equal(e.GITOPS!.value, gitopsFromEnv(env) ? "on" : "off", tag);
    assert.equal(e.TRAFFIC_PROVIDER!.value, env.TRAFFIC_PROVIDER || "mock", tag);
  }
  assert.deepEqual(effectiveConfig({}).TRAFFIC_OBSERVE_SEC, { value: 30, source: "default", floorApplied: false });
  assert.deepEqual(effectiveConfig({ TRAFFIC_OBSERVE_SEC: "4", PROM_URL: "x" }).TRAFFIC_OBSERVE_SEC, { value: 30, source: "env, PROM_URL 있어 최소 30", floorApplied: true });
  // Z81-11: 하한이 걸렸는지·PROM_URL 있음/없음
  assert.equal(effectiveConfig({ TRAFFIC_OBSERVE_SEC: "45", PROM_URL: "x" }).TRAFFIC_OBSERVE_SEC!.floorApplied, false);
  assert.equal(effectiveConfig({ TRAFFIC_OBSERVE_SEC: "0.5" }).TRAFFIC_OBSERVE_SEC!.floorApplied, false);
  assert.equal(effectiveConfig({ PROM_URL: "x" }).TRAFFIC_OBSERVE_SEC!.floorApplied, false);   // 비어 있으면 원래 기본 30, 덮인 게 아님
  assert.deepEqual(effectiveConfig({ PROM_URL: "http://prom:9090" }).PROM_URL, { value: "set", source: "env" });
  assert.deepEqual(effectiveConfig({ PROM_URL: " " }).PROM_URL, { value: "set", source: "env" });   // guards.ts 와 같음: 공백도 "있음"
  assert.deepEqual(effectiveConfig({ PROM_URL: "" }).PROM_URL, { value: "unset", source: "default" });
  assert.equal(effectiveConfig({ TRAFFIC_OBSERVE_SEC: "4", PROM_URL: " " }).TRAFFIC_OBSERVE_SEC!.value, observeMinSec({ TRAFFIC_OBSERVE_SEC: "4", PROM_URL: " " }));
  assert.deepEqual(effectiveConfig({ ROLLBACK_WINDOW_SEC: "20" }).ROLLBACK_WINDOW_SEC, { value: 20, source: "env" });
});

test("한 줄 JSON, 비밀값·주소 없음", () => {
  const lines: string[] = [];
  logEffectiveConfig("worker", { PROM_URL: "http://SECRET-prom:9090", ANTHROPIC_API_KEY: "sk-SECRET", GITOPS_REPO_URL: "https://tok-SECRET@h/r.git", DATABASE_URL: "postgres://u:SECRET@h/d" }, (l) => lines.push(l));
  assert.equal(lines.length, 1);
  const j = JSON.parse(lines[0]!);
  assert.equal(j.msg, "effective config");
  assert.equal(j.component, "config");
  assert.equal(j.service, "worker");
  assert.deepEqual(Object.keys(j.config).sort(), ["AGENT_LLM_PROVIDER", "GITOPS", "PROM_URL", "RATE_LIMIT", "ROLLBACK_WINDOW_SEC", "TRAFFIC_OBSERVE_SEC", "TRAFFIC_PROVIDER"]);
  assert.ok(!lines[0]!.includes("SECRET"), lines[0]);
});
