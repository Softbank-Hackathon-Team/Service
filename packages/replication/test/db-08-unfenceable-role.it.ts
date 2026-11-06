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

// 2026-11-07 GCP → 온프레 실측: Cloud SQL API 로 만든 앱 계정은 cloudsqlsuperuser 만 물려받는다 (쓰기 전부 권한 없음) → 이름만으로 막지 않는다
test("DB-08 통과: cloudsqlsuperuser 만 물려받은 앱 계정(Cloud SQL API 사용자 모양)은 막지 않고 그 사실을 남긴다", { skip }, async () => {
  await q(SOURCE, `
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='cloudsqlsuperuser') THEN CREATE ROLE cloudsqlsuperuser NOLOGIN; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='db08_csql_app') THEN CREATE ROLE db08_csql_app LOGIN; END IF;
    END $$;
    GRANT cloudsqlsuperuser TO db08_csql_app;`);
  const c = await db08({ ...SOURCE, appRole: "db08_csql_app" });
  assert.equal(c.ok, true, c.detail);
  assert.match(c.detail, /inherits cloudsqlsuperuser only/);
});

test("DB-08 거부: cloudsqlsuperuser 가 pg_write_all_data 를 주는 서버면 그 길로 막는다", { skip }, async () => {
  await q(SOURCE, `
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='db08_csql_wa') THEN CREATE ROLE db08_csql_wa NOLOGIN; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='db08_csql_wa_app') THEN CREATE ROLE db08_csql_wa_app LOGIN; END IF;
    END $$;
    GRANT pg_write_all_data TO db08_csql_wa; GRANT db08_csql_wa TO db08_csql_wa_app;`);
  // 이름이 다른 역할로 흉내 낸다: 공유 cloudsqlsuperuser 에 pg_write_all_data 를 붙이면 다른 시험이 흔들린다
  const c = await db08({ ...SOURCE, appRole: "db08_csql_wa_app" });
  assert.equal(c.ok, false);
  assert.match(c.detail, /inherits pg_write_all_data/);
});
