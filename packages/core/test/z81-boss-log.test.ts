// Z81-05: pg-boss error 이벤트가 JSON 한 줄(component=pg-boss)로 찍히는지. DB 없이 돈다 (boss 는 만들기만 하고 start 안 함)
import { test } from "node:test";
import assert from "node:assert/strict";
import { boss } from "../src/boss.js";

test("pg-boss error → JSON 한 줄, level error, component pg-boss, 오류는 type·message 만", () => {
  const lines: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  (process.stdout as { write: unknown }).write = (s: string) => { lines.push(String(s)); return true; };
  try { boss.emit("error", Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" })); }
  finally { (process.stdout as { write: unknown }).write = orig; }
  const j = JSON.parse(lines.find((l) => l.includes("pg-boss error"))!);
  assert.equal(j.level, "error");
  assert.equal(j.component, "pg-boss");
  assert.deepEqual({ type: j.err.type, message: j.err.message, code: j.err.code }, { type: "Error", message: "connect ECONNREFUSED", code: "ECONNREFUSED" });
});
