// DB 시험: GET /migrations/:id/rehearsal — 가장 큰 epoch 줄, 줄 없음, 회사 벽, input 은 충실도 칸만 읽음,
//   지난 배포 시도의 줄이면 run.stale (상태는 진짜 advance() 로 옮겨 감사 기록을 그대로 쓴다)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import Fastify, { type FastifyInstance } from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { RehearsalView, type MigrationStatus } from "@svc/contracts";
import type { AdvanceOpts } from "@svc/core";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;
const P = "/api/v1";
const T = randomUUID(), OTHER = randomUUID();
const SHA = "b".repeat(64);
const matrix = { version: 1, target: "aws-eks", bundleSha256: SHA,
  items: [{ id: "manifests", status: "identical", real: "렌더 그대로", sandbox: "렌더 그대로", reason: "", refs: [] }] };
const result = (over: Record<string, unknown> = {}) => ({
  verdict: "passed", failureCode: null,
  sandbox: { podSecurity: "baseline", runtimeClass: null, name: "sbx-db1", hostNamespace: "sbx-db1", chart: "vcluster-0.37.6", k8sVersion: "v1.33.1", mock: false },
  bundleSha256: SHA, checks: [{ id: "rollout", subject: "Deployment/web", required: true, ok: true, ms: 10, detail: "ready 1/1" }],
  fidelity: matrix, warnings: [], timingsMs: { create: 1, apply: 1, check: 1, delete: 1 }, deleted: true, ...over });

let core: typeof import("@svc/core");
let owner: pg.Client;
let app: FastifyInstance;
const get = (tenant: string, id: string) => app.inject({ url: `${P}/migrations/${id}/rehearsal`, headers: { "x-dev-tenant": tenant } });

before(async () => {
  if (skip) return;
  core = await import("@svc/core");
  const { errorsPlugin } = await import("../src/plugins/errors.js");
  const { authPlugin } = await import("../src/plugins/auth.js");
  const { rehearsalRoutes } = await import("../src/routes/rehearsal.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1,'test-rehearsal'), ($2,'test-rehearsal-other')", [T, OTHER]);
  app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(errorsPlugin);
  await app.register(authPlugin);
  await app.register(rehearsalRoutes, { prefix: P });
  await app.ready();
});
after(async () => {
  if (skip) return;
  await app.close(); await core.pool.end(); await owner.end();
});

async function migration(tenant: string, status: MigrationStatus = "deploying") {
  const id = randomUUID(), src = randomUUID(), dst = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES
    ($1,$3,'onprem','k3s','connected'), ($2,$3,'aws','eks','connected')`, [src, dst, tenant]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status) VALUES ($1,$2,$3,$4,$5)`,
    [id, tenant, src, dst, status]);
  return id;
}
const move = (m: string, from: MigrationStatus, to: MigrationStatus, o: Omit<AdvanceOpts, "audit"> = {}) =>
  core.withTenant(T, (tx) => core.advance(tx, { id: m, tenantId: T }, from, to,
    { ...o, audit: { actor: "test", action: `migration.${to}`, target: m, result: "ok" } }));
// 워커 deploy.ts 와 같이: deploying 안에서 읽은 version 이 그 시도의 epoch
const versionOf = async (m: string) => (await owner.query("SELECT version FROM migrations WHERE id = $1", [m])).rows[0].version as number;
const view = async (m: string) => RehearsalView.parse((await get(T, m)).json());
async function run(tenant: string, migrationId: string, epoch: number, o: {
  status: string; phase?: string | null; skip?: string | null; code?: string | null; name?: string | null; input?: unknown; result?: unknown;
}) {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO sandbox_runs (id, tenant_id, migration_id, epoch, status, phase, skip_reason, failure_code, sandbox_name, input, result, deadline_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now() + interval '20 minutes')`,
    [id, tenant, migrationId, epoch, o.status, o.phase ?? null, o.skip ?? null, o.code ?? null, o.name ?? null,
     o.input === undefined ? null : JSON.stringify(o.input), o.result === undefined ? null : JSON.stringify(o.result)]);
  return id;
}

test("통과한 줄: 200, 계약 모양, 시각은 ISO 글자, no-store", { skip }, async () => {
  const m = await migration(T);
  const id = await run(T, m, 1, { status: "passed", phase: "done", name: "sbx-db1", input: { fidelity: matrix }, result: result() });
  const res = await get(T, m);
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.headers["cache-control"], "no-store");
  const v = RehearsalView.parse(res.json());
  assert.equal(v.run?.id, id);
  assert.equal(v.run?.sandboxName, "sbx-db1");
  assert.equal(v.run?.failureCode, null);
  assert.match(v.run?.createdAt ?? "", /^\d{4}-\d\d-\d\dT[\d:.]+Z$/);
  assert.equal(v.run?.result?.verdict, "passed");
});

test("가장 큰 epoch 줄만 돌려준다 (재개한 새 차례)", { skip }, async () => {
  const m = await migration(T);
  await run(T, m, 1, { status: "failed", phase: "done", code: "REHEARSAL_CRASHLOOP", result: result({ verdict: "failed", failureCode: "REHEARSAL_CRASHLOOP" }) });
  const newer = await run(T, m, 2, { status: "running", phase: "checking", name: "sbx-db2", input: { fidelity: matrix } });
  const v = RehearsalView.parse((await get(T, m)).json());
  assert.equal(v.run?.id, newer);
  assert.equal(v.run?.status, "running");
  assert.equal(v.run?.result, null);
  assert.deepEqual(v.run?.fidelity, matrix);
});

test("건너뛴 줄: skip 이유가 실리고 결과는 null", { skip }, async () => {
  const m = await migration(T);
  await run(T, m, 1, { status: "skipped", skip: "disabled" });
  const v = RehearsalView.parse((await get(T, m)).json());
  assert.equal(v.run?.skip, "disabled");
  assert.equal(v.run?.result, null);
  assert.equal(v.run?.fidelity, null);
});

test("시간 초과로 끝난 줄: result 가 비어도 failure_code 칸이 run.failureCode 로 실린다", { skip }, async () => {
  const m = await migration(T);
  await run(T, m, 1, { status: "error", phase: "checking", code: "REHEARSAL_TIMEOUT", name: "sbx-db3" });
  const v = RehearsalView.parse((await get(T, m)).json());
  assert.equal(v.run?.status, "error");
  assert.equal(v.run?.failureCode, "REHEARSAL_TIMEOUT");
  assert.equal(v.run?.result, null);
});

test("줄이 없는 이전은 200 + run null", { skip }, async () => {
  const m = await migration(T);
  const res = await get(T, m);
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json(), { migrationId: m, run: null });
});

test("재개한 배포 시도가 리허설 문 앞에서 멈추면(SECRET_VALUES_MISSING) 앞 시도의 줄은 stale, 기록으로는 그대로 보인다", { skip }, async () => {
  const m = await migration(T, "provisioning");
  await move(m, "provisioning", "deploying", { evidence: { applyOk: true } });
  const first = await run(T, m, await versionOf(m), { status: "failed", phase: "done", code: "REHEARSAL_CRASHLOOP",
    result: result({ verdict: "failed", failureCode: "REHEARSAL_CRASHLOOP" }) });
  await move(m, "deploying", "paused", { failureCode: "REHEARSAL_CRASHLOOP" });
  assert.equal((await view(m)).run?.stale, false, "리허설 실패로 멈춘 시도의 줄은 지금 줄");

  await move(m, "paused", "deploying", { evidence: { ruleCleared: true } });
  assert.equal((await view(m)).run?.stale, true, "재개한 시도는 아직 줄이 없다");
  await move(m, "deploying", "paused", { failureCode: "SECRET_VALUES_MISSING" });
  const v = await view(m);
  assert.equal(v.run?.id, first);
  assert.equal(v.run?.failureCode, "REHEARSAL_CRASHLOOP");
  assert.equal(v.run?.stale, true);
});

test("지금 시도의 줄은 뒤 전이(syncing → paused)로 version 이 올라도 stale 이 아니다", { skip }, async () => {
  const m = await migration(T, "provisioning");
  await move(m, "provisioning", "deploying", { evidence: { applyOk: true } });
  const epoch = await versionOf(m);
  await run(T, m, epoch, { status: "passed", phase: "done", result: result() });
  await move(m, "deploying", "syncing", { evidence: { argoHealthy: true, securityParity: true } });
  await move(m, "syncing", "paused", { failureCode: "REPL_LAG" });
  assert.ok(await versionOf(m) > epoch, "version 만 비교하면 낡아 보이는 상황");
  assert.equal((await view(m)).run?.stale, false);
});

test("앞 시도의 배포 작업이 재개 뒤에 늦게 쓴 옛 epoch 줄도 stale, 새 시도가 줄을 쓰면 그 줄이 지금 줄", { skip }, async () => {
  const m = await migration(T, "provisioning");
  await move(m, "provisioning", "deploying", { evidence: { applyOk: true } });
  const old = await versionOf(m);
  await move(m, "deploying", "paused", { failureCode: "GITOPS_NOT_CONFIGURED" });
  await move(m, "paused", "deploying", { evidence: { ruleCleared: true } });
  await run(T, m, old, { status: "queued", input: { fidelity: matrix } });
  assert.equal((await view(m)).run?.stale, true);
  const now = await run(T, m, await versionOf(m), { status: "running", phase: "applying", input: { fidelity: matrix } });
  const v = await view(m);
  assert.equal(v.run?.id, now);
  assert.equal(v.run?.stale, false);
});

test("거부: 남의 회사 이전은 404 (줄이 있어도), 없는 번호 404, uuid 아니면 400, 헤더 없으면 401", { skip }, async () => {
  const m = await migration(T);
  await run(T, m, 1, { status: "passed", phase: "done", result: result() });
  assert.equal((await get(OTHER, m)).statusCode, 404);
  assert.equal((await get(T, randomUUID())).statusCode, 404);
  assert.equal((await get(T, "not-a-uuid")).statusCode, 400);
  assert.equal((await app.inject({ url: `${P}/migrations/${m}/rehearsal` })).statusCode, 401);
});

test("응답에 input 의 매니페스트(original·apply)는 실리지 않는다", { skip }, async () => {
  const m = await migration(T);
  const input = { fidelity: matrix, original: [{ path: "a.yaml", yaml: "stringData:\n  password: topsecretvalue" }], apply: [] };
  await run(T, m, 1, { status: "running", phase: "applying", input });
  const res = await get(T, m);
  assert.equal(res.statusCode, 200, res.body);
  assert.ok(!res.body.includes("topsecretvalue"));
});
