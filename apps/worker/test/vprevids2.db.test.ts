// DB 시험(VPREVIDS2): 재가져오기에서 사람이 고친 칸 유지 — 실제 PATCH 경로(applySpecV2Patch)·PARTOF 와 같이·두 번 연속·경계 밖·남의 회사
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

before(async () => {
  if (skip) return;
  core = await import("@svc/core");
  imp = await import("../src/jobs/import.js");
  adapters = await import("@svc/adapters");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1,'test-vprevids2'), ($2,'test-vprevids2-other')", [T, OTHER]);
  await core.startBoss();
});
after(async () => {
  if (skip) return;
 delete process.env.IMPORT_APP;
  await core.boss.stop({ graceful: false }); await core.pool.end(); await owner.end();
});

async function seed() {
  const id = randomUUID(), src = randomUUID(), dst = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES ($1,$3,'onprem','s','connected'), ($2,$3,'aws','d','connected')`, [src, dst, T]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status) VALUES ($1,$2,$3,$4,'importing')`, [id, T, src, dst]);
  return id;
}
let n = 0;
const job = (id: string, tenant = T) => ({ tenantId: tenant, requestId: `r-vp2-${id.slice(0, 8)}-${n++}`, migrationId: id });
const status = async (id: string) => (await owner.query("SELECT status, failure_code FROM migrations WHERE id=$1", [id])).rows[0];
const versions = async (id: string) => (await owner.query("SELECT version, spec, field_meta, spec_v2 FROM spec_versions WHERE migration_id=$1 ORDER BY version", [id])).rows as Array<{ version: number; spec: any; field_meta: any; spec_v2: any }>;
const last = async (id: string) => (await versions(id)).at(-1)!;
const comp = (v2: any, c: string) => v2.spec.components.find((x: { id: string }) => x.id === c);
const reimport = async (id: string) => { await owner.query("UPDATE migrations SET status='importing' WHERE id=$1", [id]); await imp.handleImport(job(id)); const s = await status(id); assert.equal(s.status, "spec_review", JSON.stringify(s)); };
const noteOf = async (id: string) => String((await owner.query("SELECT detail FROM audit_events WHERE target=$1 AND action='migration.spec_review' ORDER BY seq DESC LIMIT 1", [id])).rows[0]?.detail?.note ?? "");

/** 실제 PATCH 경로: core.applySpecV2Patch → saveSpecRevision (화면이 PATCH 할 때 서버가 하는 것과 같은 함수) */
async function patchLikeUi(id: string, changes: Array<{ path: string; value: unknown }>, confirm: string[] = []) {
  const cur = await last(id);
  const next = core.applySpecV2Patch({ spec: cur.spec_v2.spec, fieldMeta: cur.spec_v2.fieldMeta }, { changes, confirm });
  const result = { ...cur.spec_v2, spec: next.spec, fieldMeta: next.fieldMeta };
  await core.withTenant(T, (tx) => core.saveSpecRevision(tx, { tenantId: T, migrationId: id, specV2: result }));
}
const withLabels = async (fn: () => Promise<void>) => {
  const src = adapters.DEMO_INVENTORY.onprem!, orig = src.items;
  src.items = (orig as any[]).map((i) => {
    if (i.kind !== "k8s.deployment" && i.kind !== "k8s.cronjob") return i;
    const c = structuredClone(i); c.metadata.labels = { ...(c.metadata.labels ?? {}), "app.kubernetes.io/part-of": ["shop-worker", "shop-cleanup"].includes(i.metadata.name) ? "shop-worker" : "shop-api" }; return c;
  });
  try { await fn(); } finally { src.items = orig; }
};
const HUMAN = { min: 5, max: 9 };

test("실제 PATCH 경로: 사람이 고친 칸(changes)·확인한 칸(confirm)이 재가져오기 뒤에도 그대로, 두 번 연속 해도 같다 (멱등)", { skip }, async () => {
  const id = await seed();
  await imp.handleImport(job(id));
  const first = await last(id);
  const confirmKey = Object.keys(first.spec_v2.fieldMeta).find((k) => /^components\.shop-api\.probes/.test(k) && first.spec_v2.fieldMeta[k].needs_review)
    ?? Object.keys(first.spec_v2.fieldMeta).find((k) => /^components\.shop-web\./.test(k) && first.spec_v2.fieldMeta[k].needs_review);
  await patchLikeUi(id, [{ path: "components.shop-api.replicas", value: HUMAN }], confirmKey ? [confirmKey] : []);
  await reimport(id);
  const a = await last(id);
  assert.deepEqual(comp(a.spec_v2, "shop-api").props.replicas, HUMAN);
  assert.equal(a.spec_v2.fieldMeta["components.shop-api.replicas"].source, "human");
  if (confirmKey) assert.equal(a.spec_v2.fieldMeta[confirmKey].needs_review, false, "확인한 칸은 확인 유지");
  assert.match(await noteOf(id), /사람 수정 유지 [1-9]/);
  // 두 번째·세 번째 연속 재가져오기: 값·표시가 그대로 (ids 도)
  await reimport(id); const b = await last(id);
  await reimport(id); const c = await last(id);
  for (const x of [b, c]) {
    assert.deepEqual(x.spec_v2.spec, a.spec_v2.spec);
    assert.deepEqual(x.spec_v2.fieldMeta, a.spec_v2.fieldMeta);
    assert.deepEqual(x.spec_v2.ids, a.spec_v2.ids);
  }
  assert.deepEqual([a.version, b.version, c.version], [3, 4, 5]);
});

test("PARTOF 와 같이: IMPORT_APP 이 같으면 사람이 고친 칸 유지, 묶음 밖 자원은 그대로 밖", { skip }, async () => {
 process.env.IMPORT_APP = "shop-api";
  try {
    await withLabels(async () => {
      const id = await seed();
      await imp.handleImport(job(id));
      const first = await last(id);
      assert.ok(!first.spec_v2.spec.components.some((c: { id: string }) => c.id === "shop-cleanup"), "shop-worker 묶음 크론잡은 밖");
      assert.ok(first.spec_v2.unmapped !== undefined);
      await patchLikeUi(id, [{ path: "components.shop-api.replicas", value: HUMAN }]);
      await reimport(id);
      const a = await last(id);
      assert.deepEqual(comp(a.spec_v2, "shop-api").props.replicas, HUMAN);
      assert.deepEqual(a.spec_v2.spec.components.map((c: { id: string }) => c.id).sort(), first.spec_v2.spec.components.map((c: { id: string }) => c.id).sort());
      await reimport(id);
      assert.deepEqual((await last(id)).spec_v2.fieldMeta, a.spec_v2.fieldMeta);
    });
  } finally { delete process.env.IMPORT_APP; }
});

test("경계 밖으로 빠진 자원: IMPORT_APP 이 바뀌어 사람이 고친 자원이 새 판에 없으면 던지지 않고, 그 값이 다른 자원으로 새지 않는다", { skip }, async () => {
  try {
    await withLabels(async () => {
      const id = await seed();
      process.env.IMPORT_APP = "shop-api"; await imp.handleImport(job(id));
      await patchLikeUi(id, [{ path: "components.shop-api.replicas", value: HUMAN }]);
      process.env.IMPORT_APP = "shop-worker"; await reimport(id);
      const b = await last(id);
      assert.ok(!b.spec_v2.spec.components.some((c: { id: string }) => c.id === "shop-api"), "shop-api 는 이제 묶음 밖");
      assert.ok(!JSON.stringify(b.spec_v2).includes(`"min":${HUMAN.min}`), "사람 값이 다른 자원으로 새면 안 됨");
      assert.ok(!Object.keys(b.spec_v2.fieldMeta).some((k) => k.startsWith("components.shop-api.")), "빠진 자원의 칸 표시도 안 남음");
      const d = (await owner.query("SELECT detail FROM audit_events WHERE target=$1 AND action='migration.spec_review' ORDER BY seq DESC LIMIT 1", [id])).rows[0].detail;
      assert.ok(d.carry.dropped.includes("shop-api.replicas"), "대상 없어 못 옮긴 사람 값은 이름으로 감사에 남음: " + JSON.stringify(d.carry));
      assert.match(d.note, /대상 없어 보류 [1-9]/);
      assert.ok(!JSON.stringify(d.carry).includes('"min"'), "값은 안 담김");
    });
  } finally { delete process.env.IMPORT_APP; }
});

// PREVIDS3: 판 창(최근 10판)으로 고침 — 예전엔 todo(앞 판 하나만 봐서 사라짐)
test("경계 밖에 한 판 있다가 돌아와도 사람이 고친 값 유지", { skip }, async () => {
  try {
    await withLabels(async () => {
      const id = await seed();
      process.env.IMPORT_APP = "shop-api"; await imp.handleImport(job(id));
      await patchLikeUi(id, [{ path: "components.shop-api.replicas", value: HUMAN }]);
      process.env.IMPORT_APP = "shop-worker"; await reimport(id);
      process.env.IMPORT_APP = "shop-api"; await reimport(id);
      assert.deepEqual(comp((await last(id)).spec_v2, "shop-api").props.replicas, HUMAN);
    });
  } finally { delete process.env.IMPORT_APP; }
});

// PREVIDS3: links·entry·posture 도 유지 — 예전엔 todo
test("사람이 고친 posture·links 도 재가져오기 뒤 유지 (두 번 연속 멱등)", { skip }, async () => {
  const id = await seed();
  await imp.handleImport(job(id));
  const cur = await last(id);
  const posture = { ...cur.spec_v2.spec.posture, network: [...cur.spec_v2.spec.posture.network.filter((x: any) => !(x.scope === "component" && x.subject === "shop-api")), { scope: "component", subject: "shop-api", mode: "mirror", ingress: [{ from: "10.0.0.0/16" }], public: false }] };
  const links = [...cur.spec_v2.spec.links, { from: "shop-web", to: "shop-worker", intent: "call" }];
  await patchLikeUi(id, [{ path: "posture", value: posture }, { path: "links", value: links }]);
  await reimport(id);
  const a = await last(id);
  assert.deepEqual(a.spec_v2.spec.posture, posture);
  assert.deepEqual(a.spec_v2.spec.links, links);
  assert.equal(a.spec_v2.fieldMeta.posture.source, "human");
  const d = (await owner.query("SELECT detail FROM audit_events WHERE target=$1 AND action='migration.spec_review' ORDER BY seq DESC LIMIT 1", [id])).rows[0].detail;
  assert.ok(d.carry.kept.includes("posture") && d.carry.kept.includes("links"), JSON.stringify(d.carry));
  await reimport(id);
  const b = await last(id);
  assert.deepEqual(b.spec_v2.spec, a.spec_v2.spec); assert.deepEqual(b.spec_v2.fieldMeta, a.spec_v2.fieldMeta);
});

test("남의 회사: 다른 회사 이름으로 부른 재가져오기는 앞 판을 읽지도 바꾸지도 않는다", { skip }, async () => {
  const id = await seed();
  await imp.handleImport(job(id));
  await patchLikeUi(id, [{ path: "components.shop-api.replicas", value: HUMAN }]);
  const before = await versions(id);
  await owner.query("UPDATE migrations SET status='importing' WHERE id=$1", [id]);
  await imp.handleImport(job(id, OTHER));   // RLS: 남의 회사 문맥에선 이전이 안 보임 → 아무것도 안 함
  assert.deepEqual(await versions(id), before);
  assert.equal((await status(id)).status, "importing");
});

test("PREVIDS3 합친 명세가 구조 검증을 못 통과하면(사람이 지운 링크를 부품 env 가 아직 가리킴) 가져오기를 막지 않고 합치기를 건너뛴다", { skip }, async () => {
  const id = await seed();
  await imp.handleImport(job(id));
  const first = await last(id);
  await patchLikeUi(id, [{ path: "links", value: first.spec_v2.spec.links.slice(1) }]);   // env 는 그대로 → 합치면 checkV2 오류
  await reimport(id);
  const a = await last(id);
  assert.deepEqual(a.spec_v2.spec.links, first.spec_v2.spec.links, "새로 읽은 값 그대로");
  const d = (await owner.query("SELECT detail FROM audit_events WHERE target=$1 AND action='migration.spec_review' ORDER BY seq DESC LIMIT 1", [id])).rows[0].detail;
  // 통합(fa 1a9ce6d): 검증을 못 넘는 사람 값은 보류 + 다시 검토(flagged)
  assert.match(d.note, /검증을 못 넘어 뺀/);
  assert.ok(d.carry.flagged.some((x: string) => x === "links"), JSON.stringify(d.carry));
});
