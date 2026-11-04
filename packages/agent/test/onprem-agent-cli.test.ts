// W1: 온프레 Agent 실행기(tools/onprem-agent.ts)의 진입 동작. 이미지 스모크(CI)가 부르는 --help 와 잘못된 명령
//   kubectl·플랫폼 API·환경변수 없이 끝나야 하는 경로만 본다 (보고 모으기·서명은 onprem-agent.test.ts)
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const run = (...args: string[]) => spawnSync(process.execPath, ["--import", "tsx", "tools/onprem-agent.ts", ...args], {
  cwd: root, encoding: "utf8", timeout: 30_000,
  // 플랫폼 접속 값이 새어 들어오면 --help 가 그것 없이 끝나는지 못 본다
  env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
});

test("--help: 판 이름과 사용법을 내고 0 으로 끝난다 (환경변수·kubectl 없이)", () => {
  const r = run("--help");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^onprem-agent\/\d+\.\d+\.\d+\n/);
  assert.match(r.stdout, /loop \[--every 초\]/);
});

test("모르는 명령·인자 없음: 사용법을 오류로 내고 1 로 끝난다", () => {
  for (const args of [["bogus"], []]) {
    const r = run(...args);
    assert.equal(r.status, 1, `args=${JSON.stringify(args)}`);
    assert.equal(r.stdout, "");
    const err = JSON.parse(r.stderr.trim()) as { ok: boolean; error: string };
    assert.equal(err.ok, false);
    assert.match(err.error, /^사용: onprem-agent /);
  }
});
