// DB가 있어야 도는 통합 시험: 이전 한 건을 끝까지 돌린 뒤 증적 리포트를 뽑는다.
// 실행: npm run test:db (DATABASE_URL, OWNER_DATABASE_URL 필요)
import "./_fast-env.js";   // Z20: 반드시 맨 앞 (100% 관찰 시간 짧게)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import Fastify from "fastify";
import pg from "pg";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { boss, startBoss, pool, withTenant, workOptions } from "@svc/core";
import { errorsPlugin } from "../src/plugins/errors.js";
import { authPlugin } from "../src/plugins/auth.js";
import { idempotencyPlugin } from "../src/plugins/idempotency.js";
import { migrationRoutes } from "../src/routes/migrations.js";
import { planRoutes } from "../src/routes/plans.js";
import { specRoutes } from "../src/routes/spec.js";
import { confirmAllReview } from "./_confirm-spec.js";
import { reportRoutes } from "../src/routes/report.js";
import { EvidenceReport } from "../src/report/schema.js";
import { HANDLERS } from "../../worker/src/jobs/index.js";

const T = "11111111-1111-4111-8111-111111111111";
const OTHER = "99999999-9999-4999-8999-999999999999";
const H = { "x-dev-tenant": T };
const app = Fastify();

before(async () => {
  process.env.STUB_DELAY_MS = "0";
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(errorsPlugin);
  await app.register(authPlugin);
  await app.register(idempotencyPlugin);
  await app.register(migrationRoutes);
  await app.register(planRoutes);
  await app.register(specRoutes);
  await app.register(reportRoutes);
  await startBoss();
  for (const [q, h] of Object.entries(HANDLERS))
    await boss.work(q, workOptions(), async ([j]) => { await h(j!.data); });
  // Z76: 시험 3개가 각자 끝난 이전 1개씩 쓴다. 하나에 ≈8초(단계마다 큐 대기)라 차례로 만들면 24초 → 미리 동시에 만들어 둔다
  // 이전마다 환경 쌍이 따로라 서로 잠금이 안 겹친다. 실패는 그 이전을 쓰는 시험에서 터진다
  ready = [completedMigration(), completedMigration(), completedMigration()];
  for (const p of ready) p.catch(() => {});
});
let ready: Promise<string>[] = [];
const nextCompleted = () => ready.shift() ?? completedMigration();
after(async () => { await boss.stop({ graceful: false }); await app.close(); await pool.end(); });

async function waitFor(id: string, s: string, ms = 30000) {
  const t0 = Date.now();
  for (;;) {
    const r = await app.inject({ method: "GET", url: `/migrations/${id}`, headers: H });
    if ((r.json() as { status: string }).status === s) return;
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting ${s}`);
    await new Promise((res) => setTimeout(res, 50));
  }
}

// 이전마다 새 환경 한 쌍을 쓴다. 승인이 두 환경을 잠그므로, 같은 시드 환경을 쓰는
// 다른 통합 시험(plans.it.ts)과 동시에 돌면 잠금 때문에 서로 기다린다
async function envPair(): Promise<[string, string]> {
  return withTenant(T, async (tx) => {
    const q = await tx.query(
      `INSERT INTO environments (tenant_id, provider, name, connection_status)
       VALUES ($1,'aws','report-aws','connected'), ($1,'gcp','report-gcp','connected') RETURNING id, provider`, [T]);
    const by = (p: string) => q.rows.find((r) => r.provider === p)!.id as string;
    return [by("aws"), by("gcp")];
  });
}

async function completedMigration(): Promise<string> {
  const [sourceEnvId, targetEnvId] = await envPair();
  const c = await app.inject({ method: "POST", url: "/migrations", headers: H, payload: { sourceEnvId, targetEnvId } });
  const { id } = c.json() as { id: string };
  await waitFor(id, "spec_review");
  await confirmAllReview(app, id, H);
  await app.inject({ method: "POST", url: `/migrations/${id}/plan`, headers: H });
  await waitFor(id, "awaiting_approval");
  const plan = (await app.inject({ method: "GET", url: `/migrations/${id}/plan`, headers: H })).json() as
    { planId: string; planHash: string };
  await app.inject({ method: "POST", url: `/plans/${plan.planId}/approvals`, headers: H,
    payload: { decision: "approve", planHash: plan.planHash } });
  await app.inject({ method: "POST", url: `/migrations/${id}/start`, headers: H });
  await waitFor(id, "completed");
  return id;
}

test("정상: 끝난 이전의 리포트 = 체인 일치·승인 지문 일치·컷오버 측정값 포함", async () => {
  const id = await nextCompleted();
  const r = await app.inject({ method: "GET", url: `/migrations/${id}/report`, headers: H });
  assert.equal(r.statusCode, 200);
  const rep = EvidenceReport.parse(r.json());
  assert.equal(rep.migration.status, "completed");
  assert.equal(rep.migration.source.provider, "aws");
  assert.equal(rep.migration.target.provider, "gcp");
  assert.equal(rep.integrity.ok, true, JSON.stringify(rep.integrity));
  assert.equal(rep.integrity.partial, false);
  assert.ok(rep.summary.reachedCutover);
  assert.equal(rep.timeline.at(-1)!.to, "completed");
  assert.equal(rep.approvals.length, 1);
  assert.equal(rep.approvals[0]!.hashMatches, true);
  assert.ok(rep.measurements.some((m) => m.name === "cutover_pause_ms"));
  // 예시 산출물 (REPORT_SAMPLE_DIR가 있을 때만 파일로 남긴다)
  const dir = process.env.REPORT_SAMPLE_DIR;
  if (dir) {
    writeFileSync(`${dir}/sample-report.json`, JSON.stringify(rep, null, 2));
    for (const f of ["md", "html"] as const) {
      const x = await app.inject({ method: "GET", url: `/migrations/${id}/report?format=${f}`, headers: H });
      writeFileSync(`${dir}/sample-report.${f}`, x.body);
    }
  }
});

test("회사 경계: 다른 회사가 보면 404", async () => {
  const id = await nextCompleted();
  const r = await app.inject({ method: "GET", url: `/migrations/${id}/report`,
    headers: { "x-dev-tenant": OTHER } });
  assert.equal(r.statusCode, 404);
});

test("변조 탐지: 감사 detail의 측정값을 고치면 리포트가 그 seq에서 체인 깨짐을 보고한다", async () => {
  const id = await nextCompleted();
  const owner = new pg.Client({ connectionString: process.env.OWNER_DATABASE_URL });
  await owner.connect();
  let seq: string | undefined, orig: unknown;
  try {
    await owner.query("SELECT set_config('app.tenant_id', $1, false)", [T]);
    const q = await owner.query(
      `SELECT seq, detail FROM audit_events WHERE target=$1 AND detail ? 'measurements' ORDER BY seq LIMIT 1`, [id]);
    seq = q.rows[0].seq; orig = q.rows[0].detail;
    await owner.query(`UPDATE audit_events SET detail = jsonb_set(detail, '{measurements,0,value}', '1') WHERE seq=$1`, [seq]);
    const rep = EvidenceReport.parse((await app.inject({ method: "GET", url: `/migrations/${id}/report`, headers: H })).json());
    assert.equal(rep.integrity.ok, false);
    assert.equal(rep.integrity.reason, "hash_mismatch");
    assert.equal(String(rep.integrity.brokenAtSeq), String(seq));
  } finally {
    // 같은 DB를 쓰는 다른 시험을 위해 원래대로 돌려 둔다
    if (seq) await owner.query("UPDATE audit_events SET detail=$2 WHERE seq=$1", [seq, orig]);
    await owner.end();
  }
});
