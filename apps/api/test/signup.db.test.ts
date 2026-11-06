// 팀 가입 DB 시험: buildApp + 임시 명부 파일. 성공(사용자·없는 환경만·세션) → 두 번째 409 → 같은 403 3가지 → 이름 같은 환경은 그대로
//   → 명부 회사가 DB 에 없으면 503 → 비밀번호·초대 코드·해시가 로그·감사에 없음. DB 없으면 건너뛴다
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { buildApp } from "../src/app.js";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;
const TS = "99999999-9999-4999-8999-0000000000d5";   // 이 시험만 쓰는 회사
const run = randomUUID().slice(0, 8);
const CODE = `invite-${run}-Zq81!x`, PW = `signup-pw-${run}-Yy7`;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const LOGIN = `sa-${run}@iron`, CLOSED = `sb-${run}@iron`;
const ENV_AWS = `aws-${run}`, ENV_GCP = `gcp-${run}`, ENV_KEPT = `kept-${run}`;
const P = "/api/v1/auth";
const dir = mkdtempSync(join(tmpdir(), "signup-db-"));

function registryFile(tenant: string, name: string) {
  const p = join(dir, name);
  writeFileSync(p, `version: 1
tenant: ${tenant}
slots:
  - id: slot-a
    login: ${LOGIN}
    signup_code_sha256: "${sha(CODE)}"
    environments:
      - { name: ${ENV_AWS}, provider: aws, region: ap-northeast-2, cluster: platform-target }
      - { name: ${ENV_GCP}, provider: gcp, region: asia-northeast3, gcp: { original_project: iron-source-gcp, dedicated_project: iron-target-gcp } }
      - { name: ${ENV_KEPT}, provider: aws, region: ap-northeast-2 }
  - id: slot-b
    login: ${CLOSED}
    signup_code_sha256: ""
`);
  return p;
}

let owner: pg.Client;
let keptId = "";
const lines: string[] = [];
let app: Awaited<ReturnType<typeof buildApp>>["app"];
const saved = process.env.TEAM_REGISTRY_PATH;

async function asTenant<T>(fn: () => Promise<T>) {
  await owner.query("SELECT set_config('app.tenant_id', $1, false)", [TS]);
  return fn();
}

before(async () => {
  if (skip) return;
  owner = new pg.Client({ connectionString: OWNER });
  await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1, 'signup-test') ON CONFLICT (id) DO NOTHING", [TS]);
  // 명부와 이름이 같은 환경이 이미 있다 (연결까지 끝난 상태) → 가입이 건드리면 안 된다
  keptId = await asTenant(async () => (await owner.query(
    `INSERT INTO environments (tenant_id, provider, name, connection_status, region, account_id)
     VALUES ($1, 'aws', $2, 'connected', 'us-east-1', '123456789012') RETURNING id`, [TS, ENV_KEPT])).rows[0].id);
  process.env.TEAM_REGISTRY_PATH = registryFile(TS, "registry.yaml");
  app = (await buildApp({ logStream: { write: (l) => { lines.push(l); } } })).app;
});
after(async () => {
  if (skip) return;
  await app?.close();
  await owner?.end();
  if (saved === undefined) delete process.env.TEAM_REGISTRY_PATH; else process.env.TEAM_REGISTRY_PATH = saved;
});

const signup = (payload: Record<string, unknown>, ip = "192.0.2.10") =>
  app.inject({ method: "POST", url: `${P}/signup`, payload, remoteAddress: ip });
const envRows = () => asTenant(async () => (await owner.query(
  `SELECT id, provider, name, connection_status, region, cluster_name, account_id, gcp_target_project FROM environments WHERE tenant_id = $1 ORDER BY name`, [TS])).rows);

test("가입 설정: 열린 자리가 있으면 enabled true (토큰 없이)", { skip }, async () => {
  const r = await app.inject({ url: `${P}/signup/config` });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.json(), { enabled: true });
});

test("거부: 코드 틀림·모르는 로그인·닫힌 자리는 같은 403, 사용자·환경이 안 생긴다", { skip }, async () => {
  const before = await envRows();
  const bodies = [];
  for (const [i, p] of [
    { login: LOGIN, code: "not-the-code", password: PW },
    { login: `nobody-${run}@iron`, code: CODE, password: PW },
    { login: CLOSED, code: CODE, password: PW },
  ].entries()) {
    const r = await signup(p, `192.0.2.${50 + i}`);
    assert.equal(r.statusCode, 403, r.body);
    const { requestId: _r, ...rest } = r.json();
    bodies.push(rest);
  }
  assert.equal(bodies[0].code, "SIGNUP_NOT_ALLOWED");
  assert.deepEqual(bodies[1], bodies[0]);
  assert.deepEqual(bodies[2], bodies[0]);
  // 주인 계정은 RLS 를 넘을 수 있어(슈퍼유저) 회사 번호로 직접 거른다
  const users = await asTenant(async () => (await owner.query("SELECT count(*)::int AS n FROM users WHERE tenant_id = $1", [TS])).rows[0].n);
  assert.equal(users, 0);
  assert.deepEqual(await envRows(), before);
});

test("성공: 사용자(진짜 해시) + 없는 환경만 draft 로 + 이름 같은 환경은 그대로 + 로그인과 같은 토큰·쿠키", { skip }, async () => {
  const r = await signup({ login: LOGIN.toUpperCase(), code: CODE, password: PW });
  assert.equal(r.statusCode, 201, r.body);
  const b = r.json();
  assert.equal(b.tokenType, "Bearer");
  assert.equal(b.user.email, LOGIN);
  assert.equal(b.user.tenantId, TS);
  assert.equal(b.user.tenantName, "signup-test");
  assert.equal(r.headers["cache-control"], "no-store");
  const sc = String(r.headers["set-cookie"] ?? "");
  assert.match(sc, /svc_refresh=[^;]+/);
  assert.match(sc, /HttpOnly/);
  assert.match(sc, /SameSite=Strict/);

  // 토큰으로 업무 경로: 이 회사 환경 3개 (새로 2개 + 원래 1개)
  const auth = { authorization: `Bearer ${b.accessToken}` };
  const list = await app.inject({ url: "/api/v1/environments", headers: auth });
  assert.equal(list.statusCode, 200);
  const byName = new Map<string, Record<string, unknown>>(list.json().items.map((e: { name: string }) => [e.name, e]));
  assert.deepEqual([...byName.keys()].sort(), [ENV_AWS, ENV_GCP, ENV_KEPT].sort());
  assert.equal(byName.get(ENV_AWS)!.connectionStatus, "draft");
  assert.equal(byName.get(ENV_GCP)!.connectionStatus, "draft");
  assert.equal(byName.get(ENV_GCP)!.accountId, "iron-source-gcp");
  assert.equal(byName.get(ENV_GCP)!.targetProjectId, "iron-target-gcp");
  assert.equal(byName.get(ENV_KEPT)!.connectionStatus, "connected");

  const rows = new Map((await envRows()).map((e) => [e.name, e]));
  assert.equal(rows.get(ENV_AWS).region, "ap-northeast-2");
  assert.equal(rows.get(ENV_AWS).cluster_name, "platform-target");
  assert.equal(rows.get(ENV_GCP).region, "asia-northeast3");
  assert.deepEqual(rows.get(ENV_KEPT), { id: keptId, provider: "aws", name: ENV_KEPT, connection_status: "connected", region: "us-east-1",
    cluster_name: null, account_id: "123456789012", gcp_target_project: null });

  const u = await asTenant(async () => (await owner.query(
    "SELECT id, password_hash, password_changed_at, display_name FROM users WHERE email = $1", [LOGIN])).rows[0]);
  assert.equal(u.id, b.user.id);
  assert.match(u.password_hash, /^scrypt\$/);
  assert.ok(u.password_changed_at);
  assert.equal(u.display_name, `sa-${run}`);
  const sessions = await asTenant(async () => (await owner.query("SELECT count(*)::int AS n FROM auth_sessions WHERE user_id = $1", [u.id])).rows[0].n);
  assert.equal(sessions, 1);

  // 감사: 가입 1줄 + 만든 환경마다 env.create (그대로 둔 환경은 없음). 행위자는 새 사용자
  const audit = await asTenant(async () => (await owner.query(
    "SELECT action, actor, target, detail FROM audit_events WHERE tenant_id = $1 ORDER BY seq", [TS])).rows);
  const su = audit.filter((a) => a.action === "auth.signup");
  assert.equal(su.length, 1);
  assert.equal(su[0].actor, `user:${u.id}`);
  assert.deepEqual(su[0].detail, { slot: "slot-a", environmentsCreated: [ENV_AWS, ENV_GCP], environmentsKept: [ENV_KEPT] });
  const ec = audit.filter((a) => a.action === "env.create");
  assert.equal(ec.length, 2);
  for (const a of ec) { assert.equal(a.actor, `user:${u.id}`); assert.equal(a.detail.via, "signup"); assert.equal(a.detail.slot, "slot-a"); }

  // 만든 비밀번호로 이메일 로그인, 쿠키로 갱신
  const login = await app.inject({ method: "POST", url: `${P}/login`, payload: { email: LOGIN, password: PW } });
  assert.equal(login.statusCode, 200, login.body);
  const cookie = /svc_refresh=([^;]*)/.exec(sc)![1]!;
  const ref = await app.inject({ method: "POST", url: `${P}/refresh`, headers: { cookie: `svc_refresh=${cookie}` } });
  assert.equal(ref.statusCode, 200, ref.body);
});

test("두 번째 가입: 맞는 코드면 409 SIGNUP_EXISTS, 틀린 코드면 여전히 403 (있는 계정을 알려 주지 않음). 환경은 늘지 않는다", { skip }, async () => {
  const before = await envRows();
  const again = await signup({ login: LOGIN, code: CODE, password: PW + "2" }, "192.0.2.20");
  assert.equal(again.statusCode, 409, again.body);
  assert.equal(again.json().code, "SIGNUP_EXISTS");
  assert.equal(again.headers["set-cookie"], undefined);
  const wrong = await signup({ login: LOGIN, code: "not-the-code", password: PW }, "192.0.2.21");
  assert.equal(wrong.statusCode, 403);
  assert.equal(wrong.json().code, "SIGNUP_NOT_ALLOWED");
  assert.deepEqual(await envRows(), before);
  // 비밀번호는 첫 가입 값 그대로
  const login = await app.inject({ method: "POST", url: `${P}/login`, payload: { email: LOGIN, password: PW + "2" } });
  assert.equal(login.statusCode, 401);
});

test("명부의 회사가 DB 에 없으면 503 SIGNUP_NOT_CONFIGURED, 사용자가 안 생긴다", { skip }, async () => {
  const fresh = `sz-${run}@iron`;
  const p = join(dir, "registry-missing-tenant.yaml");
  writeFileSync(p, `version: 1\ntenant: ${randomUUID()}\nslots:\n  - id: slot-z\n    login: ${fresh}\n    signup_code_sha256: "${sha(CODE)}"\n    environments:\n      - { name: z-${run}, provider: aws }\n`);
  process.env.TEAM_REGISTRY_PATH = p;
  const other = (await buildApp({ logStream: { write: (l) => { lines.push(l); } } })).app;
  try {
    const r = await other.inject({ method: "POST", url: `${P}/signup`, payload: { login: fresh, code: CODE, password: PW }, remoteAddress: "192.0.2.31" });
    assert.equal(r.statusCode, 503, r.body);
    assert.equal(r.json().code, "SIGNUP_NOT_CONFIGURED");
    const found = await other.inject({ method: "POST", url: `${P}/login`, payload: { email: fresh, password: PW } });
    assert.equal(found.statusCode, 401, "사용자가 생기지 않았다");
  } finally { await other.close(); }
});

test("비밀값: 비밀번호·초대 코드·코드 해시·저장된 비밀번호 해시가 로그와 감사 기록에 없다", { skip }, async () => {
  const hash = await asTenant(async () => (await owner.query("SELECT password_hash FROM users WHERE email = $1", [LOGIN])).rows[0].password_hash as string);
  const audit = await asTenant(async () => (await owner.query(
    "SELECT actor, action, target, detail::text AS d FROM audit_events WHERE tenant_id = $1", [TS])).rows);
  const auditText = JSON.stringify(audit);
  const logs = lines.join("\n");
  assert.ok(lines.length > 5, "로그가 잡혀야 시험이 의미 있다");
  assert.ok(logs.includes("team signup"), "성공 로그 한 줄");
  for (const s of [PW, PW + "2", CODE, sha(CODE), hash]) {
    assert.ok(!logs.includes(s), `로그에 비밀값: ${s.slice(0, 6)}…`);
    assert.ok(!auditText.includes(s), `감사에 비밀값: ${s.slice(0, 6)}…`);
  }
});
