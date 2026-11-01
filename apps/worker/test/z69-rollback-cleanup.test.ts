// 단위 시험(작업 Z69): 롤백 뒤 복제 걷기. DB 없이 가짜 객체로 규칙만 본다.
// 규칙: 항상 teardown → leftovers 확인. 실패·찌꺼기는 ok=false + warning (예외를 던지지 않는다 = 롤백 실패로 안 번짐)
import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanupAfterRollback, type ReplCleaner } from "../src/jobs/rollback-cleanup.js";

function fake(o: { teardown?: () => Promise<{ removed: string[] }>; leftovers?: () => Promise<string[]> }) {
  const calls: string[] = [];
  const r: ReplCleaner = {
    teardown: async () => { calls.push("teardown"); return o.teardown ? o.teardown() : { removed: [] }; },
    leftovers: async () => { calls.push("leftovers"); return o.leftovers ? o.leftovers() : []; },
  };
  return { r, calls };
}

test("Z69: 걷기 성공 + 찌꺼기 0 → ok, warning 없음, teardown 다음 leftovers 순서", async () => {
  const { r, calls } = fake({ teardown: async () => ({ removed: ["dst:subscription:repl_x_fwd", "src:slot:repl_x_fwd"] }) });
  const c = await cleanupAfterRollback(r);
  assert.deepEqual(calls, ["teardown", "leftovers"]);
  assert.equal(c.ok, true);
  assert.deepEqual(c.removed, ["dst:subscription:repl_x_fwd", "src:slot:repl_x_fwd"]);
  assert.deepEqual(c.leftovers, []);
  assert.equal(c.warning, undefined);
});

test("Z69: teardown 예외 → 던지지 않고 ok=false + warning, leftovers는 그래도 확인", async () => {
  const { r, calls } = fake({
    teardown: async () => { throw new Error("permission denied to drop replication slot"); },
    leftovers: async () => ["src:slot:repl_x_fwd", "dst:subscription:repl_x_fwd"],
  });
  const c = await cleanupAfterRollback(r);
  assert.deepEqual(calls, ["teardown", "leftovers"]);
  assert.equal(c.ok, false);
  assert.deepEqual(c.removed, []);
  assert.deepEqual(c.leftovers, ["src:slot:repl_x_fwd", "dst:subscription:repl_x_fwd"]);
  assert.match(c.warning!, /teardown failed: permission denied/);
  assert.match(c.warning!, /replication objects remain: src:slot:repl_x_fwd/);
});

test("Z69: 걷기는 됐지만 슬롯이 active라 남음(dropSlotIfIdle 5초 초과) → ok=false, 남은 이름이 warning에", async () => {
  const { r } = fake({ teardown: async () => ({ removed: ["dst:subscription:repl_x_fwd"] }), leftovers: async () => ["src:slot:repl_x_fwd"] });
  const c = await cleanupAfterRollback(r);
  assert.equal(c.ok, false);
  assert.deepEqual(c.removed, ["dst:subscription:repl_x_fwd"]);
  assert.match(c.warning!, /src:slot:repl_x_fwd/);
});

test("Z69: leftovers 확인 자체가 실패(연결 끊김) → leftovers=null, ok=false", async () => {
  const { r } = fake({ teardown: async () => ({ removed: ["a"] }), leftovers: async () => { throw new Error("connect ECONNREFUSED"); } });
  const c = await cleanupAfterRollback(r);
  assert.equal(c.ok, false);
  assert.equal(c.leftovers, null);
  assert.match(c.warning!, /leftovers check failed: connect ECONNREFUSED/);
});

test("Z69: 아주 긴 오류 문구도 warning은 500자 이하", async () => {
  const { r } = fake({ teardown: async () => { throw new Error("x".repeat(2000)); }, leftovers: async () => Array.from({ length: 50 }, (_, i) => `src:slot:repl_${i}_fwd`) });
  const c = await cleanupAfterRollback(r);
  assert.ok(c.warning!.length <= 500, String(c.warning!.length));
});
