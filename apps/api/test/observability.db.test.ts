// DB 시험: 타임라인 경로(회사 벽 포함)와 DB 집계 지표(metrics_snapshot, 0006)
// 이전·감사 줄은 표 주인 계정으로 직접 넣는다 (큐·워커 없이)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import Fastify, { type FastifyInstance } from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;
// 시험마다 새 회사·환경을 쓴다. 가짜 감사 줄(prev_hash 'test')과 잠금이 시드 회사의 해시 체인·환경 잠금을
// 건드리면 같은 DB의 다른 시험(report.it.ts 체인 검사, 승인 잠금)이 깨진다 (통합 때 실제로 남)
const T = randomUUID();
const SRC = randomUUID(), DST = randomUUID();
const OTHER = "99999999-9999-4999-8999-999999999999";
let app: FastifyInstance;
let owner: pg.Pool;
let core: typeof import("@svc/core");
const mid = randomUUID();

before(async () => {
  if (skip) return;
  core = await import("@svc/core");
  owner = new pg.Pool({ connectionString: OWNER });
  const c = await owner.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('app.tenant_id', $1, true)", [T]);
    await c.query("INSERT INTO tenants (id, name) VALUES ($1, 'obs-test')", [T]);
    await c.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status)
                   VALUES ($1,$3,'aws','obs-src','connected'), ($2,$3,'gcp','obs-dst','connected')`, [SRC, DST, T]);
    await c.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status, created_at)
                   VALUES ($1,$2,$3,$4,'rollback_window', now() - interval '20 seconds')`, [mid, T, SRC, DST]);
    const ev = (sec: number, action: string, detail: object) => c.query(
      `INSERT INTO audit_events (tenant_id, at, actor, action, target, result, detail, prev_hash, hash)
       VALUES ($1, now() - make_interval(secs => $2), 'worker', $3, $4, 'ok', $5, 'test', 'test')`,
      [T, sec, action, mid, detail]);
    await ev(20, "migration.importing", { from: "draft", to: "importing" });
    await ev(18, "import.spec_review", { from: "importing", to: "spec_review" });          // importing 2초
    await ev(17, "job.rejected", { job: "import" });
    await ev(5, "cutover.rollback_window", { from: "spec_review", to: "rollback_window",   // spec_review 13초
      measurements: [{ name: "cutover_pause_ms", value: 640, unit: "ms" }] });
    // 워커가 쥔 환경 잠금: 마지막 연장이 12초 전 → 생존 신호 지연 ≈ 12초
    await c.query(`INSERT INTO env_locks (env_id, tenant_id, migration_id, holder, lease_expires_at)
                   VALUES ($1,$2,$3,'worker:test', now() + make_interval(secs => $4))`,
      [DST, T, mid, core.LEASE.workerSec - 12]);
    await c.query("COMMIT");
  } finally { c.release(); }

  const { authPlugin } = await import("../src/plugins/auth.js");
  const { errorsPlugin } = await import("../src/plugins/errors.js");
  const { timelineRoutes } = await import("../src/routes/timeline.js");
  app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(errorsPlugin);
  await app.register(authPlugin);
  await app.register(timelineRoutes, { prefix: "/api/v1" });
  await app.ready();
});

after(async () => {
  if (skip) return;
  await owner.query("DELETE FROM env_locks WHERE migration_id = $1", [mid]);   // 다른 시험의 잠금 검사에 안 걸리게
  await app.close(); await owner.end(); await core.pool.end();
});

const get = (tenant: string, id = mid) => app.inject({
  method: "GET", url: `/api/v1/migrations/${id}/timeline`, headers: { "x-dev-tenant": tenant } });

test("타임라인: 감사 줄을 seq 순 전이 목록으로, 머문 시간 ms", { skip }, async () => {
  const res = await get(T);
  assert.equal(res.statusCode, 200);
  const t = res.json();
  assert.equal(t.migrationId, mid);
  assert.equal(t.status, "rollback_window");
  assert.equal(t.running, true);
  assert.deepEqual(t.items.map((i: { kind: string }) => i.kind), ["transition", "transition", "event", "transition"]);
  assert.deepEqual(t.items.map((i: { durationMs: number | null }) => i.durationMs), [null, 2000, null, 13000]);
  assert.equal(t.items[3].measurements[0].value, 640);
});

test("타임라인: 다른 회사 이전이면 404 (회사 벽)", { skip }, async () => {
  assert.equal((await get(OTHER)).statusCode, 404);
  assert.equal((await get(T, randomUUID())).statusCode, 404);
});

test("지표: DB 집계가 Prometheus 텍스트로 나온다 (상태별 수, 머문 시간, 컷오버 멈춤, 생존 신호 지연, 큐)", { skip }, async () => {
  const reg = new core.Registry();
  core.registerDbMetrics(reg);
  const out = await reg.render();
  const val = (re: RegExp) => Number(out.match(re)?.[1]);
  assert.ok(val(/^svc_migrations\{status="rollback_window"\} (\d+)/m) >= 1);
  assert.ok(val(/^svc_migration_state_duration_seconds_count\{state="spec_review"\} (\d+)/m) >= 1);
  assert.ok(val(/^svc_cutover_pause_ms_count (\d+)/m) >= 1);
  assert.match(out, /^svc_cutover_pause_last_ms /m);
  const lag = val(/^svc_lease_heartbeat_lag_seconds ([\d.]+)/m);
  // 지표는 전체 잠금 중 가장 늦은 값이다. 같은 DB의 다른 시험 잠금이 더 늦을 수 있어 아래쪽만 본다
  assert.ok(lag >= 11, `lag=${lag}`);
  assert.match(out, /^svc_queue_jobs\{queue="import",state="failed"\} \d+/m);
  assert.equal(val(/^svc_metrics_collect_errors_total\{source="audit"\} (\d+)/m) || 0, 0);
  // 회사 번호·이전 번호는 지표에 나가지 않는다
  assert.ok(!out.includes(T) && !out.includes(mid));
});
