// DB 시험 (VDEPLOYNONK8S, DEPLOYNONK8S 검증): 도착이 ECS·Cloud Run·VM(Terraform 이 앱까지 띄움) 이면 배포 단계가 gitops·Argo 를 건너뛰고
//   apply 출력 + 건강 확인으로 deploying → syncing. k8s 도착은 지금 그대로(GitOps 설정 없으면 paused GITOPS_NOT_CONFIGURED). 실클라우드 호출 0
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;

let core: typeof import("@svc/core");
let adapters: typeof import("@svc/adapters");
let contracts: typeof import("@svc/contracts");
let dp: typeof import("../src/jobs/deploy.js");
let owner: pg.Client;
const T = randomUUID(), OTHER = randomUUID();
const KEYS = ["MOCK_IAC", "MOCK_ARGO", "GITOPS_DISABLE", "GITOPS_REPO_DIR", "GITOPS_REPO_URL", "STUB_DELAY_MS"];
const prev = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
type Raw = Record<string, any>;

before(async () => {
  if (skip) return;
  process.env.STUB_DELAY_MS = "10";
  process.env.GITOPS_DISABLE = "1"; delete process.env.GITOPS_REPO_DIR; delete process.env.GITOPS_REPO_URL;
  core = await import("@svc/core");
  adapters = await import("@svc/adapters");
  contracts = await import("@svc/contracts");
  dp = await import("../src/jobs/deploy.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1, 'test-vdeploynonk8s'), ($2, 'test-vdeploynonk8s-other')", [T, OTHER]);
  await core.startBoss();
});
after(async () => {
  if (skip) return;
  await owner.query("DELETE FROM env_locks WHERE tenant_id = ANY($1)", [[T, OTHER]]);
  for (const [k, v] of Object.entries(prev)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  dp.setRuntimeHealthDeps({});
  await core.boss.stop({ graceful: false }); await core.pool.end(); await owner.end();
});

/** 출발 aws 데모(ECS) / gcp 데모(GKE) 를 그대로 또는 VM 으로 */
function specOf(kind: "ecs" | "vm" | "k8s") {
  const r: Raw = structuredClone(adapters.normalizeV2(adapters.DEMO_INVENTORY_V2[kind === "k8s" ? "gcp" : "aws"]!).result);
  if (kind === "vm") {
    for (const c of r.spec.components) if (c.kind === "service") { c.props.origin = { runtime: "vm", product: "ec2" }; c.props.runtime = "vm"; }
    r.spec.components = r.spec.components.filter((c: Raw) => c.id !== "shop-web");
    r.spec.links = r.spec.links.filter((l: Raw) => l.from !== "shop-web" && l.to !== "shop-web");
    r.spec.entry.hosts[0].routes = r.spec.entry.hosts[0].routes.filter((x: Raw) => x.backends.every((b: Raw) => b.to !== "shop-web"));
  }
  return contracts.ImportResultV2.parse(r);
}

/** deploying 상태 이전 하나: 승인 명세(v1+v2) + v2 계획서 + 도착 자원 준비됨(흉내 출력) */
async function seed(kind: "ecs" | "vm" | "k8s", dst: "aws" | "gcp", outputs?: (o: Record<string, string>) => Record<string, string>, tenant = T) {
  const id = randomUUID(), s = randomUUID(), d = randomUUID(), planId = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES ($1,$3,'aws','s','connected'), ($2,$3,$4,'d','connected')`, [s, d, tenant, dst]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status) VALUES ($1,$2,$3,$4,'deploying')`, [id, tenant, s, d]);
  // 계획 승인 때 잡아 두는 환경 잠금 (실제 흐름과 같게)
  await owner.query(`INSERT INTO env_locks (env_id, tenant_id, migration_id, holder, lease_expires_at) VALUES ($1,$3,$4,'reserved', now() + interval '2 hours'), ($2,$3,$4,'reserved', now() + interval '2 hours')`, [s, d, tenant, id]);
  const result = specOf(kind);
  const base = { ...adapters.STUB_TF_OUTPUTS, ...adapters.stubTfOutputsV2(result.spec) };
  await core.withTenant(tenant, async (tx) => {
    await core.saveSpecRevision(tx, { tenantId: tenant, migrationId: id, spec: adapters.DEMO_SPEC, fieldMeta: {}, specV2: result });
    await core.savePlan(tx, tenant, contracts.PlanDoc.parse({
      planId, migrationId: id, adapterVersion: "test", steps: [], precheck: [], rollbackCriteria: { errorRatePct: 1, p95Multiplier: 2, windowSec: 30 },
      tfPlanHash: "t", helmValuesHash: "h", irVersion: "2", specSource: "spec_v2", planHash: "p", expiresAt: new Date(Date.now() + 3600_000).toISOString() }));
    await core.saveInfraReady(tx, { tenantId: tenant, migrationId: id, planId, tfOutputs: outputs ? outputs(base) : base, helmValuesKey: "k" });
  });
  return id;
}
const mig = async (id: string) => (await owner.query(`SELECT status, failure_code FROM migrations WHERE id=$1`, [id])).rows[0] as { status: string; failure_code: string | null };
const lastDetail = async (id: string) => (await owner.query(`SELECT detail FROM audit_events WHERE target=$1 AND detail ? 'deploy' ORDER BY seq DESC LIMIT 1`, [id])).rows[0]?.detail as Raw;
const job = (id: string, tenant = T) => ({ tenantId: tenant, requestId: `r-dnk-${id.slice(0, 8)}`, migrationId: id });


const detailAll = async (id: string) => JSON.stringify((await owner.query(`SELECT detail FROM audit_events WHERE target=$1 ORDER BY seq`, [id])).rows.map((r) => r.detail));
const ecsOut = (n: number, run: number) => ({ services: ["stub-shop-api", "stub-shop-web", "stub-shop-worker"].map((x) => ({ serviceName: x, status: "ACTIVE", desiredCount: n, runningCount: run })) });
const runOut = (ready: string) => ({ status: { conditions: [{ type: "Ready", status: ready }] } });

// 도착 4종 × 건강하지 않음 → paused(RUNTIME_UNHEALTHY) → 고친 뒤 재개 → syncing
const CASES: Array<{ name: string; kind: "ecs" | "vm"; dst: "aws" | "gcp"; sick: unknown; well: unknown }> = [
  { name: "ECS(aws)", kind: "ecs", dst: "aws", sick: ecsOut(1, 0), well: ecsOut(1, 1) },
  { name: "Cloud Run(gcp)", kind: "ecs", dst: "gcp", sick: runOut("False"), well: runOut("True") },
  { name: "EC2(aws)", kind: "vm", dst: "aws", sick: { InstanceStatuses: [] }, well: { InstanceStatuses: ["stub-shop-api-1", "stub-shop-api-2", "stub-shop-worker-1"].map((i) => ({ InstanceId: i, InstanceState: { Name: "running" } })) } },
  { name: "GCE(gcp)", kind: "vm", dst: "gcp", sick: [], well: ["stub-shop-api-1", "stub-shop-api-2", "stub-shop-worker-1"].map((n) => ({ name: n, status: "RUNNING" })) },
];
for (const c of CASES) {
  test(`${c.name}: 안 뜸 → paused RUNTIME_UNHEALTHY(재시도 소진) → 고친 뒤 deploying 으로 돌리면 syncing, gitops 한 번도 안 부름`, { skip }, async () => {
    delete process.env.MOCK_IAC;
    let n = 0;
    let body: unknown = c.sick;
    dp.setRuntimeHealthDeps({ attempts: 3, sleep: async () => {}, exec: async () => { n++; return { code: 0, ms: 1, stderr: "", stdout: JSON.stringify(body) }; } });
    const id = await seed(c.kind, c.dst);
    await dp.handleDeploy(job(id));
    assert.deepEqual(await mig(id), { status: "paused", failure_code: "RUNTIME_UNHEALTHY" });
    assert.ok(n >= 3, `3번 다시 봄: ${n}`);
    body = c.well;
    await owner.query(`UPDATE migrations SET status='deploying', failure_code=NULL WHERE id=$1`, [id]);
    await dp.handleDeploy(job(id));
    assert.equal((await mig(id)).status, "syncing");
    assert.equal((await lastDetail(id)).gitops.skipped, "terraform_runtime");
    dp.setRuntimeHealthDeps({}); process.env.MOCK_IAC = "1";
  });
  test(`${c.name}: 조회 CLI 가 실패하면 paused RUNTIME_CHECK_FAILED, 출력이 빠지면 RUNTIME_OUTPUT_MISSING`, { skip }, async () => {
    delete process.env.MOCK_IAC;
    dp.setRuntimeHealthDeps({ attempts: 2, sleep: async () => {}, exec: async () => ({ code: 1, ms: 1, stdout: "", stderr: "boom" }) });
    const a = await seed(c.kind, c.dst);
    await dp.handleDeploy(job(a));
    assert.deepEqual(await mig(a), { status: "paused", failure_code: "RUNTIME_CHECK_FAILED" });
    const b = await seed(c.kind, c.dst, (o) => Object.fromEntries(Object.entries(o).filter(([k]) => !/^(service\.|service_names|vm_instance|vm\.)/.test(k))));
    await dp.handleDeploy(job(b));
    assert.deepEqual(await mig(b), { status: "paused", failure_code: "RUNTIME_OUTPUT_MISSING" });
    dp.setRuntimeHealthDeps({}); process.env.MOCK_IAC = "1";
  });
}

test("감사·이전 기록에 비밀·주소가 안 남는다: 조회 오류 글의 액세스 키·토큰·IP·URL 쿼리·계정 번호", { skip }, async () => {
  delete process.env.MOCK_IAC;
  const stderr = "AccessDenied: user AKIAIOSFODNN7EXAMPLE arn:aws:iam::123456789012:role/x token=SeCrEtToKeN123 from 203.0.113.9 https://svc.internal.example/health?access_token=abcd1234";
  dp.setRuntimeHealthDeps({ attempts: 1, sleep: async () => {}, exec: async () => ({ code: 254, ms: 1, stdout: "", stderr }) });
  const id = await seed("ecs", "aws");
  await dp.handleDeploy(job(id));
  const all = await detailAll(id);
  for (const bad of ["123456789012", "SeCrEtToKeN123", "abcd1234", "AKIAIOSFODNN7EXAMPLE"]) assert.ok(!all.includes(bad), `감사에 ${bad} 남음: ${all.slice(0, 400)}`);
  dp.setRuntimeHealthDeps({}); process.env.MOCK_IAC = "1";
});

test("실행 역할만: 비k8s 도착의 배포 확인은 도착 관찰 역할을 빌리고(감사 temp_role), 흉내 길에서도 빌림·회수가 짝이 맞는다. k8s 도착은 역할을 안 빌린다(지금 그대로)", { skip }, async () => {
  process.env.MOCK_IAC = "1";
  const roleRows = async (id: string) => (await owner.query(`SELECT action, detail FROM audit_events WHERE target=$1 AND action LIKE 'temp_role.%' ORDER BY seq`, [id])).rows;
  const e = await seed("ecs", "aws");
  await dp.handleDeploy(job(e));
  assert.equal((await mig(e)).status, "syncing");
  const rows = await roleRows(e);
  const acts = rows.map((r) => r.action);
  assert.ok(acts.includes("temp_role.issued") || acts.includes("temp_role.issue"), `빌림 감사 없음: ${acts}`);
  assert.equal(acts.filter((a) => /issued|issue$/.test(a)).length, acts.filter((a) => /revoked/.test(a)).length, `빌림·회수 짝: ${acts}`);
  assert.ok(!JSON.stringify(rows).match(/operate|apply/), "실행(쓰기) 역할은 안 빌림");
  const k = await seed("k8s", "aws");
  process.env.MOCK_ARGO = "1";
  await dp.handleDeploy(job(k));
  assert.deepEqual(await roleRows(k), [], "k8s 도착은 배포 단계에서 역할을 빌리지 않음(지금 그대로)");
  delete process.env.MOCK_ARGO;
});

test("k8s 도착은 글자 하나 안 바뀜: GitOps 설정 없고 MOCK_ARGO 없으면 paused GITOPS_NOT_CONFIGURED, 감사에 gitops.skipped 없음", { skip }, async () => {
  process.env.MOCK_IAC = "1"; delete process.env.MOCK_ARGO;
  const id = await seed("k8s", "aws");
  await dp.handleDeploy(job(id));
  assert.deepEqual(await mig(id), { status: "paused", failure_code: "GITOPS_NOT_CONFIGURED" });
  assert.ok(!(await detailAll(id)).includes("terraform_runtime"));
});
