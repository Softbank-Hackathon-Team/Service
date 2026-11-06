// DB-08: 앱 계정이 superuser·pg_write_all_data(RDS rds_superuser 경유 포함)를 물려받으면 컷오버 울타리(REVOKE)로 쓰기를 못 막는다.
//   2026-11-06 실제 RDS: 앱 계정 = 마스터 → 컷오버 FENCE_INEFFECTIVE 2회. sync 첫 점검에서 미리 막는지 본다. 먼저: npm run db:up
import assert from "node:assert/strict";
import { before, test } from "node:test";
import { precheck, type Endpoint } from "../src/index.js";
import { SOURCE, TARGET, q, reachable } from "./harness.js";

const up = (await reachable(SOURCE)) && (await reachable(TARGET));
const skip = up ? false : "docker Postgres(55432/55433)가 안 떠 있음: npm run db:up";
const db08 = async (src: Endpoint) => (await precheck(src, TARGET)).checks.find((c) => c.id === "DB-08" && c.side === "source")!;

before(async () => {
  if (!up) return;
  await q(SOURCE, `
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN CREATE ROLE app_user LOGIN PASSWORD 'app'; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='db08_master') THEN CREATE ROLE db08_master LOGIN; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='rds_superuser') THEN CREATE ROLE rds_superuser NOLOGIN; END IF;
    END $$;
    GRANT pg_write_all_data TO rds_superuser;
    GRANT rds_superuser TO db08_master;`);
});

test("DB-08 정상: 직접 권한만 가진 앱 계정은 통과", { skip }, async () => {
  const c = await db08(SOURCE);
  assert.equal(c.ok, true, c.detail);
  assert.match(c.detail, /direct grants only/);
});

test("DB-08 거부: rds_superuser → pg_write_all_data 를 물려받은 앱 계정(RDS 마스터 모양)은 막고 사유를 보인다", { skip }, async () => {
  const c = await db08({ ...SOURCE, appRole: "db08_master" });
  assert.equal(c.ok, false);
  assert.match(c.detail, /inherits pg_write_all_data, rds_superuser/);
  assert.match(c.hint!, /앱 전용 계정/);
});

test("DB-08 거부: superuser 앱 계정도 막는다", { skip }, async () => {
  const c = await db08({ ...SOURCE, appRole: "postgres" });
  assert.equal(c.ok, false);
  assert.match(c.detail, /is superuser/);
});
