// 화면 신호 (SSE, GET /api/v1/events). DB 없이: LISTEN 대신 가짜 듣기를 끼우고, 실제 포트에 띄워 node:http 로 스트림을 읽는다
// (app.inject 는 끝나지 않는 응답을 기다리기만 해서 스트림을 못 본다). 진짜 LISTEN 은 core 의 notify.db.test 가 본다
// fetch(undici) 대신 node:http + agent:false: 연결을 시험이 직접 닫아야 app.close() 가 남은 연결을 기다리지 않는다
import http from "node:http";
import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import type { ListenHandlers } from "@svc/core";
import { errorsPlugin } from "../src/plugins/errors.js";
import { authPlugin } from "../src/plugins/auth.js";
import { eventRoutes } from "../src/routes/events.js";
import { EventHub, type Listen } from "../src/events-hub.js";
import { signAccess } from "../src/auth/jwt.js";

const T = "11111111-1111-4111-8111-111111111111";
const OTHER = "99999999-9999-4999-8999-999999999999";
const M = "22222222-2222-4222-8222-222222222222";
const M2 = "33333333-3333-4333-8333-333333333333";
const SECRET = "s".repeat(40);
const notifyOf = (t: string, id: string, s: string) => JSON.stringify({ t, id, s });
// 진짜 로그인과 같은 Bearer 토큰. 서명 비밀은 시험 동안만 env 에 둔다 (jwtSecret 이 요청마다 env 를 읽는다)
const bearerFor = (tid: string) => `Bearer ${signAccess({ sub: "66666666-6666-4666-8666-666666666666", tid, sid: "77777777-7777-4777-8777-777777777777",
  fam: "88888888-8888-4888-8888-888888888888", email: "a@b.c" }, Buffer.from(SECRET), 900)}`;
async function withSecret(fn: () => Promise<void>) {
  const prev = process.env.JWT_SECRET;
  process.env.JWT_SECRET = SECRET;
  try { await fn(); } finally { if (prev === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = prev; }
}

function fakeListen() {
  const box: { calls: number; closed: number; h: ListenHandlers | null } = { calls: 0, closed: 0, h: null };
  const listen: Listen = (h) => { box.calls++; box.h = h; return { close: async () => { box.closed++; } }; };
  return { listen, box };
}

async function serve(hub: EventHub, heartbeatMs = 60_000) {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(errorsPlugin);
  await app.register(authPlugin);
  await app.register(eventRoutes, { prefix: "/api/v1", hub, heartbeatMs });
  const address = await app.listen({ port: 0, host: "127.0.0.1" });
  return { app, url: `${address}/api/v1/events` };
}

/** 스트림을 열고, 글자를 모으며 기다리는 도구를 돌려준다 */
function open(url: string, headers: Record<string, string>) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; until: (p: RegExp, ms?: number) => Promise<string>; abort: () => void }>(
    (resolve, reject) => {
      let aborted = false;
      const req = http.get(url, { headers, agent: false }, (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => { text += chunk; });
        res.on("error", () => {});
        const until = async (pattern: RegExp, ms = 2000) => {
          const deadline = Date.now() + ms;
          while (!pattern.test(text)) {
            if (Date.now() > deadline) throw new Error(`timeout waiting for ${pattern}; got ${JSON.stringify(text)}`);
            await new Promise((r) => setTimeout(r, 10));
          }
          return text;
        };
        resolve({ status: res.statusCode ?? 0, headers: res.headers, until, abort: () => { aborted = true; req.destroy(); } });
      });
      req.on("error", (e) => { if (!aborted) reject(e); });
    });
}

const waitFor = async (ok: () => boolean, ms = 2000) => {
  const deadline = Date.now() + ms;
  while (!ok()) { if (Date.now() > deadline) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 10)); }
};

test("EventHub: 같은 회사 구독자에게만 상태 변경을 보내고, 모양이 틀린 알림은 버린다", () => {
  const { listen, box } = fakeListen();
  const hub = new EventHub(listen);
  const mine: unknown[] = [], other: unknown[] = [];
  const offMine = hub.subscribe(T, (e) => mine.push(e));
  hub.subscribe(OTHER, (e) => other.push(e));
  assert.equal(box.calls, 1);                       // 듣기는 첫 구독 때 한 번만
  hub.notify(notifyOf(T, M, "deploying"));
  hub.notify("not json");
  hub.notify(JSON.stringify({ t: T, id: M, s: "no_such_status" }));
  hub.notify(JSON.stringify({ t: "not-a-uuid", id: M, s: "deploying" }));
  assert.deepEqual(mine, [{ type: "migration.status_changed", migrationId: M, status: "deploying" }]);
  assert.deepEqual(other, []);
  box.h!.onListening!();                            // 다시 붙음 → 모두에게 전부 다시 읽기
  assert.deepEqual(mine.at(-1), { type: "reload_all" });
  assert.deepEqual(other, [{ type: "reload_all" }]);
  offMine();
  hub.notify(notifyOf(T, M, "syncing"));
  assert.equal(mine.length, 2);
  assert.equal(hub.size, 1);
});

test("GET /events: 로그인 없거나 토큰이 틀리면 401, 구독하지 않는다", async () => {
  const { listen, box } = fakeListen();
  const hub = new EventHub(listen);
  const { app } = await serve(hub);
  try {
    const none = await app.inject({ method: "GET", url: "/api/v1/events" });
    assert.equal(none.statusCode, 401);
    const bad = await app.inject({ method: "GET", url: "/api/v1/events", headers: { authorization: "Bearer not.a.token" } });
    assert.equal(bad.statusCode, 401);
    assert.equal(box.calls, 0);
    assert.equal(hub.size, 0);
  } finally {
    await app.close();
  }
});

test("GET /events: Bearer 로그인 회사의 신호만 data 줄로 오고, 다른 회사 알림은 안 온다", () => withSecret(async () => {
  const { listen, box } = fakeListen();
  const hub = new EventHub(listen);
  const { app, url } = await serve(hub);
  try {
    const s = await open(url, { authorization: bearerFor(T) });
    assert.equal(s.status, 200);
    assert.match(s.headers["content-type"] ?? "", /^text\/event-stream/);
    assert.equal(s.headers["cache-control"], "no-cache, no-transform");
    await s.until(/retry: 3000\n\n/);
    await waitFor(() => hub.size === 1);
    hub.notify(notifyOf(OTHER, M2, "failed"));   // 남의 회사: 오면 안 된다
    hub.notify(notifyOf(T, M, "cutover"));
    const text = await s.until(/cutover/);
    assert.doesNotMatch(text, new RegExp(M2));
    assert.match(text, /data: \{"type":"migration.status_changed","migrationId":"2{8}-2{4}-4222-8222-2{12}","status":"cutover"\}\n\n/);
    box.h!.onListening!();
    await s.until(/"type":"reload_all"/);
    s.abort();
    await waitFor(() => hub.size === 0);         // 브라우저가 끊으면 구독이 풀린다
  } finally {
    await app.close();
  }
}));

test("GET /events: 쉬는 동안 주석 줄을 보내고, 연결이 열린 채로도 서버가 닫힌다", () => withSecret(async () => {
  const { listen, box } = fakeListen();
  const hub = new EventHub(listen);
  const { app, url } = await serve(hub, 30);
  let closed = false;
  try {
    const s = await open(url, { authorization: bearerFor(T) });
    await s.until(/: ping\n\n/);
    // 열린 연결이 있어도 close 가 멈추지 않는다 (preClose 가 먼저 끝낸다). 닫으면 듣기도 끝낸다
    await Promise.race([app.close(), new Promise((_, no) => setTimeout(() => no(new Error("close hung")), 3000))]);
    closed = true;
    assert.equal(hub.size, 0);
    assert.equal(box.closed, 1);
    s.abort();
  } finally {
    if (!closed) await app.close();
  }
}));
