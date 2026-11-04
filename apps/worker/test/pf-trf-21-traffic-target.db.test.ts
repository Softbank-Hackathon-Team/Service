// PF TRF-21: 이전마다 LB 자리(db 0041). 줄이 있으면 워커가 그 값, 없으면 .env. 남의 회사 줄은 안 보인다
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DB 없음" : false;
let core: typeof import("@svc/core");
let platform: typeof import("../src/platform.js");
let owner: pg.Client;
const T = randomUUID(), U = randomUUID(), M = randomUUID(), N = randomUUID();

before(async () => {
  if (skip) return;
  core = await import("@svc/core");
  platform = await import("../src/platform.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  for (const [t, m] of [[T, M], [U, N]]) {
    const s = randomUUID(), d = randomUUID();
    await owner.query("INSERT INTO tenants (id, name) VALUES ($1, 'pf-trf-21')", [t]);
    await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES ($1,$3,'aws','s','connected'), ($2,$3,'gcp','g','connected')`, [s, d, t]);
    await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status) VALUES ($1,$2,$3,$4,'shifting')`, [m, t, s, d]);
  }
});
after(async () => { if (skip) return; await core.pool.end(); await owner.end(); });

test("PF TRF-21 정상: 줄이 없으면 env, 등록하면 그 LB·풀로 전환기를 만든다", { skip }, async () => {
  const a = await platform.trafficFor(T, M);
  assert.equal(a.from, "env");
  await core.withTenant(T, (tx) => core.upsertTrafficTarget(tx, T, M, { provider: "mock", lbId: "lb-m", sourcePoolId: "p-src", targetPoolId: "p-dst" }, "test"));
  const b = await platform.trafficFor(T, M);
  assert.equal(b.from, "db"); assert.equal(b.lbId, "lb-m"); assert.equal(b.switcher.provider, "mock");
  // 다시 등록하면 덮어쓴다
  await core.withTenant(T, (tx) => core.upsertTrafficTarget(tx, T, M, { provider: "mock", lbId: "lb-m2" }, "test"));
  assert.equal((await platform.trafficFor(T, M)).lbId, "lb-m2");
  const e = platform.trafficEnvFor({ provider: "cloudflare", lbId: "L", sourcePoolId: "S", targetPoolId: "D", zoneId: null }, { CLOUDFLARE_ZONE_ID: "z", TRAFFIC_LB_ID: "old" });
  assert.deepEqual([e.TRAFFIC_PROVIDER, e.TRAFFIC_LB_ID, e.CLOUDFLARE_SOURCE_POOL_ID, e.CLOUDFLARE_TARGET_POOL_ID, e.CLOUDFLARE_ZONE_ID], ["cloudflare", "L", "S", "D", "z"]);
});

test("PF TRF-21 거부: 남의 회사 이전 줄은 못 쓰고(RLS) 안 보인다, 모양이 틀리면 거부", { skip }, async () => {
  await assert.rejects(core.withTenant(T, (tx) => core.upsertTrafficTarget(tx, U, N, { provider: "mock", lbId: "x" }, "test")));
  await core.withTenant(U, (tx) => core.upsertTrafficTarget(tx, U, N, { provider: "mock", lbId: "u-lb" }, "test"));
  assert.equal(await core.withTenant(T, (tx) => core.trafficTargetFor(tx, N)), null);
  await assert.rejects(core.withTenant(T, (tx) => core.upsertTrafficTarget(tx, T, M, { provider: "nope" as never, lbId: "" }, "test")));
});
