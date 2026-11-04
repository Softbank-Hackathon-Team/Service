// PF FM-ORC-16: ops:force-fail 이 ① 살아 있는 워커가 기한 안에 쥔 잠금이면 막고(exit 3, --force-live 로만) ② 자원을 만든 뒤 단계면
//   잠금을 예약으로 남겨 failure-decision(재시도·롤백)이 이어 쓸 수 있게 한다 (Jeong 11/4 01:53Z: failed = 질문 대기, 자동 지우기 없음)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import pg from "pg";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DB 없음" : false;
let core: typeof import("@svc/core");
let owner: pg.Client;
const T = randomUUID();

before(async () => {
  if (skip) return;
  core = await import("@svc/core");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1, 'pf-orc-16')", [T]);
  await core.startBoss();   // pgboss 스키마
});
after(async () => {
  if (skip) return;
  await owner.query("DELETE FROM env_locks WHERE tenant_id=$1", [T]);
  await core.boss.stop({ graceful: false }); await core.pool.end(); await owner.end();
});

async function seed(holder: string, lease: string) {
  const id = randomUUID(), src = randomUUID(), dst = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES
    ($1,$3,'aws','s','connected'), ($2,$3,'gcp','g','connected')`, [src, dst, T]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status) VALUES ($1,$2,$3,$4,'provisioning')`, [id, T, src, dst]);
  await owner.query(`INSERT INTO env_locks (env_id, tenant_id, migration_id, holder, lease_expires_at) VALUES
    ($1,$3,$4,$5, now() + $6::interval), ($2,$3,$4,$5, now() + $6::interval)`, [src, dst, T, id, holder, lease]);
  return id;
}
const run = (id: string, ...a: string[]) => {
  try {
    return { code: 0, out: JSON.parse(execFileSync(process.execPath, ["--import", "tsx", "tools/ops/force-fail.ts", id, "--reason", "orc16", ...a],
      { cwd: new URL("../../../", import.meta.url).pathname, env: process.env, encoding: "utf8" }).trim().split("\n").pop()!) };
  } catch (e) {
    const x = e as { status: number; stdout: string };
    return { code: x.status, out: JSON.parse(x.stdout.trim().split("\n").pop()!) };
  }
};
const st = async (id: string) => (await owner.query("SELECT status FROM migrations WHERE id=$1", [id])).rows[0].status as string;
const holders = async (id: string) => (await owner.query("SELECT holder FROM env_locks WHERE migration_id=$1", [id])).rows.map((r) => r.holder as string);

test("FM-ORC-16 거부: 살아 있는 워커 잠금(apply 도는 중)이면 --yes 여도 안 바꾸고 exit 3", { skip }, async () => {
  const id = await seed("worker:alive-1", "90 seconds");
  const r = run(id, "--yes");
  assert.equal(r.code, 3);
  assert.equal(r.out.changed, false);
  assert.equal(r.out.plan.liveWorkerLocks, 2);
  assert.equal(await st(id), "provisioning");
  assert.deepEqual(await holders(id), ["worker:alive-1", "worker:alive-1"]);
});

test("FM-ORC-16 정상: 기한 지난 잠금(죽은 워커) → failed, 잠금은 예약으로 남고 target-destroy 는 안 넣음 / --force-live 도 같은 결과", { skip }, async () => {
  const dead = await seed("worker:dead-1", "-1 minute");
  const r = run(dead, "--yes");
  assert.equal(r.code, 0, JSON.stringify(r.out));
  assert.equal(await st(dead), "failed");
  assert.deepEqual(await holders(dead), ["reserved", "reserved"]);
  assert.equal((await owner.query(`SELECT count(*)::int n FROM pgboss.job WHERE name='target-destroy' AND data->>'migrationId'=$1`, [dead])).rows[0].n, 0);
  const live = await seed("worker:alive-2", "90 seconds");
  assert.equal(run(live, "--yes", "--force-live").code, 0);
  assert.equal(await st(live), "failed");
});
