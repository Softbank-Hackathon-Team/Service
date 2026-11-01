// Z81 (P1): envNumber 시험 + 앱 코드에 예전 모양(Number(env.X ?? 기본값))이 남지 않았는지
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { envNumber } from "../src/env.js";

test("envNumber: 없음·빈 문자열·공백만 = 기본값, 그 밖은 Number 그대로", () => {
  assert.equal(envNumber(undefined, 3), 3);
  assert.equal(envNumber("", 3), 3);
  assert.equal(envNumber("  ", 3), 3);
  assert.equal(envNumber("0", 3), 0);          // 0 은 일부러 준 값 (METRICS_PORT=0 = 끔)
  assert.equal(envNumber("20", 3), 20);
  assert.equal(envNumber("0.5", 3), 0.5);      // 초 단위 소수 (TRAFFIC_OBSERVE_SEC 같은 것)
  assert.equal(envNumber(" 7 ", 3), 7);        // Number 와 같게 앞뒤 공백 허용
  assert.ok(Number.isNaN(envNumber("abc", 3))); // 예전과 같음: 글자는 NaN (바꾸지 않음)
});

test("앱 코드에 Number(process.env.X ?? …) / Number(env.X ?? …) 가 남지 않았다 (api·worker·core·adapters·contracts src)", () => {
  const root = new URL("../../../", import.meta.url).pathname;
  const dirs = ["apps/api/src", "apps/worker/src", "packages/core/src", "packages/adapters/src", "packages/contracts/src"];
  const bad: string[] = [];
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".ts")) readFileSync(p, "utf8").split("\n").forEach((l, i) => {
        if (!l.trimStart().startsWith("//") && /Number\((process\.)?env\.[A-Z_]+ \?\?/.test(l)) bad.push(`${p.slice(root.length)}:${i + 1}`);
      });
    }
  };
  for (const d of dirs) walk(join(root, d));
  assert.deepEqual(bad, [], "envNumber(process.env.X, 기본값) 로 바꾼다");
});
