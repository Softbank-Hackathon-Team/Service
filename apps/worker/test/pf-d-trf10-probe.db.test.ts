// pf-d TRF-10: 가짜 지표(PROM_URL 없음)로 돈 shift 는 cf-check --probe 가 이전에 남긴 분배 실측(감사 traffic.probe)을 결과에 붙인다
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DB 없음" : false;
let core: typeof import("@svc/core");
let reg: typeof import("../../../scripts/cf-register.js");
let shift: typeof import("../src/jobs/shift.js");
let owner: pg.Client;
const T = randomUUID(), U = randomUUID(), M = randomUUID(), N = randomUUID();

before(async () => {
  if (skip) return;
  core = await import("@svc/core");
  reg = await import("../../../scripts/cf-register.js");
  shift = await import("../src/jobs/shift.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  for (const [t, m] of [[T, M], [U, N]]) {
    const s = randomUUID(), d = randomUUID();
    await owner.query("INSERT INTO tenants (id, name) VALUES ($1, 'pf-d-trf10')", [t]);
    await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES ($1,$3,'aws','s','connected'), ($2,$3,'gcp','g','connected')`, [s, d, t]);
    await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status) VALUES ($1,$2,$3,$4,'shifting')`, [m, t, s, d]);
  }
});
after(async () => { if (skip) return; await core.pool.end(); await owner.end(); });

const steps = [{ step: "90/10", gotPct: 12, wantPct: 10, tolPct: 10, errors: 0, total: 50, ok: true },
               { step: "50/50", gotPct: 47, wantPct: 50, tolPct: 10, errors: 0, total: 50, ok: true }];

test("TRF-10 정상: 실측 기록 → shift 가 읽는 최신 한 줄 (모두 기대 폭 안이면 ok)", { skip }, async () => {
  assert.equal(await shift.latestProbe(T, M), null, "기록 전엔 없음 → 결과 probe: null");
  assert.deepEqual(await reg.recordProbe({ tenantId: T, migrationId: M, probeTarget: "gcp-app", steps }), { ok: true });
  const p = await shift.latestProbe(T, M);
  assert.equal(p?.result, "ok");
  assert.deepEqual((p?.detail as any).steps.map((s: any) => s.gotPct), [12, 47]);
  await reg.recordProbe({ tenantId: T, migrationId: M, probeTarget: "gcp-app", steps: [{ ...steps[0]!, gotPct: 40, ok: false }] });
  assert.equal((await shift.latestProbe(T, M))?.result, "error", "최신 줄 (틀린 분배)");
});

test("TRF-10 거부: 남의 회사 이전엔 못 남기고, 남의 기록은 안 보임", { skip }, async () => {
  assert.equal((await reg.recordProbe({ tenantId: T, migrationId: N, probeTarget: "x", steps })).ok, false);
  await reg.recordProbe({ tenantId: U, migrationId: N, probeTarget: "x", steps });
  assert.equal(await shift.latestProbe(T, N), null);
  assert.equal((await reg.recordProbe({ tenantId: "not-a-uuid", migrationId: M, probeTarget: "x", steps })).ok, false);
});
