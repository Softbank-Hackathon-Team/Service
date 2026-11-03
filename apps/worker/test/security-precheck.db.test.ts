// 보안 판정 연결 DB 시험: 받아들인 판의 spec_v2(security 요구사항 + securityFacts)와 환경 region 을 읽어
//   사전 점검이 SEC:* 를 낸다. block 이면 spec_review, warn 이면 planning → 계획서 승인 항목 precheck_warn:SEC:…
//   깃발 SEC_PRECHECK 가 1 이 아니면(기본) 지금 동작 · 모양이 틀린 securityFacts 는 모름으로 · 남의 회사 판은 안 읽힘
import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { AppSpec, upconvertV1, type AppSpecV2 } from "@svc/contracts";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;

let core: typeof import("@svc/core");
let pre: typeof import("../src/jobs/precheck.js");
let plan: typeof import("../src/jobs/plan.js");
let owner: pg.Client;
const T = randomUUID(), OTHER = randomUUID();
const prev = { PLAN_IR: process.env.PLAN_IR, SEC_PRECHECK: process.env.SEC_PRECHECK, MOCK_PRECHECK: process.env.MOCK_PRECHECK };

const D = (c: string) => `sha256:${c.repeat(64)}`;
const V1 = AppSpec.parse({ schemaVersion: "1", app: { name: "shop" },
  service: { image: `registry/shop-api@${D("a")}`, port: 8080, healthPath: "/healthz", replicas: 2, cpu: "500m", memory: "1Gi",
    env: [{ name: "LOG_LEVEL", value: "info" }], secretRefs: [{ name: "DATABASE_PASSWORD", key: "password" }] },
  database: { engine: "postgres", majorVersion: "16", storageGb: 20 }, ingress: { hostname: "shop.example.com", entry: "cloudflare-lb" } });
const base = (): AppSpecV2 => structuredClone(upconvertV1(V1).spec);
const dbId = (s: AppSpecV2) => s.components.find((c) => c.kind === "postgres")!.id;
// 개인정보 · 허용 국가 KR · 고객 키
const withReq = (): AppSpecV2 => ({ ...base(), security: { requirements: { dataClass: "personal", residency: ["KR"], keyOwnership: "customer" } } });
const facts = (s: AppSpecV2) => ({ [dbId(s)]: {
  encryptedAtRest: { value: true, origin: "measured", source: "rds:shop-db.StorageEncrypted" },
  keyOwner: { value: null, origin: "unknown", source: null }, tlsEnforced: { value: null, origin: "unknown", source: null } } });

before(async () => {
  if (skip) return;
  process.env.MOCK_PRECHECK = "1";
  core = await import("@svc/core");
  pre = await import("../src/jobs/precheck.js");
  plan = await import("../src/jobs/plan.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1,'test-secprecheck'), ($2,'test-secprecheck-other')", [T, OTHER]);
  await core.startBoss();
});
afterEach(() => {
  for (const [k, v] of Object.entries(prev)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  process.env.MOCK_PRECHECK = "1";
});
after(async () => {
  if (skip) return;
  await core.boss.stop({ graceful: false }); await core.pool.end(); await owner.end();
});

type Prov = "aws" | "gcp" | "onprem";
// 출발 AWS 서울 → 도착 p, 상태 prechecking, 받아들인 판 1 (spec v1 + spec_v2 {spec, securityFacts}). securityFacts null = 칸 없는 옛 판
async function seed(p: Prov, region: string | null, spec: AppSpecV2, securityFacts: unknown = facts(spec), tenant = T) {
  const id = randomUUID(), src = randomUUID(), dst = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status, region) VALUES
    ($1,$3,'aws','s','connected','ap-northeast-2'), ($2,$3,$4,'d','connected',$5)`, [src, dst, tenant, p, region]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status) VALUES ($1,$2,$3,$4,'prechecking')`,
    [id, tenant, src, dst]);
  await owner.query(`INSERT INTO spec_versions (tenant_id, migration_id, version, spec, field_meta, spec_v2) VALUES ($1,$2,1,$3,'{}'::jsonb,$4)`,
    [tenant, id, V1, { spec, fieldMeta: {}, unmapped: [], ...(securityFacts === null ? {} : { securityFacts }) }]);
  return { id, src, dst };
}
const job = (id: string, tenantId = T) => ({ tenantId, requestId: `r-secpre-${id.slice(0, 8)}`, migrationId: id });
const mig = async (id: string) => (await owner.query(`SELECT status, failure_code FROM migrations WHERE id=$1`, [id])).rows[0] as
  { status: string; failure_code: string | null };
const lastPrecheck = async (id: string) => (await owner.query(
  `SELECT detail FROM audit_events WHERE target=$1 AND detail ? 'precheck' ORDER BY seq DESC LIMIT 1`, [id])).rows[0]?.detail as
  { precheck: Array<{ id: string; level: string; message: string }>; planId?: string };
const sec = (d: { precheck: Array<{ id: string; level: string }> }) => d.precheck.filter((i) => i.id.startsWith("SEC:")).map((i) => `${i.id}:${i.level}`);

test("GCP 도착 + 고객 키 요구: SEC:P-KEY-1 block → spec_review (계획 번호 없음)", { skip }, async () => {
  process.env.PLAN_IR = "v2"; process.env.SEC_PRECHECK = "1";
  const s = withReq();
  const { id } = await seed("gcp", "asia-northeast3", s);
  await pre.handlePrecheck(job(id));
  assert.equal((await mig(id)).status, "spec_review");
  const d = await lastPrecheck(id);
  assert.ok(sec(d).includes(`SEC:P-KEY-1:${dbId(s)}:block`), sec(d).join(" "));
  assert.equal(d.planId, undefined);
  // 같은 국가(KR)라 위치 막기는 없다 — environments.region 을 읽었다는 뜻
  assert.ok(!sec(d).some((x) => x.startsWith("SEC:P-LOC-1")), sec(d).join(" "));
});

test("온프레 도착: block 없이 planning, 고객 확인 경고가 계획서 승인 항목 precheck_warn:SEC:… 가 된다", { skip }, async () => {
  process.env.PLAN_IR = "v2"; process.env.SEC_PRECHECK = "1";
  const s = withReq();
  const { id } = await seed("onprem", null, s);
  await pre.handlePrecheck(job(id));
  assert.equal((await mig(id)).status, "planning", JSON.stringify(await lastPrecheck(id)));
  const d = await lastPrecheck(id);
  assert.ok(sec(d).includes(`SEC:P-KEY-2:${dbId(s)}:warn`), sec(d).join(" "));
  assert.ok(!sec(d).some((x) => x.endsWith(":block")));
  await plan.handlePlan({ ...job(id), planId: d.planId! });
  assert.equal((await mig(id)).status, "awaiting_approval");
  const p = await core.withTenant(T, (tx) => core.loadLatestPlan(tx, id));
  const acks = (p?.acknowledgements ?? []).map((a) => a.id);
  assert.ok(acks.includes(`precheck_warn:SEC:P-KEY-2:${dbId(s)}`), acks.join(" "));
});

test("securityFacts 를 실제로 읽는다: 요구사항이 없어도 출발 DB 가 고객 키(측정)면 GCP 도착은 P-KEY-1 막기. 모양이 틀린 사실은 모름", { skip }, async () => {
  process.env.PLAN_IR = "v2"; process.env.SEC_PRECHECK = "1";
  const s = base();   // security 요구사항 없음 → 키 규칙을 켜는 것은 출발 사실뿐
  const customerKey = { [dbId(s)]: { ...facts(s)[dbId(s)], keyOwner: { value: "customer", origin: "measured", source: "kms describe-key KeyManager=CUSTOMER" } } };
  const run = async (f: unknown) => {
    const { id, src, dst } = await seed("gcp", "asia-northeast3", s, f);
    return (await pre.securityPrecheckFor(T, { id, sourceEnvId: src, targetEnvId: dst } as never, { PLAN_IR: "v2", SEC_PRECHECK: "1" })).map((i) => `${i.id}:${i.level}`);
  };
  const read = await run(customerKey);
  assert.ok(read.includes(`SEC:P-KEY-1:${dbId(s)}:block`), read.join(" "));
  const broken = await run({ [dbId(s)]: { keyOwner: "customer" } });   // 모양 틀림 → 버리고 모름
  assert.ok(!broken.some((x) => x.startsWith("SEC:P-KEY-1")), broken.join(" "));
  const none = await run(null);   // 옛 판 (securityFacts 칸 없음)
  assert.ok(!none.some((x) => x.startsWith("SEC:P-KEY-1")), none.join(" "));
  assert.ok(none.includes("SEC:P-REQ-0:env:warn"), none.join(" "));
});

test("깃발: 기본(SEC_PRECHECK 없음)·0 이면 SEC 항목 없음 (지금 동작), PLAN_IR 이 v2 가 아니어도 없음", { skip }, async () => {
  process.env.PLAN_IR = "v2"; delete process.env.SEC_PRECHECK;
  const z = await seed("gcp", "asia-northeast3", withReq());
  await pre.handlePrecheck(job(z.id));
  assert.deepEqual(sec(await lastPrecheck(z.id)), []);
  process.env.SEC_PRECHECK = "0";
  const a = await seed("gcp", "asia-northeast3", withReq());
  await pre.handlePrecheck(job(a.id));
  assert.deepEqual(sec(await lastPrecheck(a.id)), []);
  assert.equal((await mig(a.id)).status, "planning");
  process.env.SEC_PRECHECK = "1"; delete process.env.PLAN_IR;
  const b = await seed("gcp", "asia-northeast3", withReq());
  await pre.handlePrecheck(job(b.id));
  assert.deepEqual(sec(await lastPrecheck(b.id)), []);
});

test("남의 회사: 다른 회사 이전 번호로 부르면 판을 못 읽어 빈 목록 (RLS)", { skip }, async () => {
  const { id, src, dst } = await seed("gcp", "asia-northeast3", withReq(), undefined, OTHER);
  const items = await pre.securityPrecheckFor(T, { id, sourceEnvId: src, targetEnvId: dst } as never, { PLAN_IR: "v2", SEC_PRECHECK: "1" });
  assert.deepEqual(items, []);
});
