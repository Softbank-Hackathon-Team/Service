// L8: 요청마다 사용자 재확인 — DB 없이 (확인 함수를 주입). 정상 1 + 끈 사용자 거부 1 + 계약
import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { authPlugin, type UserRecheck } from "../src/plugins/auth.js";
import { signAccess } from "../src/auth/jwt.js";
import { NotifySession } from "@svc/contracts";

const T = "11111111-1111-4111-8111-111111111111";
const U = "66666666-6666-4666-8666-666666666666";
const S = "77777777-7777-4777-8777-777777777777";
const F = "88888888-8888-4888-8888-888888888888";

async function app(recheckUser?: UserRecheck) {
  const prev = process.env.JWT_SECRET;
  process.env.JWT_SECRET = "x".repeat(40);
  const a = Fastify();
  await a.register(authPlugin, recheckUser ? { recheckUser } : {});
  await a.register(async (r) => { r.get("/migrations", async (req) => ({ tenant: req.tenantId })); }, { prefix: "/api/v1" });
  a.addHook("onClose", async () => { if (prev === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = prev; });
  return a;
}
const bearer = () => ({ authorization: `Bearer ${signAccess({ sub: U, tid: T, sid: S, fam: F, email: "a@b.c" }, Buffer.from("x".repeat(40)), 900)}` });

test("재확인: 켜진 사용자는 통과하고 확인 함수는 토큰의 회사·사용자 번호로 불린다", async () => {
  const seen: string[][] = [];
  const a = await app(async (t, u) => { seen.push([t, u]); return true; });
  const r = await a.inject({ url: "/api/v1/migrations", headers: bearer() });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(seen, [[T, U]]);
  await a.close();
});

test("재확인: 끈 사용자는 만료 전 토큰이라도 401 USER_DISABLED, 요청마다 다시 확인(캐시 없음)", async () => {
  let active = true, calls = 0;
  const a = await app(async () => { calls++; return active; });
  assert.equal((await a.inject({ url: "/api/v1/migrations", headers: bearer() })).statusCode, 200);
  active = false;
  const r = await a.inject({ url: "/api/v1/migrations", headers: bearer() });
  assert.equal(r.statusCode, 401);
  assert.equal(r.json().error?.code ?? r.json().code, "USER_DISABLED");
  assert.equal(calls, 2);
  await a.close();
});

test("재확인: 확인 함수가 던지면 열어 주지 않는다(5xx)", async () => {
  const a = await app(async () => { throw new Error("db down"); });
  const r = await a.inject({ url: "/api/v1/migrations", headers: bearer() });
  assert.ok(r.statusCode >= 500);
  await a.close();
});

test("NotifySession: {t,u,r} 만 받는다", () => {
  assert.equal(NotifySession.safeParse({ t: T, u: U, r: "logout" }).success, true);
  assert.equal(NotifySession.safeParse({ t: T, u: U, r: "disabled" }).success, true);
  assert.equal(NotifySession.safeParse({ t: T, u: U, r: "other" }).success, false);
  assert.equal(NotifySession.safeParse({ t: T, u: U, r: "logout", email: "x" }).success, false);
});
