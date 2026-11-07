// 2026-11-07 GCP → 온프레 실측 SYNC_FAILED "permission denied for table orders":
//   워커가 Cloud SQL API 로 만든 복제 관리자(svc_repl_*)는 cloudsqlsuperuser 멤버지만 앱 표 주인이 아니라 표를 못 읽었다.
//   Cloud SQL 모양을 흉내 낸다: API 로 만든 표 주인(shop) 위에 cloudsqlsuperuser 가 ADMIN 을 갖고, 복제 관리자는 cloudsqlsuperuser 를 물려받는다.
//   먼저: npm run db:up
import assert from "node:assert/strict";
import { before, test } from "node:test";
import { ensureReplicationAttr, precheckSource, type Endpoint } from "../src/index.js";
import { SOURCE, q, reachable } from "./harness.js";

const up = await reachable(SOURCE);
const skip = up ? false : "docker Postgres(55432)가 안 떠 있음: npm run db:up";
const as = (user: string): Endpoint => {
  const u = new URL(SOURCE.adminUrl); u.username = user; u.password = "csm"; u.pathname = "/csm";
  return { ...SOURCE, label: "src-cloudsql", provider: "cloudsql", adminUrl: u.toString(), appRole: "csm_shop" };
};
// 점검(DB-T8)은 제공자와 상관없다. 로컬 DB 는 TLS 가 없어 cloudsql 이면 NET-TLS0 이 먼저 멈추므로 postgres 로 본다
const t8 = async (user: string) => (await precheckSource({ ...as(user), provider: "postgres" })).checks.find((c) => c.id === "DB-T8")!;

before(async () => {
  if (!up) return;
  await q(SOURCE, `
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='csm_super') THEN CREATE ROLE csm_super NOLOGIN CREATEROLE; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='csm_shop') THEN CREATE ROLE csm_shop LOGIN PASSWORD 'csm'; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='csm_repl') THEN CREATE ROLE csm_repl LOGIN INHERIT REPLICATION PASSWORD 'csm'; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='csm_stranger') THEN CREATE ROLE csm_stranger LOGIN REPLICATION PASSWORD 'csm'; END IF;
    END $$;
    GRANT csm_shop TO csm_super WITH ADMIN TRUE, INHERIT FALSE, SET FALSE;   -- PG16 CREATEROLE 가 만든 역할의 기본 모양
    GRANT csm_super TO csm_repl;`);
  // 지난 실행이 남긴 멤버십을 걷는다 (PG16 은 부여한 사람별로 따로라 GRANTED BY 로)
  for (const by of ["csm_super", "csm_repl", "postgres"]) await q(SOURCE, `REVOKE csm_shop FROM csm_repl GRANTED BY ${by}`).catch(() => {});
  if (!(await q(SOURCE, `SELECT 1 FROM pg_database WHERE datname='csm'`)).length) await q(SOURCE, `CREATE DATABASE csm`);
  await q(SOURCE, `GRANT CONNECT, CREATE ON DATABASE csm TO csm_shop, csm_repl, csm_stranger`);
  const csmAdmin = { ...SOURCE, adminUrl: Object.assign(new URL(SOURCE.adminUrl), { pathname: "/csm" }).toString() };
  await q(csmAdmin, `GRANT USAGE, CREATE ON SCHEMA public TO csm_shop, csm_repl, csm_stranger`);
  await q(as("csm_shop"), `CREATE TABLE IF NOT EXISTS orders (id int PRIMARY KEY); INSERT INTO orders VALUES (1) ON CONFLICT DO NOTHING`);
});

test("Cloud SQL 출발: 복제 관리자가 표 주인 역할을 스스로 물려받아 표를 읽는다", { skip }, async () => {
  const before = await t8("csm_repl");
  assert.equal(before.ok, false, "멤버십 전에는 못 읽는다");
  assert.match(before.detail, /orders\(csm_shop\)/);
  const r = await ensureReplicationAttr(as("csm_repl"));
  assert.deepEqual(r.owners, { granted: ["csm_shop"], failed: [] });
  assert.equal((await q(as("csm_repl"), `SELECT count(*)::int n FROM orders`))[0].n, 1);
  const after = await t8("csm_repl");
  assert.equal(after.ok, true, after.detail);
  // 다시 불러도 같다 (이미 멤버면 아무것도 안 함)
  assert.deepEqual((await ensureReplicationAttr(as("csm_repl"))).owners, { granted: [], failed: [] });
});

test("Cloud SQL 출발: 주인 역할에 ADMIN 이 없으면 실패를 모으고 DB-T8 이 고칠 방법과 함께 막는다", { skip }, async () => {
  const r = await ensureReplicationAttr(as("csm_stranger"));
  assert.equal(r.owners?.granted.length, 0);
  assert.equal(r.owners?.failed[0]?.owner, "csm_shop");
  const c = await t8("csm_stranger");
  assert.equal(c.ok, false);
  assert.match(c.hint!, /GRANT csm_shop TO/);
});
