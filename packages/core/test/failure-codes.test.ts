// Z43: 실패 사유 목록(core failure-codes.ts)이 실제로 쓰이는 값과 어긋나지 않는지 본다.
// 소스에서 사유를 내는 자리(failureCode: "X", GitopsError("X"), RunnerUnavailable("X"), traffic rollback(…, "X"))의 리터럴을 모은다
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FAILURE_CODES, isKnownFailureCode, jobFailedCode } from "../src/failure-codes.js";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const DIRS = ["packages/core/src", "apps/worker/src", "packages/traffic/src", "packages/adapters/src"];
const PATTERNS = [
  /failureCode:\s*"([A-Z][A-Z0-9_]+)"/g,
  /failureCode:([^,}\n]*"[A-Z][A-Z0-9_]+"[^,}\n]*)/g,   // 삼항식 등: 안의 "X" 를 다 모은다
  /failureCode\s*\?\?\s*"([A-Z][A-Z0-9_]+)"/g,
  /new GitopsError\(\s*"([A-Z][A-Z0-9_]+)"/g,
  /new RunnerUnavailable\(\s*"([A-Z][A-Z0-9_]+)"/g,
  /rollback\([^;]*?,\s*"(TRAFFIC_[A-Z0-9_]+)"\)/g,
  /"(TRAFFIC_LATENCY|TRAFFIC_ERROR_RATE)"/g,
  /\?\s*"(CUTOVER_[A-Z_]+)"|:\s*"(CUTOVER_[A-Z_]+)"/g,
  /e\.code\s*:\s*"([A-Z][A-Z0-9_]+)"/g,
  /type ReapCode\s*=\s*([^;]+);/g,          // 리퍼 사유 유니온 (아래에서 쪼갠다)
];

function* files(dir: string): Generator<string> {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) yield* files(p);
    else if (p.endsWith(".ts")) yield p;
  }
}

test("소스에서 내는 실패 사유는 모두 FAILURE_CODES에 있다", () => {
  const found = new Map<string, string>();
  for (const d of DIRS) for (const f of files(join(ROOT, d))) {
    if (f.endsWith("failure-codes.ts")) continue;
    const src = readFileSync(f, "utf8");
    for (const re of PATTERNS) for (const m of src.matchAll(re)) {
      const raw = m[1] ?? m[2];
      if (!raw) continue;
      for (const code of raw.includes('"') ? [...raw.matchAll(/"([A-Z][A-Z0-9_]+)"/g)].map((x) => x[1]!) : [raw])
        found.set(code, f.slice(ROOT.length));
    }
  }
  assert.ok(found.size >= 10, `모은 사유가 너무 적다(${found.size}): 패턴이 깨졌을 수 있다`);
  const unknown = [...found].filter(([c]) => !isKnownFailureCode(c));
  assert.deepEqual(unknown, [], "FAILURE_CODES에 없는 사유 (failure-codes.ts에 한 줄 추가)");
});

test("목록에 중복이 없고, JOB_FAILED_<단계>는 대문자로 만든다", () => {
  assert.equal(new Set(FAILURE_CODES).size, FAILURE_CODES.length);
  assert.equal(jobFailedCode("deploy"), "JOB_FAILED_DEPLOY");
  assert.ok(isKnownFailureCode("JOB_FAILED_SYNC"));
  assert.ok(!isKnownFailureCode("NOPE_NOT_A_CODE"));
});
