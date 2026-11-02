// L4b DB 시험: 주기 재확인 훑기. 회사 벽을 넘는 목록은 DB 함수(0026)만, 작업은 환경마다 verify-connection periodic. DB 없으면 건너뛴다
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;

let core: typeof import("@svc/core");
let sweep: typeof import("../src/jobs/verify-sweep.js");
let owner: pg.Client;
const T1 = randomUUID(), T2 = randomUUID();
const ids: Record<string, string> = {};

async function env(tenant: string, status: string, name: string) {
  const id = randomUUID(); ids[name] = id;
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status, account_id, external_id, region, cluster_name)
    VALUES ($1,$2,'aws',$3,$4,'111122223333',$5,'ap-northeast-2','shop')`, [id, tenant, name, status, `ext-${id}`]);
}
const jobsFor = async (envId: string) => (await owner.query(
  `SELECT data, singleton_key FROM pgboss.job WHERE name = 'verify-connection' AND data->>'envId' = $1`, [envId])).rows;

before(async () => {
  if (skip) return;
  core = await import("@svc/core");
  sweep = await import("../src/jobs/verify-sweep.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await core.startBoss();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1, 'test-l4b-1'), ($2, 'test-l4b-2')", [T1, T2]);
  await env(T1, "connected", "a"); await env(T2, "unstable", "b");
  await env(T1, "verifying", "c"); await env(T2, "failed", "d"); await env(T1, "disconnected", "e");
});
after(async () => { if (skip) return; await core.boss.stop({ graceful: false }); await core.pool.end(); await owner.end(); });

test("정상: 두 회사의 연결됨·불안정 환경마다 verify-connection{periodic} 하나씩 (회사 번호는 DB 값)", { skip }, async () => {
  const r = await sweep.handleVerifySweep();
  assert.ok(r.due >= 2 && r.queued >= 2);
  for (const [n, t] of [["a", T1], ["b", T2]] as const) {
    const js = await jobsFor(ids[n]!);
    assert.equal(js.length, 1, n);
    assert.equal(js[0].data.reason, "periodic");
    assert.equal(js[0].data.tenantId, t);
    assert.equal(js[0].singleton_key, `verify-connection:${ids[n]}`);
  }
});

test("거부: verifying·failed·disconnected 환경은 훑지 않음 / 다시 훑어도 대기 중인 환경은 중복 안 들어감", { skip }, async () => {
  for (const n of ["c", "d", "e"]) assert.equal((await jobsFor(ids[n]!)).length, 0, n);
  await sweep.handleVerifySweep();
  assert.equal((await jobsFor(ids.a!)).length, 1);
  assert.equal((await jobsFor(ids.b!)).length, 1);
});

test("회사 벽: app_user 는 environments 를 회사 표시 없이 못 읽음, 함수는 (번호, 회사)만 돌려줌", { skip }, async () => {
  const direct = await core.pool.query("SELECT count(*)::int AS n FROM environments WHERE id = ANY($1)", [[ids.a, ids.b]]);
  assert.equal(direct.rows[0].n, 0);
  const due = await core.listVerifyDue(10_000);
  const mine = due.filter((d) => d.envId === ids.a || d.envId === ids.b);
  assert.equal(mine.length, 2);
  assert.deepEqual(Object.keys(mine[0]!).sort(), ["envId", "tenantId"]);
  // 실행 권한이 PUBLIC 에 없다
  const pub = await owner.query(`SELECT has_function_privilege('public', 'maint_verify_due(integer)', 'EXECUTE') AS x`);
  assert.equal(pub.rows[0].x, false);
});

test("일정: VERIFY_CRON 기본 1시간, 값 있으면 그대로", { skip }, () => {
  assert.equal(sweep.verifyCron({}), "0 * * * *");
  assert.equal(sweep.verifyCron({ VERIFY_CRON: "* * * * *" }), "* * * * *");
});
