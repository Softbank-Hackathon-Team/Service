// DB 시험(I3b): 가져오기에 공통 명세 v2 연결 (IMPORT_IR 깃발 뒤). 처리기를 직접 부른다. MOCK_SEED=1 데모 원본
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
const T = randomUUID();

before(async () => {
  if (skip) return;
  core = await import("@svc/core");
  imp = await import("../src/jobs/import.js");
  adapters = await import("@svc/adapters");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1, 'test-i3b')", [T]);
  await core.startBoss();
});
after(async () => {
  if (skip) return;
  await core.boss.stop({ graceful: false }); await core.pool.end(); await owner.end();
});

async function seed(provider: "aws" | "gcp" | "onprem") {
  const id = randomUUID(), src = randomUUID(), dst = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES
    ($1,$3,$4,'s','connected'), ($2,$3,'aws','d','connected')`, [src, dst, T, provider]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status)
    VALUES ($1,$2,$3,$4,'importing')`, [id, T, src, dst]);
  return id;
}
const job = (id: string) => ({ tenantId: T, requestId: `r-i3b-${id.slice(0, 8)}`, migrationId: id });
const row = async (id: string) => (await owner.query("SELECT status, failure_code FROM migrations WHERE id=$1", [id])).rows[0] as { status: string; failure_code: string | null };
const ver = async (id: string) => (await owner.query("SELECT spec, field_meta, spec_v2 FROM spec_versions WHERE migration_id=$1", [id])).rows as Array<{ spec: any; field_meta: Record<string, { needs_review: boolean }>; spec_v2: any }>;

test("정상: 출발 gcp → 명세는 spec_v2 칸 하나(옛 칸 spec·field_meta 는 비움), spec_review", { skip }, async () => {
  const id = await seed("gcp");
  await imp.handleImport(job(id));
  assert.equal((await row(id)).status, "spec_review");
  const [v] = await ver(id);
  assert.ok(v, "spec_versions 한 줄");
  assert.deepEqual(v!.spec, {});
  assert.deepEqual(v!.field_meta, {});
  assert.equal(v!.spec_v2.spec.app.name, "shop-api");
  assert.equal(v!.spec_v2.spec.schemaVersion, "2");
  assert.deepEqual(v!.spec_v2.spec.components.map((c: { id: string }) => c.id), ["shop-api", "shop-cleanup", "shop-db", "shop-web", "shop-worker"]);
  assert.ok(!JSON.stringify(v!.spec_v2).includes("10.20.0.5\""), "출발 주소 값은 spec_v2 에 없음 (fromLink)");
});

test("거부: checkV2 구조 오류 원본 → 재시도 없이 바로 failed(IMPORT_SPEC_INVALID)", { skip }, async () => {
  const src = adapters.DEMO_INVENTORY.onprem!;
  const orig = src.items;
  // digest 없는 CronJob → checkV2 "digest 아님" (구조 오류)
  src.items = [...orig, { kind: "k8s.cronjob", imageDigest: null, metadata: { name: "broken", namespace: "shop" },
    spec: { schedule: "0 1 * * *", jobTemplate: { spec: { template: { spec: { containers: [{ name: "b", image: "ghcr.io/demo/b:1" }] } } } } } }];
  const id = await seed("onprem");
  try { await imp.handleImport(job(id)); } finally { src.items = orig; }
  const r = await row(id);
  assert.equal(r.status, "failed");
  assert.equal(r.failure_code, "IMPORT_SPEC_INVALID");
  assert.equal((await ver(id)).length, 0, "명세 판 저장 안 함");
  const a = await owner.query("SELECT detail FROM audit_events WHERE target=$1 AND action='migration.failed'", [id]);
  assert.equal(a.rows[0]?.detail?.permanent, true);
  assert.equal(a.rows[0]?.detail?.attempts, 1);
  assert.match(String(a.rows[0]?.detail?.error), /digest 아님/);
});

test("남의 회사: 다른 회사로 부른 작업은 아무것도 안 바꾼다 (회사 벽)", { skip }, async () => {
  const id = await seed("gcp");
  const other = randomUUID();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1, 'test-i3b-other')", [other]);
  await imp.handleImport({ ...job(id), tenantId: other });
  assert.equal((await row(id)).status, "importing");
  assert.equal((await ver(id)).length, 0);
});

// PREVIDS: 다시 가져올 때 앞 판의 id 를 유지한다
const ids = async (id: string) => {
  const v = (await owner.query("SELECT version, spec_v2 FROM spec_versions WHERE migration_id=$1 ORDER BY version", [id])).rows as Array<{ version: number; spec_v2: any }>;
  return v.map((x) => ({ version: x.version, ids: x.spec_v2.spec.components.map((c: { id: string }) => c.id).sort() as string[], map: x.spec_v2.ids as Record<string, string> }));
};
/** 데모 onprem 원본에 "batch 네임스페이스의 shop-api" 크론잡을 더한다: 처음 받는 가져오기라면 이름이 겹쳐 기존 shop-api 의 id 도 바뀔 모양 */
function withCollider<T>(fn: () => Promise<T>): Promise<T> {
  const src = adapters.DEMO_INVENTORY.onprem!;
  const orig = src.items;
  const cj = JSON.parse(JSON.stringify((orig as Array<{ kind: string }>).find((i) => i.kind === "k8s.cronjob"))) as { metadata: { name: string; namespace: string } };
  cj.metadata.name = "shop-api"; cj.metadata.namespace = "batch";
  src.items = [...orig, cj as never];
  return fn().finally(() => { src.items = orig; });
}

test("PREVIDS 정상: 자원이 하나 더 생긴 재가져오기에서 기존 자원 id 가 그대로, 새 자원만 새 id (판 2 저장)", { skip }, async () => {
  const id = await seed("onprem");
  await imp.handleImport(job(id));
  const first = (await ids(id))[0]!;
  assert.deepEqual(first.ids, ["shop-api", "shop-cleanup", "shop-db", "shop-web", "shop-worker"]);
  // 같은 이전을 다시 가져오기 상태로 되돌리고(시험 준비), 원본에 같은 이름 자원이 생긴 뒤 다시 가져온다
  await owner.query("UPDATE migrations SET status='importing' WHERE id=$1", [id]);
  await withCollider(() => imp.handleImport(job(id)));
  assert.equal((await row(id)).status, "spec_review");
  const [, second] = await ids(id);
  assert.equal(second!.version, 2);
  for (const [key, v] of Object.entries(first.map)) assert.equal(second!.map[key], v, `기존 자원 id 유지: ${key}`);
  const added = second!.ids.filter((x) => !first.ids.includes(x));
  assert.equal(added.length, 1, "새 자원 하나");
  assert.notEqual(added[0], "shop-api", "새 자원은 기존 id 를 뺏지 않는다");
});

test("PREVIDS 경계: 앞 판이 없으면(다른 이전에 판이 있어도) 새로 정한다 — 앞 판은 같은 이전 것만", { skip }, async () => {
  const other = await seed("onprem");
  await imp.handleImport(job(other));            // 같은 회사의 다른 이전: 판 있음 (shop-api …)
  const fresh = await seed("onprem");
  await withCollider(() => imp.handleImport(job(fresh)));
  const [v] = await ids(fresh);
  assert.equal(v!.version, 1);
  // 이름이 겹치는 워크로드는 둘 다 네임스페이스를 붙여 정한다 → 앞 판(shop-api)이 흘러들어왔다면 "shop-api" 가 그대로 남았을 것
  assert.ok(!v!.ids.includes("shop-api"), `새로 정함: ${v!.ids.join(",")}`);
});

test("PREVIDS 경계: 앞 판 ids 모양이 틀려도(손상) 가져오기는 새 id 로 계속된다", { skip }, async () => {
  const id = await seed("onprem");
  await imp.handleImport(job(id));
  await owner.query(`UPDATE spec_versions SET spec_v2 = jsonb_set(spec_v2, '{ids}', '{"k8s.deployment//shop/shop-api": 5}') WHERE migration_id=$1`, [id]);
  await owner.query("UPDATE migrations SET status='importing' WHERE id=$1", [id]);
  await imp.handleImport(job(id));
  assert.equal((await row(id)).status, "spec_review");
  const v = await ids(id);
  assert.equal(v.length, 2);
  assert.deepEqual(v[1]!.ids, v[0]!.ids);
});

// PREVIDS2: 다시 가져올 때 사람이 손댄 칸 유지
const HUMAN_RES = { request: { cpuMilli: 200, memMiB: 256 } };
const CK = "components.shop-cleanup.resources", PK = "components.shop-cleanup.probes";
/** 사람이 PATCH 한 것처럼 가장 새 판 위에 새 판을 쌓는다: resources 를 바꾸고(source human), probes 는 확인만(needs_review false) */
async function humanPatch(id: string) {
  const [last] = (await owner.query("SELECT version, spec, field_meta, spec_v2 FROM spec_versions WHERE migration_id=$1 ORDER BY version DESC LIMIT 1", [id])).rows as Array<{ version: number; spec: any; field_meta: any; spec_v2: any }>;
  const v2 = structuredClone(last!.spec_v2);
  v2.spec.components.find((c: { id: string }) => c.id === "shop-cleanup").props.resources = HUMAN_RES;
  v2.fieldMeta[CK] = { source: "human", confidence: 1, needs_review: false };
  v2.fieldMeta[PK] = { ...v2.fieldMeta[PK], needs_review: false };
  await owner.query(`INSERT INTO spec_versions (tenant_id, migration_id, version, spec, field_meta, spec_v2) VALUES ($1,$2,$3,$4,$5,$6)`,
    [T, id, last!.version + 1, last!.spec, last!.field_meta, v2]);
  await owner.query("UPDATE migrations SET status='importing' WHERE id=$1", [id]);
}
const lastV2 = async (id: string) => ((await owner.query("SELECT version, spec_v2 FROM spec_versions WHERE migration_id=$1 ORDER BY version DESC LIMIT 1", [id])).rows[0]) as { version: number; spec_v2: any };
const resOf = (v2: any) => v2.spec.components.find((c: { id: string }) => c.id === "shop-cleanup").props.resources;
const NOTE = "출발 값이 바뀜, 앞서 사람이 정한 값 있음";

test("PREVIDS2 첫 가져오기: 아무 영향 없음 (표시는 가져온 그대로, 사람 표시 없음)", { skip }, async () => {
  const id = await seed("onprem");
  await imp.handleImport(job(id));
  const { spec_v2 } = await lastV2(id);
  assert.deepEqual(resOf(spec_v2), {});
  assert.equal(spec_v2.fieldMeta[CK].needs_review, true);
  assert.notEqual(spec_v2.fieldMeta[CK].source, "human");
  assert.ok(!JSON.stringify(spec_v2.fieldMeta).includes(NOTE));
  const a = await owner.query("SELECT detail FROM audit_events WHERE target=$1 AND action='migration.spec_review'", [id]);
  assert.ok(!String(a.rows[0]?.detail?.note ?? "").includes("앞 판 사람 수정"));
});

test("PREVIDS2 유지: 출발 값이 그대로면 사람이 고친 값·표시와 확인한 칸이 새 판에도 그대로", { skip }, async () => {
  const id = await seed("onprem");
  await imp.handleImport(job(id));
  await humanPatch(id);
  await imp.handleImport(job(id));
  assert.equal((await row(id)).status, "spec_review");
  const { version, spec_v2 } = await lastV2(id);
  assert.equal(version, 3);
  assert.deepEqual(resOf(spec_v2), HUMAN_RES);
  assert.deepEqual(spec_v2.fieldMeta[CK], { source: "human", confidence: 1, needs_review: false });
  assert.equal(spec_v2.fieldMeta[PK].needs_review, false, "확인한 칸은 확인 상태로");
  assert.match(spec_v2.fieldMeta[PK].source, /probes/, "확인만 한 칸은 출처 그대로");
  // 고치지도 확인하지도 않은 칸은 가져온 그대로(다시 검토 표시 유지)
  const first = (await owner.query("SELECT spec_v2 FROM spec_versions WHERE migration_id=$1 AND version=1", [id])).rows[0].spec_v2;
  // G3b-5: app.name 은 앞 판 이름을 이어받는다 (검토 표시는 그대로, 설명 앞에 "앞 판 이름을 이어받음." 이 붙음)
  for (const k of Object.keys(first.fieldMeta).filter((x) => x !== CK && x !== PK && x !== "app.name")) assert.deepEqual(spec_v2.fieldMeta[k], first.fieldMeta[k], `손대지 않은 칸은 가져온 그대로: ${k}`);
  assert.deepEqual({ ...spec_v2.fieldMeta["app.name"], rationale: undefined }, { ...first.fieldMeta["app.name"], rationale: undefined }, "앱 이름 표시는 그대로");
  assert.deepEqual(Object.keys(spec_v2.fieldMeta).sort(), Object.keys(first.fieldMeta).sort());
});

test("PREVIDS2 달라짐: 출발 값이 바뀌었으면 새 값 + needs_review=true + 메모 (사람 값은 버림), 값이 안 바뀐 확인 칸은 유지", { skip }, async () => {
  const id = await seed("onprem");
  await imp.handleImport(job(id));
  await humanPatch(id);
  const src = adapters.DEMO_INVENTORY.onprem!;
  const orig = src.items;
  src.items = (orig as Array<any>).map((i) => i.kind !== "k8s.cronjob" ? i : (() => {
    const c = JSON.parse(JSON.stringify(i));
    c.spec.jobTemplate.spec.template.spec.containers[0].resources = { requests: { cpu: "500m", memory: "512Mi" }, limits: { cpu: "500m", memory: "512Mi" } };
    return c;
  })());
  try { await imp.handleImport(job(id)); } finally { src.items = orig; }
  const st = await row(id);
  const why = await owner.query("SELECT detail FROM audit_events WHERE target=$1 AND action='migration.failed'", [id]);
  assert.equal(st.status, "spec_review", `${st.failure_code} ${JSON.stringify(why.rows[0]?.detail?.error)}`);
  const { spec_v2 } = await lastV2(id);
  assert.notDeepEqual(resOf(spec_v2), HUMAN_RES);
  assert.notDeepEqual(resOf(spec_v2), {});
  assert.equal(spec_v2.fieldMeta[CK].needs_review, true);
  assert.notEqual(spec_v2.fieldMeta[CK].source, "human");
  assert.ok(String(spec_v2.fieldMeta[CK].rationale).includes(NOTE));
  assert.equal(spec_v2.fieldMeta[PK].needs_review, false, "출발 값이 안 바뀐 확인 칸(probes)은 확인 유지");
  const a = await owner.query("SELECT detail FROM audit_events WHERE target=$1 AND action='migration.spec_review' ORDER BY at DESC LIMIT 1", [id]);
  assert.match(String(a.rows[0]?.detail?.note), /유지 1칸, 출발 값 바뀌어 다시 검토 1칸/);
});
