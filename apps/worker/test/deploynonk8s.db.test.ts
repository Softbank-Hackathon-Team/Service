// DB 시험 (DEPLOYNONK8S): 도착이 ECS·Cloud Run·VM(Terraform 이 앱까지 띄움) 이면 배포 단계가 gitops·Argo 를 건너뛰고
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
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1, 'test-deploynonk8s'), ($2, 'test-deploynonk8s-other')", [T, OTHER]);
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
  const r: Raw = structuredClone(adapters.normalizeV2(adapters.DEMO_INVENTORY[kind === "k8s" ? "gcp" : "aws"]!).result);
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
    await core.saveSpecRevision(tx, { tenantId: tenant, migrationId: id, specV2: result });
    await core.savePlan(tx, tenant, contracts.PlanDoc.parse({
      planId, migrationId: id, adapterVersion: "test", steps: [], precheck: [], rollbackCriteria: { errorRatePct: 1, p95Multiplier: 2, windowSec: 30 },
      tfPlanHash: "t", helmValuesHash: "h", planHash: "p", expiresAt: new Date(Date.now() + 3600_000).toISOString() }));
    await core.saveInfraReady(tx, { tenantId: tenant, migrationId: id, planId, tfOutputs: outputs ? outputs(base) : base, helmValuesKey: "k" });
  });
  return id;
}
const mig = async (id: string) => (await owner.query(`SELECT status, failure_code FROM migrations WHERE id=$1`, [id])).rows[0] as { status: string; failure_code: string | null };
const lastDetail = async (id: string) => (await owner.query(`SELECT detail FROM audit_events WHERE target=$1 AND detail ? 'deploy' ORDER BY seq DESC LIMIT 1`, [id])).rows[0]?.detail as Raw;
const job = (id: string, tenant = T) => ({ tenantId: tenant, requestId: `r-dnk-${id.slice(0, 8)}`, migrationId: id });

test("ECS 도착(aws)·Cloud Run 도착(gcp): GitOps 설정 없어도 gitops 안 부르고 apply 출력으로 synced_healthy → syncing, 감사에 skipped=terraform_runtime", { skip }, async () => {
  process.env.MOCK_IAC = "1"; delete process.env.MOCK_ARGO;
  for (const dst of ["aws", "gcp"] as const) {
    const id = await seed("ecs", dst);
    await dp.handleDeploy(job(id));
    assert.deepEqual(await mig(id), { status: "syncing", failure_code: null }, dst);
    const d = await lastDetail(id);
    assert.equal(d.deploy.status, "synced_healthy");
    assert.deepEqual(d.gitops, { skipped: "terraform_runtime", runtime: "managedContainer", checked: "outputs", attempts: 0 });
    const kind = dst === "aws" ? "EcsService" : "CloudRunService";
    assert.deepEqual(d.deploy.resources, ["shop-api", "shop-web", "shop-worker"].map((x) => `${kind}/${x}/stub-${x}`));
    assert.ok(!("commit" in d.gitops) && !("argoApp" in d.gitops));
  }
});

test("VM 도착(aws EC2): 인스턴스 목록이 resources, gitops 건너뜀 / k8s 도착은 그대로 paused GITOPS_NOT_CONFIGURED", { skip }, async () => {
  process.env.MOCK_IAC = "1"; delete process.env.MOCK_ARGO;
  const vm = await seed("vm", "aws");
  await dp.handleDeploy(job(vm));
  assert.equal((await mig(vm)).status, "syncing");
  const d = await lastDetail(vm);
  assert.deepEqual(d.deploy.resources, ["Ec2Instance/shop-api/stub-shop-api-1", "Ec2Instance/shop-api/stub-shop-api-2", "Ec2Instance/shop-worker/stub-shop-worker-1"]);
  assert.equal(d.gitops.runtime, "vm");
  const k8s = await seed("k8s", "gcp");
  await dp.handleDeploy(job(k8s));
  assert.deepEqual(await mig(k8s), { status: "paused", failure_code: "GITOPS_NOT_CONFIGURED" });
  // k8s + MOCK_ARGO=1 은 예전 흉내 길 그대로 (gitops: mock)
  process.env.MOCK_ARGO = "1";
  const k2 = await seed("k8s", "gcp");
  await dp.handleDeploy(job(k2));
  assert.equal((await mig(k2)).status, "syncing");
  assert.deepEqual((await lastDetail(k2)).gitops, { mock: true });
});

test("거부: apply 출력에 서비스 이름이 없으면 paused RUNTIME_OUTPUT_MISSING (재개 가능), 건강 조회가 끝까지 안 되면 RUNTIME_UNHEALTHY, CLI 실패면 RUNTIME_CHECK_FAILED", { skip }, async () => {
  process.env.MOCK_IAC = "1";
  const miss = await seed("ecs", "aws", (o) => { const x = { ...o }; delete x["service.shop-web.name"]; x.service_names = JSON.stringify({ "shop-api": "a", "shop-worker": "w" }); return x; });
  await dp.handleDeploy(job(miss));
  assert.deepEqual(await mig(miss), { status: "paused", failure_code: "RUNTIME_OUTPUT_MISSING" });
  assert.match((await lastDetail(miss)).deploy.reason, /service\.shop-web\.name/);
  // 진짜 길(MOCK_IAC 끔) + 가짜 CLI: running 0/1 이 계속 → 시도 소진
  delete process.env.MOCK_IAC;
  const calls: string[] = [];
  dp.setRuntimeHealthDeps({ attempts: 3, sleep: async () => {}, exec: async (cmd, args) => {
    calls.push(`${cmd} ${args.join(" ")}`);
    return { code: 0, ms: 1, stderr: "", stdout: JSON.stringify({ services: ["stub-shop-api", "stub-shop-web", "stub-shop-worker"].map((n) => ({ serviceName: n, status: "ACTIVE", desiredCount: 1, runningCount: 0 })) }) };
  } });
  const sick = await seed("ecs", "aws");
  await dp.handleDeploy(job(sick));
  assert.deepEqual(await mig(sick), { status: "paused", failure_code: "RUNTIME_UNHEALTHY" });
  assert.equal(calls.length, 3);
  assert.ok(calls.every((c) => c.startsWith("aws ecs describe-services --cluster stub-") && c.includes(" --region ap-northeast-2 ")), calls[0]);
  dp.setRuntimeHealthDeps({ attempts: 2, sleep: async () => {}, exec: async () => ({ code: 254, ms: 1, stdout: "", stderr: "AccessDenied for arn:aws:iam::123456789012:role/x" }) });
  const denied = await seed("ecs", "aws");
  await dp.handleDeploy(job(denied));
  assert.deepEqual(await mig(denied), { status: "paused", failure_code: "RUNTIME_CHECK_FAILED" });
  const reason = (await lastDetail(denied)).deploy.reason as string;
  assert.ok(!reason.includes("123456789012") && /••••9012/.test(reason), reason);
  // 고쳐서 다시: 건강해지면 같은 이전이 syncing 으로 (paused → deploying 재개 흉내)
  dp.setRuntimeHealthDeps({ attempts: 2, sleep: async () => {}, exec: async () => ({ code: 0, ms: 1, stderr: "",
    stdout: JSON.stringify({ services: ["stub-shop-api", "stub-shop-web", "stub-shop-worker"].map((n) => ({ serviceName: n, status: "ACTIVE", desiredCount: 2, runningCount: 2 })) }) }) });
  await owner.query(`UPDATE migrations SET status='deploying', failure_code=NULL WHERE id=$1`, [sick]);
  await dp.handleDeploy(job(sick));
  assert.equal((await mig(sick)).status, "syncing");
  assert.deepEqual((await lastDetail(sick)).gitops, { skipped: "terraform_runtime", runtime: "managedContainer", checked: "live", attempts: 1 });
  dp.setRuntimeHealthDeps({});
  process.env.MOCK_IAC = "1";
});

test("멱등·회사 경계: 이미 syncing 인 이전에 같은 작업이 또 와도 그대로, 다른 회사 이름으로 온 작업은 아무것도 안 바꿈", { skip }, async () => {
  process.env.MOCK_IAC = "1"; delete process.env.MOCK_ARGO;
  const id = await seed("ecs", "aws");
  await dp.handleDeploy(job(id));
  const n = Number((await owner.query(`SELECT count(*) FROM audit_events WHERE target=$1 AND detail ? 'deploy'`, [id])).rows[0].count);
  await dp.handleDeploy(job(id));
  assert.equal((await mig(id)).status, "syncing");
  assert.equal(Number((await owner.query(`SELECT count(*) FROM audit_events WHERE target=$1 AND detail ? 'deploy'`, [id])).rows[0].count), n, "두 번째 작업이 배포를 또 함");
  const other = await seed("ecs", "aws");
  await dp.handleDeploy(job(other, OTHER)).catch(() => undefined);
  assert.equal((await mig(other)).status, "deploying");
});
