// L8b: 개인 토큰 인증 훅 — DB 없이 (찾기 함수 주입)
import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { authPlugin } from "../src/plugins/auth.js";
import { hashPat, newPat, isPatShape, type PatRow } from "../src/auth/pat.js";
import { CreateTokenBody } from "@svc/contracts";

const T = "11111111-1111-4111-8111-111111111111";
const U = "66666666-6666-4666-8666-666666666666";

async function app(rows: Map<string, PatRow>, active = true) {
  const a = Fastify();
  await a.register(authPlugin, { lookupPat: async (h) => rows.get(h), recheckUser: async () => active });
  await a.register(async (r) => { r.get("/migrations", async (req) => ({ tenant: req.tenantId, actor: req.actor, auth: req.auth })); }, { prefix: "/api/v1" });
  return a;
}
const row = (over: Partial<PatRow> = {}): PatRow => ({ tokenId: "t1", tenantId: T, userId: U, expiresAt: new Date(Date.now() + 86_400_000), revoked: false, ...over });
const hdr = (tok: string) => ({ authorization: `Bearer ${tok}`, "x-dev-tenant": "22222222-2222-4222-8222-222222222222" });

test("개인 토큰: 맞으면 줄의 회사·사용자로 인증(요청 헤더 회사는 무시), req.auth 는 비어 있다", async () => {
  const tok = newPat();
  assert.ok(isPatShape(tok));
  const a = await app(new Map([[hashPat(tok), row()]]));
  const r = await a.inject({ url: "/api/v1/migrations", headers: hdr(tok) });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.json(), { tenant: T, actor: `user:${U}`, auth: null });
  await a.close();
});

test("개인 토큰: 만료·끊김·모르는 토큰·모양 틀림·끈 사용자는 401", async () => {
  const [ok, old, rev, unknown] = [newPat(), newPat(), newPat(), newPat()];
  const rows = new Map([[hashPat(ok), row()], [hashPat(old), row({ expiresAt: new Date(Date.now() - 1000) })], [hashPat(rev), row({ revoked: true })]]);
  const a = await app(rows);
  for (const t of [old, rev, unknown, "svc_pat_short"]) assert.equal((await a.inject({ url: "/api/v1/migrations", headers: hdr(t) })).statusCode, 401, t);
  const off = await app(rows, false);
  const r = await off.inject({ url: "/api/v1/migrations", headers: hdr(ok) });
  assert.equal(r.statusCode, 401);
  assert.equal(r.json().error?.code ?? r.json().code, "USER_DISABLED");
  await a.close(); await off.close();
});

test("개인 토큰: 찾기 함수가 없으면 거부, 만들기 본문은 30일 넘기면 400", async () => {
  const a = Fastify();
  await a.register(authPlugin);
  const tok = newPat();
  assert.equal((await a.inject({ url: "/x", headers: { authorization: `Bearer ${tok}` } })).statusCode, 401);
  assert.equal(CreateTokenBody.safeParse({ name: "ci", ttlDays: 31 }).success, false);
  assert.equal(CreateTokenBody.parse({ name: "ci" }).ttlDays, 30);
  await a.close();
});
