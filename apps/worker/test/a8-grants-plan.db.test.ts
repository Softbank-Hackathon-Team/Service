// A8 DB 시험: 출발 IAM 권한(grants·posture.permissions)이 든 v2 명세로 PLAN_IR=v2 사전 점검 → 계획까지 (깃발 on 끝까지)
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
const withCache = (): AppSpecV2 => { const s = ok();
  s.components.push({ id: "shop-cache", kind: "cache", props: { engine: "redis", memoryMiB: 512, tls: true, auth: true } }); return s; };

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
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1,'test-a8'), ($2,'test-a8-other')", [T, OTHER]);
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
const job = (id: string, tenantId = T) => ({ tenantId, requestId: `r-a8-${id.slice(0, 8)}`, migrationId: id });
const mig = async (id: string) => (await owner.query(`SELECT status, failure_code FROM migrations WHERE id=$1`, [id])).rows[0] as
  { status: string; failure_code: string | null };
const lastAudit = async (id: string) => (await owner.query(
  `SELECT action, result, detail FROM audit_events WHERE target=$1 AND detail ? 'from' ORDER BY seq DESC LIMIT 1`, [id])).rows[0];
const unsupOf = (d: any) => (d.precheck as Array<{ id: string; level: string; message: string }>).filter((i) => i.id.startsWith("PC-V2-UNSUP"));
const settle = () => new Promise((r) => setTimeout(r, 150));

const DB_ARN = "arn:aws:rds:ap-northeast-2:999999999999:db:shop-db";
const withIam = (): AppSpecV2 => { const s = ok(), a = svc(s), db = s.components.find((c) => c.kind === "postgres")!;
  s.links = s.links.map((l) => l.from === a.id && l.to === db.id ? { ...l, grants: [{ effect: "Allow" as const, actions: ["rds:RebootDBInstance"], resources: [DB_ARN] }] } : l);
  s.posture.permissions = [{ subject: a.id, source: "iam:r", effect: "Deny", actions: ["rds:DeleteDBInstance"], resources: ["*"], mode: "mirror" }];
  return s; };

test("깃발 on: 권한 든 명세 + aws 도착 → precheck 경고만(PC-V2-GRANTS)·planning → 계획 awaiting_approval (irVersion 2)", { skip }, async () => {
  const s = withIam();
  assert.ok(s.links.some((l) => l.grants?.length), "시험 재료: grants 가 붙은 의존성");
  const id = await seed("aws", s);
  await pre.handlePrecheck(job(id));
  assert.equal((await mig(id)).status, "planning");
  const a = await lastAudit(id);
  const items = a.detail.precheck as Array<{ id: string; level: string; message: string }>;
  assert.deepEqual(items.filter((i) => i.level === "block"), []);
  assert.ok(items.some((i) => i.id.startsWith("PC-V2-GRANTS") && i.level === "warn" && /권한 경계/.test(i.message)));
  await plan.handlePlan({ ...job(id), planId: a.detail.planId as string });
  const m = await mig(id);
  assert.equal(m.status, "awaiting_approval", JSON.stringify(m));
  assert.ok((await core.withTenant(T, (tx) => core.loadLatestPlan(tx, id))));
});

test("거부: 같은 명세 + gcp 도착 → RDS 재부팅 권한 대응 역할 없음으로 block → spec_review (failed 아님)", { skip }, async () => {
  const id = await seed("gcp", withIam());
  await pre.handlePrecheck(job(id));
  const m = await mig(id);
  assert.equal(m.status, "spec_review");
  assert.equal(m.failure_code, null);
  const u = (await lastAudit(id)).detail.precheck.filter((i: { id: string }) => i.id.startsWith("PC-V2-UNSUP"));
  assert.ok(u.some((i: { message: string }) => /GCP 대응 역할 없음 rds:RebootDBInstance/.test(i.message)));
});

