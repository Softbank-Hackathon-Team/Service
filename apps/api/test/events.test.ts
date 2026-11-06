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
import { authPlugin, type AuthPluginOptions } from "../src/plugins/auth.js";
import { eventRoutes, streamLifetimeMs, streamUserId, MAX_STREAM_MS } from "../src/routes/events.js";
import { EventHub, type Listen } from "../src/events-hub.js";
import { signAccess, type AccessClaims } from "../src/auth/jwt.js";
import { hashPat, newPat, type PatRow } from "../src/auth/pat.js";

const T = "11111111-1111-4111-8111-111111111111";
const OTHER = "99999999-9999-4999-8999-999999999999";
const M = "22222222-2222-4222-8222-222222222222";
const M2 = "33333333-3333-4333-8333-333333333333";
const U = "66666666-6666-4666-8666-666666666666";
const U2 = "44444444-4444-4444-8444-444444444444";
const SECRET = "s".repeat(40);
const notifyOf = (t: string, id: string, s: string) => JSON.stringify({ t, id, s });
const sessionOf = (t: string, u: string, r: string) => JSON.stringify({ t, u, r });
// 진짜 로그인과 같은 Bearer 토큰. 서명 비밀은 시험 동안만 env 에 둔다 (jwtSecret 이 요청마다 env 를 읽는다)
const bearerFor = (tid: string, sub = U, ttlSec = 900) => `Bearer ${signAccess({ sub, tid, sid: "77777777-7777-4777-8777-777777777777",
  fam: "88888888-8888-4888-8888-888888888888", email: "a@b.c" }, Buffer.from(SECRET), ttlSec)}`;
async function withEnv(vars: Record<string, string>, fn: () => Promise<void>) {
  const prev = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try { await fn(); } finally {
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}
const withSecret = (fn: () => Promise<void>) => withEnv({ JWT_SECRET: SECRET }, fn);

function fakeListen() {
  const box: { calls: number; closed: number; h: ListenHandlers | null } = { calls: 0, closed: 0, h: null };
  const listen: Listen = (h) => { box.calls++; box.h = h; return { close: async () => { box.closed++; } }; };
  return { listen, box };
}
/** 허브 + 가짜 듣기 둘 (box = migration_events, sessions = session_events) */
function fakeHub() {
  const m = fakeListen(), s = fakeListen();
  return { hub: new EventHub(m.listen, s.listen), box: m.box, sessions: s.box };
}

// CLI 개인 토큰 하나 (사용자 U, 회사 T). 인증 훅은 해시로 찾는다
const PAT = newPat();
const patRows = new Map<string, PatRow>([[hashPat(PAT), { tokenId: "55555555-5555-4555-8555-555555555555", tenantId: T, userId: U,
  expiresAt: new Date(Date.now() + 86_400_000), revoked: false }]]);
const lookupPat: NonNullable<AuthPluginOptions["lookupPat"]> = async (h) => patRows.get(h);

async function serve(hub: EventHub, o: { heartbeatMs?: number; maxStreamMs?: number; auth?: AuthPluginOptions } = {}) {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(errorsPlugin);
  await app.register(authPlugin, o.auth ?? {});
  await app.register(eventRoutes, { prefix: "/api/v1", hub, heartbeatMs: o.heartbeatMs ?? 60_000, maxStreamMs: o.maxStreamMs });
  const address = await app.listen({ port: 0, host: "127.0.0.1" });
  return { app, url: `${address}/api/v1/events` };
}

interface Opened {
  status: number; headers: http.IncomingHttpHeaders;
  until: (p: RegExp, ms?: number) => Promise<string>;
  /** 서버가 응답을 끝낼 때까지 기다린다 */
  ended: (ms?: number) => Promise<void>;
  isEnded: () => boolean;
  abort: () => void;
}
/** 스트림을 열고, 글자를 모으며 기다리는 도구를 돌려준다 */
function open(url: string, headers: Record<string, string>) {
  return new Promise<Opened>(
    (resolve, reject) => {
      let aborted = false;
      const req = http.get(url, { headers, agent: false }, (res) => {
        let text = "";
        let done = false;
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => { text += chunk; });
        res.on("end", () => { done = true; });
        res.on("error", () => {});
        const until = async (pattern: RegExp, ms = 2000) => {
          const deadline = Date.now() + ms;
          while (!pattern.test(text)) {
            if (Date.now() > deadline) throw new Error(`timeout waiting for ${pattern}; got ${JSON.stringify(text)}`);
            await new Promise((r) => setTimeout(r, 10));
          }
          return text;
        };
        const ended = (ms = 2000) => waitFor(() => done, ms);
        resolve({ status: res.statusCode ?? 0, headers: res.headers, until, ended, isEnded: () => done, abort: () => { aborted = true; req.destroy(); } });
      });
      req.on("error", (e) => { if (!aborted) reject(e); });
    });
}

const waitFor = async (ok: () => boolean, ms = 2000) => {
  const deadline = Date.now() + ms;
  while (!ok()) { if (Date.now() > deadline) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 10)); }
};

test("EventHub: 같은 회사 구독자에게만 상태 변경을 보내고, 모양이 틀린 알림은 버린다", () => {
  const { hub, box } = fakeHub();
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

test("EventHub: 세션 끊김 알림은 그 회사·사용자의 구독만 풀고 닫는다", () => {
  const { hub, sessions } = fakeHub();
  const closed: string[] = [];
  const got: Record<string, unknown[]> = { u1: [], u2: [], peer: [], other: [], dev: [] };
  const sub = (tenant: string, name: string, userId?: string) =>
    hub.subscribe(tenant, (e) => got[name]!.push(e), { userId, close: () => closed.push(name) });
  sub(T, "u1", U);
  sub(T, "u2", U);          // 같은 사용자의 다른 탭
  sub(T, "peer", U2);       // 같은 회사 다른 사용자
  sub(OTHER, "other", U);   // 다른 회사 (같은 번호라도 회사가 다르면 안 닫힌다)
  sub(T, "dev");            // 사용자 번호 없음 (개발용 헤더) → 세션 알림으로는 안 닫힌다
  assert.equal(hub.size, 5);
  sessions.h!.onNotify(sessionOf(T, U, "logout"));
  assert.deepEqual(closed.sort(), ["u1", "u2"]);
  assert.equal(hub.size, 3);
  // 닫힌 구독에는 더 안 가고, 남은 구독은 그대로 받는다
  hub.notify(notifyOf(T, M, "deploying"));
  hub.notify(notifyOf(OTHER, M2, "failed"));
  assert.deepEqual([got.u1!.length, got.u2!.length, got.peer!.length, got.other!.length, got.dev!.length], [0, 0, 1, 1, 1]);
  // 같은 알림이 또 와도 아무 일 없다
  sessions.h!.onNotify(sessionOf(T, U, "disabled"));
  assert.equal(closed.length, 2);
});

test("EventHub: 모양이 틀린 세션 알림은 버린다", () => {
  const { hub, sessions } = fakeHub();
  let closed = 0;
  hub.subscribe(T, () => {}, { userId: U, close: () => { closed++; } });
  for (const p of [
    "not json",
    sessionOf(T, U, "other"),                                     // 모르는 이유
    JSON.stringify({ t: T, u: U, r: "logout", email: "a@b.c" }),  // 칸이 더 있음 (strict)
    sessionOf("not-a-uuid", U, "logout"),
    JSON.stringify({ t: T, u: U }),                               // 이유 없음
    notifyOf(T, M, "deploying"),                                  // 다른 채널 모양
  ]) sessions.h!.onNotify(p);
  assert.equal(closed, 0);
  assert.equal(hub.size, 1);
});

test("EventHub: 세션 알림도 첫 구독 때 한 번만 듣기 시작하고, close 때 함께 끝낸다", async () => {
  const { hub, box, sessions } = fakeHub();
  assert.deepEqual([box.calls, sessions.calls], [0, 0]);         // 만들기만 해서는 DB 에 안 붙는다
  hub.subscribe(T, () => {});
  hub.subscribe(OTHER, () => {}, { userId: U });
  assert.deepEqual([box.calls, sessions.calls], [1, 1]);
  await hub.close();
  assert.deepEqual([box.closed, sessions.closed], [1, 1]);
  assert.equal(hub.size, 0);
});

test("streamLifetimeMs: JWT 는 exp 까지(상한 안), 이미 지났으면 0, 만료 시각이 없으면 상한", () => {
  const now = 1_800_000_000_000;
  const sec = now / 1000;
  assert.equal(streamLifetimeMs({ exp: sec + 60 }, 900_000, now), 60_000);
  assert.equal(streamLifetimeMs({ exp: sec + 3600 }, 900_000, now), 900_000);   // 접근 토큰 수명을 길게 바꿔도 상한
  assert.equal(streamLifetimeMs({ exp: sec - 10 }, 900_000, now), 0);           // 시계 오차 안이라 인증은 통과한 토큰
  assert.equal(streamLifetimeMs(null, 900_000, now), 900_000);
  assert.equal(streamLifetimeMs(null), MAX_STREAM_MS);
});

test("streamUserId: JWT 는 sub, 개인 토큰은 actor 의 번호, 개발용 헤더는 없음", () => {
  assert.equal(streamUserId({ auth: { sub: U } as AccessClaims, actor: `user:${U}` }), U);
  assert.equal(streamUserId({ auth: null, actor: `user:${U2}` }), U2);
  assert.equal(streamUserId({ auth: null, actor: "user:dev" }), null);
  assert.equal(streamUserId({ auth: null, actor: "user:dev-tunnel" }), null);
  assert.equal(streamUserId({ auth: null, actor: "" }), null);
});

test("GET /events: 로그인 없거나 토큰이 틀리면 401, 구독하지 않는다", async () => {
  const { hub, box, sessions } = fakeHub();
  const { app } = await serve(hub);
  try {
    const none = await app.inject({ method: "GET", url: "/api/v1/events" });
    assert.equal(none.statusCode, 401);
    const bad = await app.inject({ method: "GET", url: "/api/v1/events", headers: { authorization: "Bearer not.a.token" } });
    assert.equal(bad.statusCode, 401);
    assert.equal(box.calls, 0);
    assert.equal(sessions.calls, 0);
    assert.equal(hub.size, 0);
  } finally {
    await app.close();
  }
});

test("GET /events: Bearer 로그인 회사의 신호만 data 줄로 오고, 다른 회사 알림은 안 온다", () => withSecret(async () => {
  const { hub, box } = fakeHub();
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
  const { hub, box, sessions } = fakeHub();
  const { app, url } = await serve(hub, { heartbeatMs: 30 });
  let closed = false;
  try {
    const s = await open(url, { authorization: bearerFor(T) });
    await s.until(/: ping\n\n/);
    // 열린 연결이 있어도 close 가 멈추지 않는다 (preClose 가 먼저 끝낸다). 닫으면 듣기도 끝낸다
    await Promise.race([app.close(), new Promise((_, no) => setTimeout(() => no(new Error("close hung")), 3000))]);
    closed = true;
    assert.equal(hub.size, 0);
    assert.equal(box.closed, 1);
    assert.equal(sessions.closed, 1);
    s.abort();
  } finally {
    if (!closed) await app.close();
  }
}));

test("GET /events: 연결을 연 토큰이 만료되면 서버가 끊는다 (JWT exp)", () => withSecret(async () => {
  const { hub } = fakeHub();
  const { app, url } = await serve(hub, { maxStreamMs: 60_000 });
  try {
    // exp 는 초 단위라 ttl 1초면 남은 시간이 0~1초다. 0에 가까우면 붙자마자 끊겨 아래 확인이 흔들린다 → 2초 (남은 1~2초)
    const s = await open(url, { authorization: bearerFor(T, U, 2) });
    assert.equal(s.status, 200);
    await s.until(/retry: 3000\n\n/);
    await waitFor(() => hub.size === 1);
    await s.ended(4000);                       // 상한(60초)이 아니라 exp 에 끊긴다
    await waitFor(() => hub.size === 0);
  } finally {
    await app.close();
  }
}));

test("GET /events: 만료 시각을 모르는 연결(개인 토큰·개발용 헤더)과 긴 JWT 는 상한에 끊는다", () => withEnv({ JWT_SECRET: SECRET, DEV_AUTH: "1" }, async () => {
  const { hub } = fakeHub();
  const { app, url } = await serve(hub, { maxStreamMs: 150, auth: { lookupPat } });
  try {
    const pat = await open(url, { authorization: `Bearer ${PAT}` });
    const dev = await open(url, { "x-dev-tenant": T });
    const jwt = await open(url, { authorization: bearerFor(T) });        // 900초짜리
    assert.deepEqual([pat.status, dev.status, jwt.status], [200, 200, 200]);
    await Promise.all([pat, dev, jwt].map((s) => s.ended()));
    await waitFor(() => hub.size === 0);
  } finally {
    await app.close();
  }
}));

test("GET /events: 세션 끊김 알림이 오면 그 회사·사용자의 연결만 닫힌다", () => withEnv({ JWT_SECRET: SECRET, DEV_AUTH: "1" }, async () => {
  const { hub, sessions } = fakeHub();
  const { app, url } = await serve(hub, { auth: { lookupPat } });
  const all: Opened[] = [];
  try {
    const mine = await open(url, { authorization: bearerFor(T, U) });
    const pat = await open(url, { authorization: `Bearer ${PAT}` });     // 같은 사용자 U 의 CLI 개인 토큰
    const peer = await open(url, { authorization: bearerFor(T, U2) });
    const other = await open(url, { authorization: bearerFor(OTHER, U) });
    const dev = await open(url, { "x-dev-tenant": T });                  // 사용자 번호 없음
    all.push(mine, pat, peer, other, dev);
    for (const s of all) await s.until(/retry: 3000\n\n/);
    await waitFor(() => hub.size === 5);
    sessions.h!.onNotify(sessionOf(T, U, "disabled"));
    await mine.ended();
    await pat.ended();
    await waitFor(() => hub.size === 3);
    hub.notify(notifyOf(T, M, "cutover"));
    hub.notify(notifyOf(OTHER, M2, "failed"));
    await peer.until(/cutover/);
    await dev.until(/cutover/);
    await other.until(/failed/);
    assert.deepEqual([peer, other, dev].map((s) => s.isEnded()), [false, false, false]);
  } finally {
    for (const s of all) s.abort();
    await app.close();
  }
}));
