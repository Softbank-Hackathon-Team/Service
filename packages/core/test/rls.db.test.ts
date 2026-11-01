// 회사 벽(RLS) 우회 시도 시험. app_user(앱 계정)로 다른 회사 줄을 읽기·쓰기·지우기 해 본다.
// 기대: 읽기 0줄, 쓰기 거부, 고치기·지우기 0줄. DB가 없으면 건너뛴다.
//   예) DATABASE_URL=postgres://app_user:app_pw@localhost:5432/platform \
//       OWNER_DATABASE_URL=postgres://platform_owner:owner_pw@localhost:5432/platform npm run test:db
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

const DB = process.env.DATABASE_URL;
const OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;

// 회사 벽이 걸린 표 전부 (0001, 0003, 0004)
const WALLED = ["environments", "migrations", "spec_versions", "env_locks",
  "audit_events", "idempotency_keys", "plans", "plan_approvals"] as const;

const A = randomUUID(), B = randomUUID();          // A = 공격하는 쪽, B = 피해 회사
const envA = randomUUID(), envB1 = randomUUID(), envB2 = randomUUID();
let migB = "", planB = "";
let owner: pg.Client;
let app: pg.Pool;

// app_user로 한 트랜잭션. tenant가 null이면 회사 표시 없이 돈다
async function asApp<T>(tenant: string | null, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await app.connect();
  try {
    await c.query("BEGIN");
    if (tenant) await c.query("SELECT set_config('app.tenant_id', $1, true)", [tenant]);
    return await fn(c);
  } finally {
    await c.query("ROLLBACK").catch(() => {});
    c.release();
  }
}
const pgCode = async (p: Promise<unknown>) => {
  try { await p; return "ok"; } catch (e) { return (e as { code?: string }).code ?? "error"; }
};

before(async () => {
  if (skip) return;
  owner = new pg.Client({ connectionString: OWNER });
  await owner.connect();
  app = new pg.Pool({ connectionString: DB, max: 2 });
  // 표 주인 계정으로 두 회사를 만든다. 주인도 FORCE RLS를 받을 수 있으니 회사 표시를 하고 넣는다
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1,'rls-a'), ($2,'rls-b')", [A, B]);
  const put = async (t: string, sql: string, args: unknown[]) => {
    await owner.query("BEGIN");
    await owner.query("SELECT set_config('app.tenant_id', $1, true)", [t]);
    const r = await owner.query(sql, args);
    await owner.query("COMMIT");
    return r;
  };
  await put(A, `INSERT INTO environments (id, tenant_id, provider, name) VALUES ($1,$2,'aws','a')`, [envA, A]);
  await put(B, `INSERT INTO environments (id, tenant_id, provider, name) VALUES
    ($1,$3,'aws','b1'), ($2,$3,'gcp','b2')`, [envB1, envB2, B]);
  migB = (await put(B, `INSERT INTO migrations (tenant_id, source_env_id, target_env_id)
    VALUES ($1,$2,$3) RETURNING id`, [B, envB1, envB2])).rows[0].id;
  await put(B, `INSERT INTO spec_versions (tenant_id, migration_id, version, spec, field_meta)
    VALUES ($1,$2,1,'{}','{}')`, [B, migB]);
  await put(B, `INSERT INTO env_locks (env_id, tenant_id, migration_id, holder, lease_expires_at)
    VALUES ($1,$2,$3,'reserved', now() + interval '1 hour')`, [envB2, B, migB]);
  await put(B, `INSERT INTO audit_events (tenant_id, actor, action, target, result, prev_hash, hash)
    VALUES ($1,'t','t','t','ok','0','h')`, [B]);
  await put(B, `INSERT INTO idempotency_keys (tenant_id, key, req_hash) VALUES ($1,'rls-key-b','x')`, [B]);
  planB = (await put(B, `INSERT INTO plans (tenant_id, migration_id, plan_doc, plan_hash, expires_at)
    VALUES ($1,$2,'{}','h', now() + interval '1 hour') RETURNING id`, [B, migB])).rows[0].id;
  await put(B, `INSERT INTO plan_approvals (tenant_id, plan_id, migration_id, decision, approved_by, plan_hash)
    VALUES ($1,$2,$3,'approve','user:b','h')`, [B, planB, migB]);
});
after(async () => {
  if (skip) return;
  await app.end();
  await owner.end();   // 시험 줄은 무작위 회사 번호라 남겨도 다른 시험과 겹치지 않는다
});

test("준비 확인: 표 주인으로는 B 회사 줄이 모든 표에 있다", { skip }, async () => {
  for (const t of WALLED) {
    const r = await owner.query(`SELECT count(*)::int AS n FROM ${t} WHERE tenant_id = $1`, [B]);
    assert.ok(r.rows[0].n >= 1, `${t}에 B 줄이 없음`);
  }
});

test("A 회사 표시로 B 회사 줄 읽기 → 모든 표 0줄", { skip }, async () => {
  await asApp(A, async (c) => {
    for (const t of WALLED) {
      const r = await c.query(`SELECT count(*)::int AS n FROM ${t} WHERE tenant_id = $1`, [B]);
      assert.equal(r.rows[0].n, 0, `${t}: B 줄이 보임`);
    }
  });
});

test("번호를 알고 직접 찾아도 0줄 (migrations·plans 기본 키 조회)", { skip }, async () => {
  await asApp(A, async (c) => {
    assert.equal((await c.query("SELECT 1 FROM migrations WHERE id = $1", [migB])).rowCount, 0);
    assert.equal((await c.query("SELECT 1 FROM plans WHERE id = $1", [planB])).rowCount, 0);
  });
});

test("회사 표시 없이 → 자기 회사 줄도 0줄 (빈 문자열·NULL 둘 다)", { skip }, async () => {
  await asApp(null, async (c) => {
    for (const t of WALLED)
      assert.equal((await c.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n, 0, `${t}: 표시 없이 보임`);
  });
  await asApp(null, async (c) => {
    await c.query("SELECT set_config('app.tenant_id', '', true)");
    assert.equal((await c.query("SELECT count(*)::int AS n FROM environments")).rows[0].n, 0);
  });
});

test("A 표시로 tenant_id=B 줄 넣기 → 정책 위반(42501)", { skip }, async () => {
  const code = await asApp(A, (c) => pgCode(c.query(
    "INSERT INTO environments (tenant_id, provider, name) VALUES ($1,'aws','evil')", [B])));
  assert.equal(code, "42501");
});

test("A 표시로 B 줄 고치기·지우기 → 0줄", { skip }, async () => {
  await asApp(A, async (c) => {
    assert.equal((await c.query("UPDATE migrations SET status='failed' WHERE id=$1", [migB])).rowCount, 0);
    assert.equal((await c.query("DELETE FROM env_locks WHERE env_id=$1", [envB2])).rowCount, 0);
    assert.equal((await c.query("UPDATE plans SET status='approved' WHERE id=$1", [planB])).rowCount, 0);
  });
  const r = await owner.query("SELECT status FROM migrations WHERE id=$1", [migB]);
  assert.equal(r.rows[0].status, "draft");
});

test("자기 줄을 B 회사로 옮기기 → 정책 위반(42501)", { skip }, async () => {
  const code = await asApp(A, (c) => pgCode(c.query(
    "UPDATE environments SET tenant_id=$1 WHERE id=$2", [B, envA])));
  assert.equal(code, "42501");
});

test("A 이전이 B 환경 번호를 가리키게 만들기 → 외래 키 위반(23503)", { skip }, async () => {
  const code = await asApp(A, (c) => pgCode(c.query(
    "INSERT INTO migrations (tenant_id, source_env_id, target_env_id) VALUES ($1,$2,$3)", [A, envA, envB1])));
  assert.equal(code, "23503");
});

test("row_security=off 로 벽 끄기 → 오류(42501), 줄은 안 보인다", { skip }, async () => {
  const code = await asApp(A, async (c) => {
    await c.query("SET LOCAL row_security = off");
    return pgCode(c.query("SELECT 1 FROM migrations WHERE id=$1", [migB]));
  });
  assert.equal(code, "42501");
});

test("감사 기록 고치기·지우기 → 권한 없음(42501)", { skip }, async () => {
  assert.equal(await asApp(B, (c) => pgCode(c.query("UPDATE audit_events SET result='x' WHERE tenant_id=$1", [B]))), "42501");
  assert.equal(await asApp(B, (c) => pgCode(c.query("DELETE FROM audit_events WHERE tenant_id=$1", [B]))), "42501");
});

test("승인 기록 고치기 → 권한 없음(42501)", { skip }, async () => {
  assert.equal(await asApp(B, (c) => pgCode(c.query("UPDATE plan_approvals SET decision='reject'"))), "42501");
});

test("app_user는 벽 끄기·역할 바꾸기 불가 (ALTER TABLE, SET ROLE)", { skip }, async () => {
  assert.equal(await asApp(A, (c) => pgCode(c.query("ALTER TABLE migrations DISABLE ROW LEVEL SECURITY"))), "42501");
  assert.equal(await asApp(A, (c) => pgCode(c.query("SET ROLE platform_owner"))), "42501");
  assert.equal(await asApp(A, (c) => pgCode(c.query("SET ROLE svc_maintenance"))), "42501");
});

// 알려진 한계 (문서 THREAT-MODEL.md T-DB-3). 회사 표시는 일반 설정값이라 app_user가 SQL로 바꿀 수 있다.
// 그래서 벽은 "앱 코드가 표시를 정한다"는 믿음 위에 서 있다. SQL 주입이 생기면 이 줄로 벽을 넘는다.
// 이 시험은 그 한계가 그대로인지 지켜본다. 막는 방법(예: 서명된 표시)을 넣으면 기대값을 0으로 바꾼다
test("알려진 한계: app_user가 set_config로 회사 표시를 바꾸면 B 줄이 보인다", { skip }, async () => {
  await asApp(A, async (c) => {
    await c.query("SELECT set_config('app.tenant_id', $1, true)", [B]);
    assert.equal((await c.query("SELECT 1 FROM migrations WHERE id=$1", [migB])).rowCount, 1);
  });
});

// T-DB-4 막음 (Z9, 0011_integrity_indexes.sql): tenants 에 회사 벽 tenant_self. 자기 회사 한 줄만 보인다
test("tenants 표: 다른 회사 이름은 안 보이고 자기 회사만 보인다 (T-DB-4 막음)", { skip }, async () => {
  await asApp(A, async (c) => {
    assert.equal((await c.query("SELECT 1 FROM tenants WHERE id=$1", [B])).rowCount, 0);
    assert.equal((await c.query("SELECT 1 FROM tenants WHERE id=$1", [A])).rowCount, 1);
  });
  await asApp(null, async (c) => {
    assert.equal((await c.query("SELECT count(*)::int AS n FROM tenants")).rows[0].n, 0);
  });
});
