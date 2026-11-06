// 온프레 출발 가져오기 (pull 모드) DB 왕복: agent_reports 의 마지막 inventory 보고 → discover 재생 → spec_review.
//   워커는 고객 클러스터에 붙지 않고(kubectl 없음) 관찰 역할도 빌리지 않는다. 오래된 스냅숏·폐기된 키의 스냅숏은 IMPORT_SOURCE_UNAVAILABLE. DB 없으면 건너뛴다
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import type { AgentInventorySnapshot } from "@svc/contracts";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;

let core: typeof import("@svc/core");
let imp: typeof import("../src/jobs/import.js");
let owner: pg.Client;
const T = randomUUID();
const saved = { MOCK_SEED: process.env.MOCK_SEED, FLOOR: process.env.ONPREM_FLOOR_VIA_GIT, PATH: process.env.PATH };

const NS = "shop";
const dep = (name: string) => ({ metadata: { name, namespace: NS, labels: { app: name } },
  spec: { replicas: 1, selector: { matchLabels: { app: name } }, template: { metadata: { labels: { app: name } }, spec: { containers: [{
    name, image: `ghcr.io/demo/${name}:1.0`, ports: [{ containerPort: 8080 }], resources: { requests: { cpu: "100m", memory: "128Mi" } } }] } } } });
const pod = (name: string) => ({ metadata: { name: `${name}-1`, namespace: NS, labels: { app: name } },
  status: { phase: "Running", containerStatuses: [{ name, imageID: `ghcr.io/demo/${name}@sha256:${"cd".repeat(32)}` }] } });
const empty = ["ingresses", "horizontalpodautoscalers", "cronjobs", "networkpolicies", "serviceaccounts", "configmaps", "persistentvolumeclaims",
  "poddisruptionbudgets", "roles", "rolebindings", "replicasets", "statefulsets", "daemonsets", "jobs", "clusterrolebindings"];
const snap: AgentInventorySnapshot = {
  kind: "inventory", agentVersion: "onprem-agent/t", sentAt: "2026-11-07T00:00:00Z", collectedAt: "2026-11-07T00:00:00Z",
  apiResources: { names: ["pods", "deployments"] },
  lists: [
    { resource: "nodes", items: [{ metadata: { name: "n1" }, status: { nodeInfo: { kubeletVersion: "v1.33.5+k3s1" }, allocatable: { cpu: "2", memory: "4Gi" } } }] },
    { resource: "namespaces", items: [{ metadata: { name: NS } }] },
    { resource: "deployments", items: [dep("web"), dep("api")] },
    { resource: "pods", items: [pod("web"), pod("api")] },
    { resource: "services", items: [{ metadata: { name: "web", namespace: NS }, spec: { selector: { app: "web" }, ports: [{ port: 80, targetPort: 8080 }] } }] },
    ...empty.map((resource) => ({ resource, items: [] })),
    { resource: "clusters.postgresql.cnpg.io", error: { exitCode: 1, stderr: `error: the server doesn't have a resource type "clusters"` } },
  ],
};

before(async () => {
  if (skip) return;
  delete process.env.MOCK_SEED;
  delete process.env.ONPREM_FLOOR_VIA_GIT;   // 기본 = pull 모드
  process.env.PATH = "/nonexistent";          // kubectl 을 부르면 못 찾아 실패한다 (= 워커가 클러스터에 붙지 않음을 확인)
  core = await import("@svc/core");
  imp = await import("../src/jobs/import.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1, 'test-inv-snap')", [T]);
});
after(async () => {
  if (skip) return;
  process.env.PATH = saved.PATH;
  if (saved.MOCK_SEED !== undefined) process.env.MOCK_SEED = saved.MOCK_SEED;
  if (saved.FLOOR !== undefined) process.env.ONPREM_FLOOR_VIA_GIT = saved.FLOOR;
  await core.pool.end(); await owner.end();
});

async function seed(o: { ageSec?: number; revoked?: boolean; report?: boolean } = {}) {
  const id = randomUUID(), src = randomUUID(), dst = randomUUID();
  const key = `ak_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES
    ($1,$3,'onprem','s','connected'), ($2,$3,'gcp','d','connected')`, [src, dst, T]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status) VALUES ($1,$2,$3,$4,'importing')`, [id, T, src, dst]);
  await owner.query(`INSERT INTO agent_keys (id, tenant_id, env_id, revoked_at) VALUES ($1,$2,$3,$4)`, [key, T, src, o.revoked ? new Date() : null]);
  if (o.report !== false) await owner.query(
    `INSERT INTO agent_reports (tenant_id, env_id, key_id, kind, signature, sent_at, received_at, body)
     VALUES ($1,$2,$3,'inventory',$4, now(), now() - make_interval(secs => $5), $6)`, [T, src, key, `sig-${id}`, o.ageSec ?? 5, JSON.stringify(snap)]);
  return id;
}
const job = (id: string) => ({ tenantId: T, requestId: `r-inv-${id.slice(0, 8)}`, migrationId: id });
const row = async (id: string) => (await owner.query("SELECT status, failure_code FROM migrations WHERE id=$1", [id])).rows[0];
const creds = async (id: string) => (await owner.query("SELECT 1 FROM temp_credentials WHERE migration_id=$1", [id])).rowCount;
const lastAudit = async (id: string) => (await owner.query(
  "SELECT detail FROM audit_events WHERE target=$1 AND action='migration.failed' ORDER BY seq DESC LIMIT 1", [id])).rows[0]?.detail as { error?: string } | undefined;

test("정상: 신선한 스냅숏으로 가져오기 → spec_review, kubectl·관찰 역할 없이 (워크로드 2개)", { skip }, async () => {
  const id = await seed();
  assert.equal(await imp.handleImport(job(id)), "advanced");
  assert.deepEqual(await row(id), { status: "spec_review", failure_code: null });
  assert.equal(await creds(id), 0, "관찰 역할을 빌리지 않는다");
  const spec = (await owner.query("SELECT spec_v2 FROM spec_versions WHERE migration_id=$1", [id])).rows[0]?.spec_v2 as { spec: { components: Array<{ name?: string }> } };
  assert.ok(JSON.stringify(spec.spec).includes("web") && JSON.stringify(spec.spec).includes("api"));
});

test("거부: 스냅숏이 상한(600초)보다 오래됨 → failed IMPORT_SOURCE_UNAVAILABLE + 이유", { skip }, async () => {
  const id = await seed({ ageSec: 1200 });
  await imp.handleImport(job(id));
  assert.deepEqual(await row(id), { status: "failed", failure_code: "IMPORT_SOURCE_UNAVAILABLE" });
  assert.match((await lastAudit(id))?.error ?? "", /상한 600초/);
});

test("거부: 스냅숏 없음 · 폐기된 키로 온 스냅숏 → failed IMPORT_SOURCE_UNAVAILABLE (스냅숏 없음)", { skip }, async () => {
  for (const o of [{ report: false }, { revoked: true }]) {
    const id = await seed(o);
    await imp.handleImport(job(id));
    assert.deepEqual(await row(id), { status: "failed", failure_code: "IMPORT_SOURCE_UNAVAILABLE" }, JSON.stringify(o));
    assert.match((await lastAudit(id))?.error ?? "", /스냅숏이 아직 없음/);
  }
});
