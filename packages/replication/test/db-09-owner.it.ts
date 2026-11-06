// DB-09 (ADR-029): 관리자가 DB 주인(또는 주인 역할의 멤버)이 아니면 컷오버 C5 가 "must be owner of database" 로 깨진다.
//   2026-11-06 실플랫폼 b76540b7: CNPG Cluster initdb.owner(shop_app) ≠ 실제 DB 주인(app) → svc_migrate 가 주인 역할을 못 물려받아 CUTOVER_HALFWAY.
//   sync 첫 점검에서 미리 막는지 본다. 먼저: npm run db:up
import assert from "node:assert/strict";
import { before, test } from "node:test";
import { precheck, type Endpoint } from "../src/index.js";
import { SOURCE, TARGET, q, reachable } from "./harness.js";

const up = (await reachable(SOURCE)) && (await reachable(TARGET));
const skip = up ? false : "docker Postgres(55432/55433)가 안 떠 있음: npm run db:up";
const asAdmin = (user: string): Endpoint => {
  const u = new URL(TARGET.adminUrl); u.username = user; u.password = "db09"; u.pathname = "/db09";
  return { ...TARGET, adminUrl: u.toString(), appRole: "db09_owner" };
};
const db09 = async (target: Endpoint) => (await precheck(SOURCE, target)).checks.find((c) => c.id === "DB-09" && c.side === "target")!;

before(async () => {
  if (!up) return;
  await q(TARGET, `
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='db09_owner') THEN CREATE ROLE db09_owner NOLOGIN; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='db09_member') THEN CREATE ROLE db09_member LOGIN REPLICATION PASSWORD 'db09'; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='db09_stranger') THEN CREATE ROLE db09_stranger LOGIN REPLICATION PASSWORD 'db09'; END IF;
    END $$;
    GRANT db09_owner TO db09_member;`);
  if (!(await q(TARGET, `SELECT 1 FROM pg_database WHERE datname='db09'`)).length) await q(TARGET, `CREATE DATABASE db09 OWNER db09_owner`);
  await q(TARGET, `GRANT CONNECT ON DATABASE db09 TO db09_stranger`);
});

test("DB-09 정상: 주인 역할을 물려받은 관리자(CNPG svc_migrate 모양)는 통과", { skip }, async () => {
  const c = await db09(asAdmin("db09_member"));
  assert.equal(c.ok, true, c.detail);
  assert.match(c.detail, /owner db09_owner, admin can act as owner/);
});

test("DB-09 거부: 주인 역할의 멤버가 아닌 관리자는 복제 전에 막고 고칠 방법을 보인다", { skip }, async () => {
  const c = await db09({ ...asAdmin("db09_stranger"), provider: "cnpg" });
  assert.equal(c.ok, false);
  assert.match(c.detail, /not a member of the owner role/);
  assert.match(c.hint!, /initdb\.owner/);
});

test("DB-09 정상: superuser 관리자는 주인과 상관없이 통과", { skip }, async () => {
  const c = await db09(TARGET);
  assert.equal(c.ok, true, c.detail);
});
