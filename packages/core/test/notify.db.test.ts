// 화면 신호(SSE)가 쓰는 DB 알림 듣기 (notify.ts listenChannel). 진짜 Postgres 로:
//   알림을 받는가 / 트랜잭션이 취소되면 알림도 안 오는가(advance 는 확정 때만 보낸다) / 연결이 끊기면 다시 붙고 onListening 을 또 부르는가 / 닫으면 멈추는가
// 끊는 방법: 소유자 계정으로 이 시험의 LISTEN 연결 pid 만 골라 pg_terminate_backend (pool-recovery.db.test 와 같은 방법)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import pg from "pg";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;
const CH = `t_notify_${randomBytes(4).toString("hex")}`;
let core: typeof import("@svc/core");
let owner: pg.Client;

before(async () => {
  if (skip) return;
  core = await import("@svc/core");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
});
after(async () => {
  if (skip) return;
  await core.pool.end(); await owner.end();
});

const waitFor = async (ok: () => boolean, ms = 5000) => {
  const deadline = Date.now() + ms;
  while (!ok()) { if (Date.now() > deadline) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 20)); }
};
const send = (payload: string) => core.pool.query("SELECT pg_notify($1, $2)", [CH, payload]);
const listenerPid = () => owner.query(
  "SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND query = $1 AND state = 'idle'", [`LISTEN ${CH}`],
).then((r) => r.rows.map((x) => x.pid as number));

test("채널 이름은 영문 소문자·숫자·밑줄만 (LISTEN 은 매개변수를 못 받아 SQL 에 그대로 들어간다)", { skip }, () => {
  assert.throws(() => core.listenChannel("x; DROP TABLE tenants", { onNotify: () => {} }), /invalid channel name/);
});

test("알림을 받고, 취소된 트랜잭션의 알림은 안 오고, 끊기면 다시 붙어 onListening 을 또 부르고, 닫으면 멈춘다", { skip }, async () => {
  const got: string[] = [];
  let listening = 0;
  const l = core.listenChannel(CH, { onNotify: (p) => got.push(p), onListening: () => { listening++; } }, { retryMs: 100 });
  try {
    await waitFor(() => listening === 1);
    await send("one");
    await waitFor(() => got.includes("one"));

    // advance 처럼 트랜잭션 안에서 보낸 알림은 확정될 때만 나간다
    const c = await core.pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT pg_notify($1, 'rolled-back')", [CH]);
      await c.query("ROLLBACK");
    } finally { c.release(); }
    await send("two");
    await waitFor(() => got.includes("two"));
    assert.equal(got.includes("rolled-back"), false);

    // 연결이 서버 쪽에서 끊김 → 다시 붙고 onListening 한 번 더 (그 사이 알림을 놓쳤을 수 있다는 신호)
    const pids = await listenerPid();
    assert.equal(pids.length, 1);
    await owner.query("SELECT pg_terminate_backend($1)", [pids[0]]);
    await waitFor(() => listening === 2);
    await send("three");
    await waitFor(() => got.includes("three"));
  } finally {
    await l.close();
  }
  await send("after-close");
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(got.includes("after-close"), false);
  assert.deepEqual(await listenerPid(), []);
});
