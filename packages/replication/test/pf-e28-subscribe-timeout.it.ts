// PF-E28 (hdd-06): 출발이 응답하지 않으면 CREATE SUBSCRIPTION 이 오래 막혔다(connect_timeout 무시, ~134초). 세션 statement_timeout 으로 끊고 구독을 안 남긴다
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import net from "node:net";
import { withClient } from "../src/index.js";
import { ensureSubscription } from "../src/replicate.js";
import { SOURCE, TARGET, q, reachable } from "./harness.js";

const up = await reachable(TARGET);
const skip = up ? false : "Postgres(55433) 없음";
const NAME = "repl_pfe28_fwd";
let srv: net.Server; let port = 0;
const socks: net.Socket[] = [];
const saved = { a: process.env.REPL_SUBSCRIBE_TIMEOUT_SEC, b: process.env.REPL_PEER_CONNECT_TIMEOUT_SEC };

before(async () => {
  // 받기만 하고 아무 말도 안 하는 "출발" (멈춘 중계기·터널과 같은 처지)
  srv = net.createServer((s) => { socks.push(s); });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  port = (srv.address() as net.AddressInfo).port;
});
after(async () => {
  for (const s of socks) s.destroy();
  srv.close();
  for (const [k, v] of [["REPL_SUBSCRIBE_TIMEOUT_SEC", saved.a], ["REPL_PEER_CONNECT_TIMEOUT_SEC", saved.b]] as const)
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  if (up) await q(TARGET, `DROP SUBSCRIPTION IF EXISTS ${NAME}`).catch(() => undefined);
});

test("PF-E28: 말 없는 출발이면 REPL_SUBSCRIBE_TIMEOUT_SEC 안에 실패하고 구독이 안 남는다", { skip }, async () => {
  process.env.REPL_SUBSCRIBE_TIMEOUT_SEC = "2";
  process.env.REPL_PEER_CONNECT_TIMEOUT_SEC = "0";   // 접속 문자열 쪽 시간 제한은 끄고 이 고침만 본다
  const from = { ...SOURCE, peerUrl: `postgres://postgres:postgres@127.0.0.1:${port}/app` };
  const t0 = Date.now();
  await assert.rejects(() => withClient(TARGET, (c) => ensureSubscription(c, from, NAME, { copyData: false, createSlot: true })), /statement timeout|canceling/);
  const ms = Date.now() - t0;
  assert.ok(ms < 10_000, `${ms}ms`);
  assert.deepEqual(await q(TARGET, `SELECT subname FROM pg_subscription WHERE subname=$1`, [NAME]), []);
  // 같은 연결 설정이 다음 문장에 안 샌다 (RESET)
  const [r] = await q(TARGET, `SHOW statement_timeout`);
  assert.equal(r.statement_timeout, "0");
});
