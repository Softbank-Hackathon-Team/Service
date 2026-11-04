// DB 시험: 신뢰도 문턱값 (깃발 SPEC_MIN_CONFIDENCE). 꺼짐이면 지금과 같고, 켜면 0.6 칸 미처리일 때 409 GUARD_FAILED
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;

let core: typeof import("../src/index.js");
let owner: pg.Client;
const T = randomUUID();
const audit = { actor: "test", action: "low-conf", target: "t", result: "ok" as const };
const prev = process.env.SPEC_MIN_CONFIDENCE;

before(async () => {
  if (skip) return;
  core = await import("../src/index.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1, 'test-low-conf')", [T]);
  await core.startBoss();
});
after(async () => {
  if (prev === undefined) delete process.env.SPEC_MIN_CONFIDENCE; else process.env.SPEC_MIN_CONFIDENCE = prev;
  if (skip) return;
  await core.boss.stop({ graceful: false }); await core.pool.end(); await owner.end();
});

async function setup(meta: object) {
  const id = randomUUID(), src = randomUUID(), dst = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES
    ($1,$3,'aws','s','connected'), ($2,$3,'gcp','g','connected')`, [src, dst, T]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status)
    VALUES ($1,$2,$3,$4,'spec_review')`, [id, T, src, dst]);
  // 칸별 표시는 명세 칸(spec_v2.fieldMeta)에 있다 (옛 칸 field_meta 는 초안 표시 자리)
  await owner.query(`INSERT INTO spec_versions (tenant_id, migration_id, version, spec, field_meta, spec_v2)
    VALUES ($1,$2,1,'{}','{}',$3)`, [T, id, JSON.stringify({ spec: {}, fieldMeta: meta, unmapped: [], ids: {} })]);
  return id;
}
const go = (id: string) => core.withTenant(T, (tx) => core.advance(tx, { id, tenantId: T },
  "spec_review", "prechecking", { evidence: {}, audit }));
const status = async (id: string) => (await owner.query("SELECT status FROM migrations WHERE id=$1", [id])).rows[0].status;

// 0.6 이지만 needs_review=false 인 칸은 사람이 이미 처리한 것. 옛 판처럼 confidence 가 글자인 칸도 섞는다
const lowOpen = { a: { source: "default", confidence: 0.6, needs_review: false }, b: { source: "x", confidence: 0.6, needs_review: false } };

test("깃발 꺼짐(0): 0.6 칸이 있어도 지금과 같이 통과", { skip }, async () => {
  delete process.env.SPEC_MIN_CONFIDENCE;
  const id = await setup(lowOpen);
  await go(id);
  assert.equal(await status(id), "prechecking");
});

test("깃발 0.7 + 0.6 칸 미처리: 409 GUARD_FAILED, 승인된 칸만 있으면 통과", { skip }, async () => {
  process.env.SPEC_MIN_CONFIDENCE = "0.7";
  // needs_review=true 도 같이 막히지만 사유는 신뢰도 쪽까지 보이게, needs_review=false·미승인 칸은 confidence 글자 값으로 만든다
  const open = await setup({ k: { source: "default", confidence: "0.6" } });   // needs_review 없음 = 미승인, 글자 숫자
  await assert.rejects(go(open), (e: { code?: string; message?: string }) =>
    e.code === "GUARD_FAILED" && /below min confidence/.test(e.message ?? ""));
  assert.equal(await status(open), "spec_review");
  const done = await setup(lowOpen);                                           // 처리됨(needs_review=false)
  await go(done);
  assert.equal(await status(done), "prechecking");
});
