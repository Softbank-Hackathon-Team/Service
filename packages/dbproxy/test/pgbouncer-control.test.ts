// Z64: PgBouncer 제어 옆차 단위 시험 (가짜 관리 콘솔). 진짜 PgBouncer 로 한 시험은 tools/load/live-app/run-z31.sh MODE=pgbouncer
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PgbControl, dbLine, parseUpstreams } from "../src/pgbouncer-control.js";

function fake(opts: { pauseMs?: number; svActive?: number } = {}) {
  const calls: string[] = [];
  const q = async (sql: string) => {
    calls.push(sql);
    if (sql.startsWith("PAUSE")) await new Promise((r) => setTimeout(r, opts.pauseMs ?? 0));
    if (sql === "SHOW POOLS") return [{ database: "shop", cl_active: 3, cl_waiting: 2, sv_active: opts.svActive ?? 0, maxwait: 0, maxwait_us: 40000 }];
    return [];
  };
  return { q, calls };
}
const mk = (q: (s: string) => Promise<Record<string, unknown>[]>, dir: string) => new PgbControl({
  adminUrl: "x", db: "shop", serverDb: "shop", dbFile: join(dir, "databases.ini"),
  upstreams: parseUpstreams("source=a:5432,target=b:6543"), active: "source", drainTimeoutMs: 100, holdMaxMs: 60_000, log: () => {},
}, q);

test("dbLine 은 [databases] 한 줄만 쓴다", () => {
  assert.equal(dbLine({ db: "shop", serverDb: "shop", extra: "pool_size=5" }, { host: "h", port: 1 }), "[databases]\nshop = host=h port=1 dbname=shop pool_size=5\n");
  assert.throws(() => dbLine({ db: "shop; drop", serverDb: "shop" }, { host: "h", port: 1 }));
});

test("pause → resume(target): PAUSE, 파일 바꾸고 RELOAD, RESUME 순서", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pgb-"));
  const f = fake(); const c = mk(f.q, dir);
  await c.init();
  assert.match(readFileSync(join(dir, "databases.ini"), "utf8"), /host=a port=5432/);
  const p = await c.pause();
  assert.equal(p.leftBusy, 0);
  const r = await c.resume("target");
  assert.equal(r.previous, "source"); assert.equal(r.released, 2); assert.equal(r.maxWaitMs, 40);
  assert.match(readFileSync(join(dir, "databases.ini"), "utf8"), /host=b port=6543/);
  const cmds = f.calls.filter((s) => s !== "SHOW POOLS");
  assert.deepEqual(cmds, ["RELOAD", "PAUSE shop", "RELOAD", "RESUME shop"]);
  assert.equal(c.active, "target"); assert.equal(c.paused, false);
});

test("드레인 시간 초과: PAUSE 가 안 끝나도 leftBusy 를 세어 돌아온다", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pgb-"));
  const f = fake({ pauseMs: 400, svActive: 1 }); const c = mk(f.q, dir);
  const p = await c.pause(50);
  assert.equal(p.leftBusy, 1);
  await c.resume("source");
  assert.ok(f.calls.includes("RESUME shop"));
  assert.ok(!f.calls.includes("RELOAD"), "같은 대상이면 RELOAD 안 함");
});

test("모르는 upstream 은 거부", async () => {
  const c = mk(fake().q, mkdtempSync(join(tmpdir(), "pgb-")));
  await assert.rejects(c.resume("nope"), /unknown upstream/);
});

test("Z38 REVIEW-4 P-2: PAUSE 가 실패하면 '다 비움'으로 보고하지 않고 던진다 (상태·타이머 원래대로)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pgb-"));
  const f = fake();
  const q = async (sql: string) => { if (sql.startsWith("PAUSE")) throw new Error("password authentication failed"); return f.q(sql); };
  const c = mk(q, dir);
  await assert.rejects(c.pause(), /PAUSE shop failed: .*password/);
  assert.equal(c.paused, false);
  // 다음 시도는 처음부터 다시 PAUSE 를 보낸다 (실패한 약속을 붙들고 있지 않음)
  await assert.rejects(c.pause(), /PAUSE shop failed/);
});
