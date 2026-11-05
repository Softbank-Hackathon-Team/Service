// VE2Ev5 DB 시험: PLAN_IR=v2 사전 점검이 도착이 못 그리는 v2 명세를 막으면 failed 가 아니라 spec_review 로 되돌린다 (E2E-v5 고침).
//   도착 4개 × 못 그리는 조합 · 명세 고친 뒤 재점검 → planning → 계획서 · 감사 detail·SSE 신호 모양 · 깃발 off 면 지금 동작 · 남의 회사
import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { AppSpecV2 } from "@svc/contracts";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;

let core: typeof import("@svc/core");
let pre: typeof import("../src/jobs/precheck.js");
let plan: typeof import("../src/jobs/plan.js");
let owner: pg.Client, listener: pg.Client;
const T = randomUUID(), OTHER = randomUUID();
const prev = { PLAN_IR: process.env.PLAN_IR, MOCK_PRECHECK: process.env.MOCK_PRECHECK };
const events: Array<{ t: string; id: string; s: string }> = [];

const D = (c: string) => `sha256:${c.repeat(64)}`;
// 데모 명세 (shop 서비스 1개 + postgres 1개)
const BASE: AppSpecV2 = AppSpecV2.parse({"schemaVersion":"2","app":{"name":"shop"},"components":[{"id":"shop","kind":"service","props":{"runtime":"k8s","origin":{"runtime":"k8s","product":"unknown"},"image":{"source":"registry","repository":"registry/shop-api","digest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"ports":[{"port":8080,"protocol":"TCP"}],"probes":{"readiness":{"type":"http","path":"/healthz","port":8080}},"replicas":{"min":2,"max":2},"serviceAccount":"default","resources":{"request":{"cpuMilli":500,"memMiB":1024}},"env":[{"name":"LOG_LEVEL","value":"info"},{"name":"DATABASE_PASSWORD","fromSecret":{"secret":"DATABASE_PASSWORD","key":"password"}}]}},{"id":"db","kind":"postgres","props":{"majorVersion":"16","storageGb":20}}],"links":[{"from":"shop","to":"db","intent":"connect"}],"entry":{"via":"cloudflare-lb","hosts":[{"hostnames":["shop.example.com"],"routes":[{"matches":[{"path":{"type":"PathPrefix","value":"/"}}],"backends":[{"to":"shop","port":8080,"weight":1}]}]}]},"posture":{"permissions":[],"network":[]}});
const ok = (): AppSpecV2 => structuredClone(BASE);
const svc = (s: AppSpecV2) => s.components.find((c) => c.kind === "service")! as Extract<AppSpecV2["components"][number], { kind: "service" }>;
const twoIds = (): AppSpecV2 => { const s = ok(), a = svc(s);
  s.components.push({ ...structuredClone(a), id: `${a.id}-2`, props: { ...structuredClone(a.props), serviceAccount: "other-sa" } }); return s; };
// TA12: redis·valkey 는 aws·gcp·azure_mock 이 그림 → 거부 경로는 모듈이 못 만드는 memcached 로
const withMemcached = (): AppSpecV2 => { const s = withCache(); (s.components.find((c) => c.kind === "cache")!.props as { engine: string }).engine = "memcached"; return s; };
const withCache = (): AppSpecV2 => { const s = ok();
  s.components.push({ id: "shop-cache", kind: "cache", props: { engine: "redis", memoryMiB: 512, tls: true, auth: true } }); return s; };
// VTA12fix: AWS 는 캐시 AUTH 를 아직 못 옮겨 auth=true 면 사람 확인(block). auth=false(사람이 AUTH 없이 가기로 함)면 그림
const withCacheNoAuth = (): AppSpecV2 => { const s = withCache(); (s.components.find((c) => c.kind === "cache")!.props as { auth: boolean }).auth = false; return s; };

before(async () => {
  if (skip) return;
  process.env.MOCK_PRECHECK = "1";
  core = await import("@svc/core");
  pre = await import("../src/jobs/precheck.js");
  plan = await import("../src/jobs/plan.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  listener = new pg.Client({ connectionString: OWNER }); await listener.connect();
  listener.on("notification", (n) => { if (n.channel === "migration_events" && n.payload) events.push(JSON.parse(n.payload)); });
  await listener.query("LISTEN migration_events");
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1,'test-ve2ev5'), ($2,'test-ve2ev5-other')", [T, OTHER]);
  await core.startBoss();
});
afterEach(() => {
  for (const [k, v] of Object.entries(prev)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  process.env.MOCK_PRECHECK = "1";
});
after(async () => {
  if (skip) return;
  await core.boss.stop({ graceful: false }); await core.pool.end(); await listener.end(); await owner.end();
});

type Prov = "aws" | "gcp" | "onprem" | "azure_mock";
// 출발 onprem → 도착 p, 상태 prechecking, 받아들인 판 1 (spec_v2)
async function seed(p: Prov, v2: AppSpecV2 | null, tenant = T) {
  const id = randomUUID(), src = randomUUID(), dst = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES
    ($1,$3,'onprem','s','connected'), ($2,$3,$4,'d','connected')`, [src, dst, tenant, p]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status) VALUES ($1,$2,$3,$4,'prechecking')`,
    [id, tenant, src, dst]);
  await owner.query(`INSERT INTO spec_versions (tenant_id, migration_id, version, spec, field_meta, spec_v2) VALUES ($1,$2,1,$3,'{}'::jsonb,$4)`,
    [tenant, id, {}, v2 ? { spec: v2, fieldMeta: {}, unmapped: [] } : null]);
  return id;
}
const job = (id: string, tenantId = T) => ({ tenantId, requestId: `r-ve2ev5-${id.slice(0, 8)}`, migrationId: id });
const mig = async (id: string) => (await owner.query(`SELECT status, failure_code FROM migrations WHERE id=$1`, [id])).rows[0] as
  { status: string; failure_code: string | null };
const lastAudit = async (id: string) => (await owner.query(
  `SELECT action, result, detail FROM audit_events WHERE target=$1 AND detail ? 'from' ORDER BY seq DESC LIMIT 1`, [id])).rows[0];
const unsupOf = (d: any) => (d.precheck as Array<{ id: string; level: string; message: string }>).filter((i) => i.id.startsWith("PC-V2-UNSUP"));
const settle = () => new Promise((r) => setTimeout(r, 150));

test("도착 4개 × 못 그리는 조합: block 이면 spec_review(failed 아님), 그릴 수 있으면 planning", { skip }, async () => {
  const cases: Array<[Prov, () => AppSpecV2, string]> = [
    ["azure_mock", twoIds, "spec_review"], ["azure_mock", withMemcached, "spec_review"], ["azure_mock", withCache, "planning"], ["azure_mock", ok, "planning"],
    ["aws", withMemcached, "spec_review"], ["aws", withCache, "spec_review"], ["aws", withCacheNoAuth, "planning"], ["aws", twoIds, "planning"],
    ["gcp", withMemcached, "spec_review"], ["gcp", withCache, "planning"], ["gcp", twoIds, "planning"],
    ["onprem", withCache, "spec_review"], ["onprem", twoIds, "planning"],
  ];
  const got: string[] = [];
  for (const [p, mk, want] of cases) {
    const id = await seed(p, mk());
    await pre.handlePrecheck(job(id));
    const m = await mig(id);
    got.push(`${p}/${mk.name}:${m.status}${m.failure_code ? `(${m.failure_code})` : ""}`);
    assert.equal(m.failure_code, null);
    void want;
  }
  assert.deepEqual(got, cases.map(([p, mk, w]) => `${p}/${mk.name}:${w}`));
});

test("감사·SSE 모양: block 전이 감사 detail 에 precheck 목록(PC-V2-UNSUP block + fix)·evidence.precheckBlockers, 신호는 {t,id,s:spec_review}", { skip }, async () => {
  const id = await seed("azure_mock", twoIds());
  events.length = 0;
  await pre.handlePrecheck(job(id));
  await settle();
  const a = await lastAudit(id);
  assert.equal(a.result, "ok");
  assert.equal(a.detail.from, "prechecking");
  assert.equal(a.detail.to, "spec_review");
  const u = unsupOf(a.detail);
  assert.equal(u.length, 1);
  assert.equal(u[0]!.level, "block");
  assert.match(u[0]!.message, /^FAIL .*azure_mock 은 신원 1개만/);
  assert.ok((a.detail.precheck as any[]).some((i) => i.id === "PC-V2-SOURCE" && i.level === "info"));
  assert.equal(a.detail.evidence.precheckBlockers, a.detail.precheck.filter((i: any) => i.level === "block").length);
  assert.equal(a.detail.failureCode, undefined);
  assert.equal(a.detail.planId, undefined, "막혔는데 계획 번호가 생김");
  const mine = events.filter((e) => e.id === id);
  assert.deepEqual(mine, [{ t: T, id, s: "spec_review" }], "SSE 신호는 회사·이전·새 상태만 (명세·목록 안 실림)");
  const q = await owner.query(`SELECT count(*)::int AS n FROM pgboss.job WHERE name='plan' AND data->>'migrationId'=$1`, [id]);
  assert.equal(q.rows[0].n, 0, "막혔는데 계획 작업이 들어감");
});

test("명세를 고치면(신원 1개 판) 다시 점검 → planning + 계획 작업, 계획 단계도 failed 없이 awaiting_approval", { skip }, async () => {
  const id = await seed("azure_mock", twoIds());
  await pre.handlePrecheck(job(id));
  assert.equal((await mig(id)).status, "spec_review");
  // 사람이 고친 새 받아들인 판 (PATCH 대신 시험 준비로 바로 넣음) + 다시 계획 요청(spec_review → prechecking)
  await owner.query(`INSERT INTO spec_versions (tenant_id, migration_id, version, spec, field_meta, spec_v2) VALUES ($1,$2,2,$3,'{}'::jsonb,$4)`,
    [T, id, {}, { spec: ok(), fieldMeta: {}, unmapped: [] }]);
  await core.withTenant(T, (tx) => core.advance(tx, { id, tenantId: T }, "spec_review", "prechecking",
    { audit: { actor: "user:test", action: "migration.plan_requested", target: id, result: "ok" } }));
  await pre.handlePrecheck(job(id));
  assert.equal((await mig(id)).status, "planning");
  const a = await lastAudit(id);
  assert.deepEqual(unsupOf(a.detail), []);
  const planId = a.detail.planId as string;
  assert.ok(planId);
  await plan.handlePlan({ ...job(id), planId });
  const m = await mig(id);
  assert.equal(m.status, "awaiting_approval", JSON.stringify(m));
  const p = await core.withTenant(T, (tx) => core.loadLatestPlan(tx, id));
  assert.ok(p);
});

test("두 번 돌려도 같다: block 뒤 같은 작업이 다시 오면(상태가 이미 spec_review) 전이·임시 역할·신호 없이 job.rejected 한 줄만", { skip }, async () => {
  const id = await seed("aws", withMemcached());
  await pre.handlePrecheck(job(id));
  const acts = async () => (await owner.query(`SELECT action FROM audit_events WHERE target=$1 ORDER BY seq`, [id])).rows.map((r) => r.action);
  const n1 = (await acts()).length;
  // 첫 점검의 신호는 다른 연결로 늦게 온다. 받기 전에 목록을 비우면 두 번째 점검의 신호로 세어진다
  for (let i = 0; i < 250 && !events.some((e) => e.id === id); i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(events.filter((e) => e.id === id).length, 1, "첫 점검의 신호를 못 받음");
  events.length = 0;
  await pre.handlePrecheck(job(id));
  await settle();
  assert.equal((await mig(id)).status, "spec_review");
  assert.deepEqual((await acts()).slice(n1), ["job.rejected"]);
  assert.equal(events.filter((e) => e.id === id).length, 0);
});

test("남의 회사: 다른 회사 번호로 온 작업은 남의 이전을 안 건드린다 (상태·감사 그대로)", { skip }, async () => {
  const id = await seed("azure_mock", twoIds());
  await pre.handlePrecheck(job(id, OTHER)).catch(() => undefined);
  assert.equal((await mig(id)).status, "prechecking");
  const rows = (await owner.query(`SELECT tenant_id, action, result FROM audit_events WHERE target=$1`, [id])).rows;
  assert.deepEqual(rows.map((r) => [r.tenant_id, r.action, r.result]), [[OTHER, "job.rejected", "denied"]], "거부 기록은 보낸 회사 쪽에만");
  assert.deepEqual(await pre.v2PrecheckFor(OTHER, { id, targetEnvId: randomUUID() } as any), []);
});
