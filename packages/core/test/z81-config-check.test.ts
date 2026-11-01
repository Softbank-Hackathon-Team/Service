// Z81-09: assertConfig 는 문제가 있으면 목록을 내고 끝 코드 2, 없으면 아무것도 안 한다
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertConfig } from "../src/config-check.js";

test("문제 있음 → 끝 코드 2 + 사람용 목록, 없음 → 그대로", () => {
  const codes: number[] = []; const lines: string[] = [];
  const out = process.stdout.write.bind(process.stdout);
  (process.stdout as { write: unknown }).write = () => true;   // JSON 로그 줄은 여기선 안 본다
  try {
    assertConfig("api", { env: { API_PORT: "abc" }, exit: (c) => codes.push(c), log: (l) => lines.push(l) });
    assertConfig("api", { env: { DATABASE_URL: "postgres://u@h/d" }, exit: (c) => codes.push(c), log: (l) => lines.push(l) });
  } finally { (process.stdout as { write: unknown }).write = out; }
  assert.deepEqual(codes, [2]);
  assert.match(lines[0]!, /설정 오류 2개/);
  assert.ok(lines.some((l) => l.includes("API_PORT: 숫자가 아님")));
});
