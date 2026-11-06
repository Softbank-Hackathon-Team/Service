// z75-38: GET /migrations/:id/traffic-shift. 회사 벽 + 기록 없음 / 있음 모양
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import Fastify, { type FastifyInstance } from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { TrafficShiftProgress } from "@svc/contracts";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;
const P = "/api/v1";
const T = randomUUID(), OTHER = randomUUID(), S = randomUUID(), G = randomUUID(), M = randomUUID();
let core: typeof import("@svc/core");
let owner: pg.Client;
let app: FastifyInstance;

before(async () => {
  if (skip) return;
  core = await import("@svc/core");
  const { errorsPlugin } = await import("../src/plugins/errors.js");
  const { authPlugin } = await import("../src/plugins/auth.js");
  const { liveTrafficRoutes } = await import("../src/routes/live-traffic.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1,'test-z75-38'), ($2,'test-z75-38-other')", [T, OTHER]);
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES
    ($1,$3,'aws','s','connected'), ($2,$3,'gcp','g','connected')`, [S, G, T]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status) VALUES ($1,$2,$3,$4,'shifting')`, [M, T, S, G]);
  app = Fastify();
  app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler);
  await app.register(errorsPlugin); await app.register(authPlugin);
  await app.register(liveTrafficRoutes, { prefix: P });
  await app.ready();
});
after(async () => {
  if (skip) return;
  await app.close(); await core.pool.end(); await owner.end();
});

const get = (tenant: string) => app.inject({ method: "GET", url: `${P}/migrations/${M}/traffic-shift`, headers: { "x-dev-tenant": tenant } });

test("기록 없음 → 200 available:false, 칸은 null", { skip }, async () => {
  const r = await get(T);
  assert.equal(r.statusCode, 200, r.body);
  const b = r.json();
  assert.equal(b.available, false); assert.equal(b.targetWeightPct, null); assert.equal(b.reached, null);
  assert.equal(TrafficShiftProgress.safeParse(b).success, true);
});

test("워커가 쓴 한 줄 → 목표·실측·도달 여부 (% 정수)", { skip }, async () => {
  const at = "2026-11-07T01:00:05.000Z", st = "2026-11-07T01:00:00.000Z";
  // 워커와 같은 길: app_user + 회사 표시 (RLS WITH CHECK 통과)
  await core.withTenant(T, (tx) => tx.query(
    `INSERT INTO traffic_progress (migration_id, tenant_id, target_pct, observed_pct, reached, tolerance_pct, reobserve, step_started_at, observed_at)
     VALUES ($1,$2,50,47,true,10,1,$3,$4)`, [M, T, st, at]));
  const b = (await get(T)).json();
  assert.deepEqual(b, { migrationId: M, available: true, targetWeightPct: 50, observedWeightPct: 47, reached: true,
    tolerancePct: 10, reobserve: 1, stepStartedAt: st, observedAt: at, metricsSource: null, lbStub: null, lbRegistered: false });
});

test("흉내 표시: 대신 이름 LB 를 쥐면 가짜 LB, 워커가 남긴 shift 결과의 지표 출처를 그대로", { skip }, async () => {
  // 워커 shift 처럼 LB 이름 = 이전 번호로 주인 자리를 잡는다 (worker platform.ts trafficFor 의 대신 이름)
  assert.equal(await core.withTenant(T, (tx) => core.takeTrafficLease(tx, M, M)), "mine");
  let b = (await get(T)).json();
  assert.equal(b.lbStub, true); assert.equal(b.metricsSource, null); assert.equal(b.lbRegistered, false);
  // 워커 shift 결과 detail (jobs/shift.ts): 가짜 지표·mock 전환기
  await core.withTenant(T, (tx) => core.writeAudit(tx, T, { actor: "worker", action: "migration.advance", target: M, result: "ok",
    detail: { from: "shifting", to: "cutover", metricsSource: "stub", trafficProvider: "mock", trafficLbFrom: "env" } }));
  b = (await get(T)).json();
  assert.equal(b.metricsSource, "stub"); assert.equal(b.lbStub, true);
  assert.equal(TrafficShiftProgress.safeParse(b).success, true);
});

test("다른 회사 → 404, 다른 회사로는 그 줄을 못 쓴다 (RLS)", { skip }, async () => {
  assert.equal((await get(OTHER)).statusCode, 404);
  await assert.rejects(core.withTenant(OTHER, (tx) => tx.query(
    `INSERT INTO traffic_progress (migration_id, tenant_id, target_pct, tolerance_pct, step_started_at, observed_at)
     VALUES ($1,$2,10,10,now(),now())`, [randomUUID(), T])));
});
