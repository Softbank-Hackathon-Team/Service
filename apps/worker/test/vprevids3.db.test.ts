// DB 시험(VPREVIDS3): 끌어온 자원(BOUNDPULL) 위에 사람이 고친 칸(PREVIDS3)이 재가져오기 뒤에도 같이 남는지.
//   실제 PATCH 경로와 같은 함수(applyInclude → applySpecV2Patch → saveSpecRevision)로 판을 만들고, 처리기를 직접 부른다
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;

let core: typeof import("@svc/core");
let imp: typeof import("../src/jobs/import.js");
let adapters: typeof import("@svc/adapters");
let owner: pg.Client;
const T = randomUUID(), OTHER = randomUUID();
const BUCKET = "s3.bucket:orphan-bucket", BID = "orphan-bucket";

before(async () => {
  if (skip) return;
  core = await import("@svc/core");
  imp = await import("../src/jobs/import.js");
  adapters = await import("@svc/adapters");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1,'test-vprevids3'), ($2,'test-vprevids3-other')", [T, OTHER]);
  await core.startBoss();
});
after(async () => {
  if (skip) return;
  delete process.env.IMPORT_IR; delete process.env.IMPORT_APP;
  await core.boss.stop({ graceful: false }); await core.pool.end(); await owner.end();
});

async function seed() {
  const id = randomUUID(), src = randomUUID(), dst = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES ($1,$3,'onprem','s','connected'), ($2,$3,'aws','d','connected')`, [src, dst, T]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status) VALUES ($1,$2,$3,$4,'importing')`, [id, T, src, dst]);
  return id;
}
let n = 0;
const job = (id: string, tenant = T) => ({ tenantId: tenant, requestId: `r-vp3-${id.slice(0, 8)}-${n++}`, migrationId: id });
const status = async (id: string) => (await owner.query("SELECT status, failure_code FROM migrations WHERE id=$1", [id])).rows[0];
const versions = async (id: string) => (await owner.query("SELECT version, spec, field_meta, spec_v2 FROM spec_versions WHERE migration_id=$1 ORDER BY version", [id])).rows as Array<{ version: number; spec: any; field_meta: any; spec_v2: any }>;
const last = async (id: string) => (await versions(id)).at(-1)!;
const comp = (v2: any, c: string) => v2.spec.components.find((x: { id: string }) => x.id === c);
const reimport = async (id: string) => { await owner.query("UPDATE migrations SET status='importing' WHERE id=$1", [id]); await imp.handleImport(job(id)); const s = await status(id); assert.equal(s.status, "spec_review", JSON.stringify(s)); };
const audit = async (id: string) => (await owner.query("SELECT detail FROM audit_events WHERE target=$1 AND action='migration.spec_review' ORDER BY seq DESC LIMIT 1", [id])).rows[0].detail;

function withOrphanBucket(gone = false): () => void {
  const src = adapters.DEMO_INVENTORY_V2.onprem!, orig = src.items;
  src.items = gone ? orig : [...orig, { kind: "s3.bucket", Name: "orphan-bucket", Arn: "arn:aws:s3:::orphan-bucket" } as never];
  return () => { src.items = orig; };
}
/** PATCH 라우트(patchV2)와 같은 순서: include → changes → confirm → 판 저장 */
async function patchLikeUi(id: string, o: { include?: string[]; changes?: Array<{ path: string; value: unknown }>; confirm?: string[] }, tenant = T) {
  const cur = await last(id);
  let base = cur.spec_v2;
  if (o.include?.length) base = adapters.applyInclude(base, o.include).result;
  const next = core.applySpecV2Patch({ spec: base.spec, fieldMeta: base.fieldMeta ?? {} }, { changes: o.changes ?? [], confirm: o.confirm ?? [] });
  const result = { ...base, spec: next.spec, fieldMeta: next.fieldMeta };
  await core.withTenant(tenant, (tx) => core.saveSpecRevision(tx, { tenantId: tenant, migrationId: id, spec: cur.spec, fieldMeta: cur.field_meta, specV2: result }));
}
const precheck = (row: { spec: any; spec_v2: any }) => adapters.v2PrecheckItems("aws", { spec: row.spec, specV2: row.spec_v2.spec, hadV2Before: true });
const humanIds = (items: Array<{ id: string }>) => items.map((i) => i.id).filter((i) => i.startsWith("PC-V2-HUMAN"));

test("끌어온 버킷 + 그 버킷에 사람이 고친 칸 + 재가져오기 3번: 끌어온 채 + 사람 값 유지, 판마다 같다 (멱등)", { skip }, async () => {
  process.env.IMPORT_IR = "v2";
  const restore = withOrphanBucket();
  const id = await seed();
  try {
    await imp.handleImport(job(id));
    const before = comp((await last(id)).spec_v2, BID);
    assert.equal(before, undefined, "처음엔 경계 밖");
    await patchLikeUi(id, { include: [BUCKET] });
    const pulled = comp((await last(id)).spec_v2, BID);
    assert.ok(pulled, "끌어옴");
    const key = `components.${BID}.public`;
    await patchLikeUi(id, { changes: [{ path: key, value: false }] });
    await reimport(id);
    const a = await last(id);
    assert.equal(comp(a.spec_v2, BID).props.public, false, "사람 값 유지");
    assert.equal(a.spec_v2.fieldMeta[key]?.source, "human");
    assert.ok(!a.spec_v2.outOfBoundary.some((o: { resource: string }) => o.resource === BUCKET), "경계 밖 목록에 다시 안 나옴");
    assert.deepEqual(a.spec_v2.included, [BUCKET]);
    assert.equal(a.spec_v2.fieldMeta[`components.${BID}.boundary`].source, "human");
    await reimport(id); const b = await last(id);
    await reimport(id); const c = await last(id);
    for (const x of [b, c]) {
      assert.deepEqual(x.spec_v2.spec, a.spec_v2.spec);
      assert.deepEqual(x.spec_v2.fieldMeta, a.spec_v2.fieldMeta);
      assert.deepEqual(x.spec_v2.included, a.spec_v2.included);
      assert.deepEqual(x.spec_v2.ids, a.spec_v2.ids);
    }
  } finally { restore(); }
});

test("사전 점검: 버킷 공개 여부를 사람이 정하기 전엔 PC-V2-HUMAN, 정한 뒤 재가져오기 2번이 지나도 사라진 채로 (posture 도 같이 유지)", { skip }, async () => {
  process.env.IMPORT_IR = "v2";
  const restore = withOrphanBucket();
  const id = await seed();
  try {
    await imp.handleImport(job(id));
    await patchLikeUi(id, { include: [BUCKET] });
    const beforeEdit = humanIds(precheck(await last(id)));
    assert.ok(beforeEdit.length > 0, "끌어온 직후엔 사람 확인 block 이 있어야 이 시험이 의미가 있다: " + JSON.stringify(precheck(await last(id))));
    const key = `components.${BID}.public`;
    const cur = await last(id);
    const posture = { ...cur.spec_v2.spec.posture, network: cur.spec_v2.spec.posture.network.map((x: any) => x.scope === "component" && x.ingress === "unknown" ? { ...x, ingress: [], public: false } : x) };
    await patchLikeUi(id, { changes: [{ path: key, value: false }, { path: "posture", value: posture }] });
    const afterEdit = humanIds(precheck(await last(id)));
    await reimport(id); await reimport(id);
    const after = await last(id);
    assert.equal(comp(after.spec_v2, BID).props.public, false);
    assert.deepEqual(after.spec_v2.spec.posture, posture, "posture 유지");
    const items = precheck(after);
    assert.ok(!items.some((i) => i.id.startsWith("PC-V2-HUMAN") && /orphan-bucket/.test(i.message)), "버킷 때문에 막히지 않음: " + JSON.stringify(items));
    assert.deepEqual(humanIds(items), afterEdit, "재가져오기 전후 사전 점검 HUMAN 줄이 같다");
  } finally { restore(); }
});

test("carry 건너뜀 경로: 사람이 지운 링크 때문에 합치기가 검증을 못 넘어도 끌어온 자원은 유지된다 (사람 값만 보류)", { skip }, async () => {
  process.env.IMPORT_IR = "v2";
  const restore = withOrphanBucket();
  const id = await seed();
  try {
    await imp.handleImport(job(id));
    await patchLikeUi(id, { include: [BUCKET] });
    const cur = await last(id);
    await patchLikeUi(id, { changes: [{ path: `components.${BID}.public`, value: false }, { path: "links", value: cur.spec_v2.spec.links.slice(1) }] });
    await reimport(id);
    const a = await last(id);
    assert.ok(comp(a.spec_v2, BID), "끌어온 자원 유지");
    assert.deepEqual(a.spec_v2.included, [BUCKET]);
    assert.ok(!a.spec_v2.outOfBoundary.some((o: { resource: string }) => o.resource === BUCKET));
    assert.deepEqual(a.spec_v2.spec.links, cur.spec_v2.spec.links, "링크는 새로 읽은 값");
    const d = await audit(id);
    assert.match(d.note, /건너뜀/);
    assert.ok(d.carry.dropped.includes("links"), JSON.stringify(d.carry));
    // 건너뛴 판에서 다시 재가져오기해도 끌어온 자원은 계속
    await reimport(id);
    const b = await last(id);
    assert.ok(comp(b.spec_v2, BID)); assert.deepEqual(b.spec_v2.included, [BUCKET]);
  } finally { restore(); }
});

test("끌어온 자원이 원본에서 사라지면: 에러 없이 빠지고, 사람이 그 자원에 정한 값은 dropped 이름만 남고 값은 안 샌다", { skip }, async () => {
  process.env.IMPORT_IR = "v2";
  const restore1 = withOrphanBucket();
  const id = await seed();
  try {
    await imp.handleImport(job(id));
    await patchLikeUi(id, { include: [BUCKET] });
    await patchLikeUi(id, { changes: [{ path: `components.${BID}.public`, value: false }] });
  } finally { restore1(); }
  const restore2 = withOrphanBucket(true);
  try { await reimport(id); } finally { restore2(); }
  const a = await last(id);
  assert.ok(!comp(a.spec_v2, BID));
  assert.equal(a.spec_v2.included, undefined);
  const d = await audit(id);
  assert.ok(!Object.keys(a.spec_v2.fieldMeta).some((k) => k.includes(BID)), "fieldMeta 에 사라진 자원 흔적 없음: " + Object.keys(a.spec_v2.fieldMeta).filter((k) => k.includes(BID)).join(","));
  assert.ok(!JSON.stringify(d).includes("false"), "감사에 사람이 정한 값이 안 남는다");
});

test("남의 회사: 다른 회사 이름으로 부른 재가져오기는 끌어온 판을 읽지도 바꾸지도 않는다", { skip }, async () => {
  process.env.IMPORT_IR = "v2";
  const restore = withOrphanBucket();
  const id = await seed();
  try {
    await imp.handleImport(job(id));
    await patchLikeUi(id, { include: [BUCKET] });
    const before = await versions(id);
    await owner.query("UPDATE migrations SET status='importing' WHERE id=$1", [id]);
    await imp.handleImport(job(id, OTHER));
    assert.deepEqual(await versions(id), before);
    assert.equal((await status(id)).status, "importing");
  } finally { restore(); }
});

test("같은 요청에서 끌어오기 + 고치기, IMPORT_APP 이 켜져 있어도 끌어온 자원·사람 값은 재가져오기 뒤 유지", { skip }, async () => {
  process.env.IMPORT_IR = "v2";
  const restore = withOrphanBucket();
  const id = await seed();
  const src = adapters.DEMO_INVENTORY_V2.onprem!, orig = src.items;
  src.items = (src.items as any[]).map((i) => {
    if (i.kind !== "k8s.deployment" && i.kind !== "k8s.cronjob") return i;
    const c = structuredClone(i); c.metadata.labels = { ...(c.metadata.labels ?? {}), "app.kubernetes.io/part-of": ["shop-worker", "shop-cleanup"].includes(i.metadata.name) ? "shop-worker" : "shop-api" }; return c;
  });
  process.env.IMPORT_APP = "shop-api";
  try {
    await imp.handleImport(job(id));
    assert.equal((await status(id)).status, "spec_review", JSON.stringify(await status(id)));
    await patchLikeUi(id, { include: [BUCKET], changes: [{ path: `components.${BID}.public`, value: false }] });
    await reimport(id);
    const a = await last(id);

    assert.equal(comp(a.spec_v2, BID)?.props.public, false);
    assert.deepEqual(a.spec_v2.included, [BUCKET]);
    // 바탕 판(끌어오기 전)이 없어 출발 값이 안 바뀌었는지 모른다 → 사람 값은 두되 다시 검토 표시
    assert.equal(a.spec_v2.fieldMeta[`components.${BID}.public`].source, "human");
    assert.equal(a.spec_v2.fieldMeta[`components.${BID}.public`].needs_review, true);
    assert.ok((await audit(id)).carry.flagged.includes(`${BID}.public`));
    await reimport(id);
    const b = await last(id);
    assert.deepEqual(b.spec_v2.spec, a.spec_v2.spec); assert.deepEqual(b.spec_v2.fieldMeta, a.spec_v2.fieldMeta);
  } finally { src.items = orig; restore(); delete process.env.IMPORT_APP; }
});
