// 검증 L4b: 훑기 순서·개수 경계, 완료 뒤 재큐, 일정 등록(off·기본)·cron 설정 검사, 함수 보안 속성(db-lint D7 기준), 다른 provider
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { configProblems } from "@svc/contracts";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;

let core: typeof import("@svc/core");
let sweep: typeof import("../src/jobs/verify-sweep.js");
let owner: pg.Client;
const T1 = randomUUID(), T2 = randomUUID();
const ids: Record<string, string> = {};

async function env(tenant: string, status: string, name: string, o: { provider?: string; verified?: string } = {}) {
  const id = randomUUID(); ids[name] = id;
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status, account_id, external_id, region, cluster_name, last_verified_at)
    VALUES ($1,$2,$3,$4,$5,'111122223333',$6,'ap-northeast-2','shop', ${o.verified ?? "NULL"})`, [id, tenant, o.provider ?? "aws", name, status, `ext-${id}`]);
}
const jobsFor = async (envId: string) => (await owner.query(
  `SELECT id, state, data FROM pgboss.job WHERE name = 'verify-connection' AND data->>'envId' = $1`, [envId])).rows;

before(async () => {
  if (skip) return;
  core = await import("@svc/core");
  sweep = await import("../src/jobs/verify-sweep.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await core.startBoss();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1, 'test-vl4b-1'), ($2, 'test-vl4b-2')", [T1, T2]);
  await owner.query("UPDATE environments SET last_verified_at = now() WHERE tenant_id NOT IN ($1,$2)", [T1, T2]);   // 시드 환경은 맨 뒤로
  await env(T1, "connected", "never");                                                            // 한 번도 확인 안 함 → 맨 앞
  await env(T2, "unstable", "old", { verified: "now() - interval '3 days'" });
  await env(T1, "connected", "mid", { verified: "now() - interval '1 day'" });
  await env(T2, "connected", "fresh", { verified: "now()" });
  await env(T1, "connected", "gcp1", { provider: "gcp", verified: "now() - interval '2 days'" });
  await env(T1, "disconnected", "off1"); await env(T2, "verifying", "ver1"); await env(T2, "failed", "fail1");
});
after(async () => { if (skip) return; await core.boss.stop({ graceful: false }); await core.pool.end(); await owner.end(); });

test("순서·개수: 확인 안 한 것 → 오래된 것 순, maxRows 로 앞에서 자름, 0 은 빈 목록", { skip }, async () => {
  const mine = (await core.listVerifyDue(100)).map((d) => d.envId).filter((i) => Object.values(ids).includes(i));
  assert.deepEqual(mine, [ids.never, ids.old, ids.gcp1, ids.mid, ids.fresh], "NULL 먼저, 그다음 오래된 순. disconnected·verifying·failed 는 없음");
  assert.deepEqual((await core.listVerifyDue(2)).map((d) => d.envId), [ids.never, ids.old]);
  assert.deepEqual(await core.listVerifyDue(0), []);
  assert.equal((await core.listVerifyDue(1_000_000)).length >= 5, true);
});

test("다른 provider(gcp)도 훑음, 회사 번호는 환경의 진짜 회사. 같은 훑기 두 번 → 둘째는 0개 (대기 중 중복 없음)", { skip }, async () => {
  const r1 = await sweep.handleVerifySweep({ maxRows: 100 });
  assert.ok(r1.queued >= 5);
  const g = await jobsFor(ids.gcp1!);
  assert.equal(g.length, 1); assert.equal(g[0].data.tenantId, T1);
  assert.equal((await jobsFor(ids.old!))[0].data.tenantId, T2);
  const r2 = await sweep.handleVerifySweep({ maxRows: 100 });
  assert.equal(r2.queued, 0, "대기 중이라 아무것도 안 들어감");
  assert.ok(r2.due >= 5);
  for (const n of ["off1", "ver1", "fail1"]) assert.equal((await jobsFor(ids[n]!)).length, 0, n);
});

test("확인이 끝난 뒤(작업 completed)에는 다음 훑기가 다시 넣는다 (한 번만 넣고 멈추지 않음)", { skip }, async () => {
  await owner.query("UPDATE pgboss.job SET state = 'completed', completed_on = now() WHERE name='verify-connection' AND data->>'envId' = $1", [ids.mid]);
  const r = await sweep.handleVerifySweep({ maxRows: 100 });
  assert.ok(r.queued >= 1);
  const js = await jobsFor(ids.mid!);
  assert.ok(js.some((j) => j.state === "created" || j.state === "retry" || j.state === "active"), JSON.stringify(js.map((j) => j.state)));
});

test("일정 등록: 기본 cron 으로 등록되고, off 면 지워진다 (두 번 불러도 오류 없음)", { skip }, async () => {
  await sweep.registerVerifySweep({ VERIFY_CRON: "off" });   // 일정이 없어도 오류 없음
  await sweep.registerVerifySweep({ VERIFY_CRON: "0 0 1 1 *" });
  const has = async () => (await core.boss.getSchedules()).some((s: { name: string }) => s.name === "verify-sweep");
  assert.equal(await has(), true);
  await sweep.registerVerifySweep({ VERIFY_CRON: "off" });
  assert.equal(await has(), false);
  await sweep.registerVerifySweep({ VERIFY_CRON: " off " });
  assert.equal(await has(), false);
});

test("설정 검사: VERIFY_CRON 은 5칸 cron 또는 off 만", () => {
  const bad = (v: string) => configProblems("worker", { DATABASE_URL: "postgres://x/y", VERIFY_CRON: v }).filter((p) => p.startsWith("VERIFY_CRON"));
  for (const ok of ["off", "0 * * * *", "* * * * *", "*/5 * * * *"]) assert.deepEqual(bad(ok), [], ok);
  for (const no of ["bad", "1 2 3", "0 * * * * *", "every hour"]) assert.equal(bad(no).length, 1, no);
  assert.deepEqual(bad(""), [], "빈 값은 기본");
  assert.equal(sweep.verifyCron({ VERIFY_CRON: "  " }), "0 * * * *");
});

test("함수 보안: SECURITY DEFINER · search_path 고정 · PUBLIC 실행 없음 · 주인이 슈퍼유저 아님 · 돌려주는 칸은 둘뿐", { skip }, async () => {
  const r = await owner.query(`
    SELECT p.prosecdef, p.proconfig, r.rolname, r.rolsuper, r.rolbypassrls,
           NOT EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE') AS no_public,
           has_function_privilege('app_user', p.oid, 'EXECUTE') AS app_ok, pg_get_function_result(p.oid) AS result
      FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner WHERE p.proname = 'maint_verify_due'`);
  assert.equal(r.rowCount, 1);
  const x = r.rows[0];
  assert.equal(x.prosecdef, true);
  assert.ok((x.proconfig as string[]).some((s) => s.startsWith("search_path=")), String(x.proconfig));
  assert.equal(x.no_public, true); assert.equal(x.rolsuper, false); assert.equal(x.rolbypassrls, false); assert.equal(x.app_ok, true);
  assert.equal(x.result, "TABLE(env_id uuid, tenant_id uuid)", "이름·계정 번호 같은 칸을 안 돌려줌");
});
