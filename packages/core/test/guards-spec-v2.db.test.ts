// DB 시험 (A3v2): T04(spec_review → prechecking) 가 spec_v2->'fieldMeta'(I3b) 의 검토·신뢰도 칸도 센다
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;

let core: typeof import("../src/index.js");
let owner: pg.Client;
const T = randomUUID();
const audit = { actor: "test", action: "a3v2", target: "t", result: "ok" as const };
const prev = process.env.SPEC_MIN_CONFIDENCE;

before(async () => {
  if (skip) return;
  core = await import("../src/index.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1, 'test-a3v2')", [T]);
  await core.startBoss();
});
after(async () => {
  if (prev === undefined) delete process.env.SPEC_MIN_CONFIDENCE; else process.env.SPEC_MIN_CONFIDENCE = prev;
  if (skip) return;
  await core.boss.stop({ graceful: false }); await core.pool.end(); await owner.end();
});

const v2 = (fieldMeta: unknown) => ({ spec: {}, fieldMeta, unmapped: [], ids: {} });
async function setup(rows: { meta?: object; specV2: unknown }[]) {
  const id = randomUUID(), src = randomUUID(), dst = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES
    ($1,$3,'aws','s','connected'), ($2,$3,'gcp','g','connected')`, [src, dst, T]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status)
    VALUES ($1,$2,$3,$4,'spec_review')`, [id, T, src, dst]);
  let v = 1;
  for (const r of rows)
    await owner.query(`INSERT INTO spec_versions (tenant_id, migration_id, version, spec, field_meta, spec_v2)
      VALUES ($1,$2,$3,'{}',$4,$5)`, [T, id, v++, JSON.stringify(r.meta ?? {}), r.specV2 === null ? null : JSON.stringify(r.specV2)]);
  return id;
}
const go = (id: string) => core.withTenant(T, (tx) => core.advance(tx, { id, tenantId: T }, "spec_review", "prechecking", { audit }));
const status = async (id: string) => (await owner.query("SELECT status FROM migrations WHERE id=$1", [id])).rows[0].status;
const rejects = (id: string, re: RegExp) => assert.rejects(go(id), (e: { code?: string; message?: string }) =>
  e.code === "GUARD_FAILED" && re.test(e.message ?? ""));
const ent = (confidence: number, needs_review?: boolean) => ({ source: "k8s", confidence, ...(needs_review === undefined ? {} : { needs_review }) });

test("거부: v1 은 깨끗해도 spec_v2 fieldMeta 에 검토 필요 칸이 있으면 409", { skip }, async () => {
  delete process.env.SPEC_MIN_CONFIDENCE;
  const id = await setup([{ specV2: v2({ "components.web.image": ent(0.6, true), "components.db.version": ent(0.6, true) }) }]);
  await rejects(id, /2 field\(s\) need review/);
  assert.equal(await status(id), "spec_review");
});

test("정상: spec_v2 가 NULL·검토 칸 없음이면 지금과 같이 통과", { skip }, async () => {
  delete process.env.SPEC_MIN_CONFIDENCE;
  const a = await setup([{ specV2: null }]);
  await go(a); assert.equal(await status(a), "prechecking");
  const b = await setup([{ specV2: v2({ "components.web.image": ent(1, false) }) }]);
  await go(b); assert.equal(await status(b), "prechecking");
});

test("v1·v2 합산: 각각 한 칸씩이면 2칸으로 막힘", { skip }, async () => {
  delete process.env.SPEC_MIN_CONFIDENCE;
  await rejects(await setup([{ meta: { "service.port": ent(0.6, true) }, specV2: v2({ "components.web.port": ent(0.6, true) }) }]),
    /2 field\(s\) need review/);
});

test("신뢰도 문턱값 0.7: spec_v2 미처리 0.6 칸 → 409, 처리된(needs_review false) 칸만이면 통과", { skip }, async () => {
  process.env.SPEC_MIN_CONFIDENCE = "0.7";
  await rejects(await setup([{ specV2: v2({ "components.web.cpu": ent(0.6) }) }]), /1 field\(s\) below min confidence/);
  const ok = await setup([{ specV2: v2({ "components.web.cpu": ent(0.6, false) }) }]);
  await go(ok); assert.equal(await status(ok), "prechecking");
});

test("모양이 틀린 spec_v2(fieldMeta 가 배열·없음)는 세지 않는다 (500 안 남)", { skip }, async () => {
  delete process.env.SPEC_MIN_CONFIDENCE;
  for (const bad of [{ fieldMeta: [1, 2] }, { spec: {} }, "x"]) {
    const id = await setup([{ specV2: bad }]);
    await go(id); assert.equal(await status(id), "prechecking");
  }
});

test("AI 초안 판(_draft)의 spec_v2 는 안 센다: 받아들인 최신 판만 본다", { skip }, async () => {
  delete process.env.SPEC_MIN_CONFIDENCE;
  const id = await setup([{ specV2: v2({}) },
    { meta: { _draft: { source: "ai:x", confidence: 0.6, needs_review: true } }, specV2: v2({ "components.web.image": ent(0.6, true) }) }]);
  await go(id); assert.equal(await status(id), "prechecking");
});
