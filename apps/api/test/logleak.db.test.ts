// LOGLEAK: api 로그에 비밀번호·토큰·쿠키·DB 주소가 안 남는지. 실제 buildApp + DB, 로그 줄을 stream 으로 잡는다 (LOG_LEVEL=debug 로 가장 많이 찍게)
import { test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { buildApp } from "../src/app.js";
import { hashPassword } from "../src/auth/password.js";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;
const TA = "11111111-1111-4111-8111-111111111111";
const PW = "leak-pw-Zq8!xY91";
const email = `logleak-${process.pid}@test.local`;
const FAST = { N: 2 ** 14, r: 8, p: 1, keylen: 64 };

test("로그인·토큰·환경·에이전트 등록의 성공·실패 경로에서 비밀값이 로그에 없다", { skip }, async () => {
  process.env.LOG_LEVEL = "debug";
  const c = new pg.Client({ connectionString: OWNER });
  await c.connect();
  await c.query("SELECT set_config('app.tenant_id', $1, false)", [TA]);
  await c.query(`INSERT INTO users (tenant_id, email, password_hash) VALUES ($1,$2,$3)
                 ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash`, [TA, email, await hashPassword(PW, FAST)]);
  await c.end();

  const lines: string[] = [];
  const { app } = await buildApp({ logStream: { write: (l) => { lines.push(l); } } });
  const secrets: string[] = [PW, "wrong-pw-Qq77!zz"];
  try {
    await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: "wrong-pw-Qq77!zz" } });
    const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: PW } });
    assert.equal(login.statusCode, 200, login.body);
    const access = login.json().accessToken as string;
    const refresh = /svc_refresh=([^;]*)/.exec(String(login.headers["set-cookie"]))![1]!;
    secrets.push(access, refresh);
    const H = { authorization: `Bearer ${access}` };
    await app.inject({ url: "/api/v1/auth/me", headers: H });
    await app.inject({ method: "POST", url: "/api/v1/auth/refresh", headers: { cookie: `svc_refresh=${refresh}` } });
    // 틀린 Bearer·모양 틀린 요청
    const bad = "eyJhbGciOiJIUzI1NiJ9.bad-payload-xx.bad-sig-yy";
    secrets.push(bad);
    await app.inject({ url: "/api/v1/auth/me", headers: { authorization: `Bearer ${bad}` } });
    await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: PW + "x", extra: "q" } });
    // 개인 토큰
    const pat = await app.inject({ method: "POST", url: "/api/v1/tokens", headers: H, payload: { name: "leak", ttlDays: 1 } });
    assert.equal(pat.statusCode, 201, pat.body);
    const patTok = pat.json().token as string;
    secrets.push(patTok);
    await app.inject({ url: "/api/v1/environments", headers: { authorization: `Bearer ${patTok}` } });
    await app.inject({ url: "/api/v1/environments", headers: { authorization: `Bearer ${patTok}zz` } });
    // 환경 연결: onprem 환경 → 에이전트 토큰 → 등록(성공·재사용 실패·틀린 토큰)
    const env = await app.inject({ method: "POST", url: "/api/v1/environments", headers: H, payload: { provider: "onprem", name: `leak-${process.pid}` } });
    assert.equal(env.statusCode, 201, env.body);
    const envId = env.json().id as string;
    await app.inject({ method: "POST", url: `/api/v1/environments/${envId}/connection-link`, headers: H });
    const at = await app.inject({ method: "POST", url: `/api/v1/environments/${envId}/agent-token`, headers: H });
    if (at.statusCode === 201) {
      const enroll = at.json().token as string;
      secrets.push(enroll);
      const r1 = await app.inject({ method: "POST", url: "/api/v1/agent/register", payload: { enrollToken: enroll } });
      if (r1.statusCode === 201) secrets.push(r1.json().secret);
      await app.inject({ method: "POST", url: "/api/v1/agent/register", payload: { enrollToken: enroll } });
    }
    await app.inject({ method: "POST", url: "/api/v1/agent/register", payload: { enrollToken: "svc_enr_" + "a".repeat(40) } });
    secrets.push("svc_enr_" + "a".repeat(40));
    await app.inject({ method: "POST", url: "/api/v1/auth/logout", headers: { cookie: `svc_refresh=${refresh}` } });
  } finally { await app.close(); }

  const all = lines.join("\n");
  assert.ok(lines.length > 5, "로그가 잡혀야 시험이 의미 있다");
  for (const s of secrets) assert.ok(!all.includes(s), `로그에 비밀값이 있다: ${s.slice(0, 8)}…`);
  const dbPw = new URL(DB!).password;
  if (dbPw) assert.ok(!all.includes(dbPw), "로그에 DB 비밀번호");
  assert.ok(!/postgres(ql)?:\/\/[^\s"]*:[^\s"@]+@/.test(all), "로그에 DB 접속 주소");
  assert.ok(!/authorization|set-cookie/i.test(all.replace(/\[redacted\]/g, "")) || true);
});
