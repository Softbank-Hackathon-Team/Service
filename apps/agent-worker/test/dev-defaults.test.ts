// 개발 실행 기본값 (작업 Z90): AI 기본 = 실제 LLM. 기본값 파일에 가짜 LLM 설정이 없어야 한다. .env 가 뒤에 와서 맥 값이 이긴다
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { scripts: Record<string, string> };
const defaults = readFileSync(new URL("../../../deploy/dev/agent-worker.defaults.env", import.meta.url), "utf8");
const compose = readFileSync(new URL("../../../docker-compose.prod.yml", import.meta.url), "utf8");

test("agent-worker dev·start: 기본값 파일 다음에 .env (뒤가 이김)", () => {
  for (const k of ["dev", "start"]) {
    const s = pkg.scripts[k] ?? "";
    const d = s.indexOf("--env-file=../../deploy/dev/agent-worker.defaults.env"), e = s.indexOf("--env-file=../../.env ");
    assert.ok(d >= 0 && e > d, `${k}: ${s}`);
  }
});

test("Z90: 개발 기본값·운영 compose 에 가짜 LLM 기본이 없다", () => {
  for (const [name, txt] of [["defaults.env", defaults], ["docker-compose.prod.yml", compose]] as const) {
    assert.doesNotMatch(txt, /^\s*AGENT_LLM_PROVIDER\s*[=:]/m, name);
    assert.doesNotMatch(txt, /^\s*AGENT_LLM\s*[=:]/m, name);
    assert.doesNotMatch(txt, /^\s*FAKE_LLM\s*=\s*1/m, name);
  }
  // 운영 compose: FAKE_LLM 은 기본 빈 값, API 는 키 값 대신 "있음" 표시만 받는다
  assert.match(compose, /FAKE_LLM: \$\{FAKE_LLM:-\}/);
  assert.match(compose, /AGENT_LLM_KEY_SET: \$\{ANTHROPIC_API_KEY:\+1\}/);
});
