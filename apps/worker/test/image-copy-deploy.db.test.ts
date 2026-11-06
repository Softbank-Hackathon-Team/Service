// DB 시험: deploy 의 이미지 복사 자리. 진짜 handleDeploy + 진짜 GitopsRepo(git) + pg-boss, crane·자격만 가짜 (setImageCopyDeps).
//   복사가 실패하면 커밋 없이 paused(IMAGE_COPY_FAILED), 재개해 복사가 되면 그 주소로 커밋 → syncing, 감사 gitops.imageCopy 에 남는다
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import type { Exec } from "@svc/adapters";
import type { StepRoles, withStepRoles } from "../src/jobs/_roles.js";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;

let core: typeof import("@svc/core");
let adapters: typeof import("@svc/adapters");
let contracts: typeof import("@svc/contracts");
let dp: typeof import("../src/jobs/deploy.js");
let ic: typeof import("../src/jobs/image-copy.js");
let planV2: typeof import("../src/jobs/plan-v2.js");
let step: typeof import("../src/jobs/_step.js");
let owner: pg.Client;
let gitDir = "";
const T = randomUUID();
const ACCOUNT = "444455556666";
const SRC = "111122223333.dkr.ecr.us-west-2.amazonaws.com/shop/api", DIGEST = `sha256:${"e".repeat(64)}`;
const KEYS = ["MOCK_IAC", "MOCK_ARGO", "GITOPS_DISABLE", "GITOPS_REPO_DIR", "GITOPS_REPO_URL", "GITOPS_PUSH", "STUB_DELAY_MS", "SANDBOX_REHEARSAL"];
const prev = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

// 작은 gitops 레포 (rehearsal-gate.db.test 와 같은 자리): 값의 워크로드 이미지를 Deployment 로 그린다
const RENDER = `import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
const dir = resolve(new URL("..", import.meta.url).pathname, process.argv[2]);
const values = JSON.parse(readFileSync(join(dir, "values.yaml"), "utf8"));
const plan = JSON.parse(readFileSync(join(dir, "plan.json"), "utf8"));
const docs = (values.workloads ?? []).filter((w) => w.kind !== "job").map((w) => ({ apiVersion: "apps/v1", kind: "Deployment",
  metadata: { name: w.name, namespace: plan.target.namespace }, spec: { template: { spec: { containers: [{ name: "app", image: w.image }] } } } }));
const md = join(dir, "manifests");
rmSync(md, { recursive: true, force: true }); mkdirSync(md, { recursive: true });
const files = docs.map((d) => ({ name: "deployment-" + d.metadata.name + ".yaml", text: JSON.stringify(d, null, 2) + "\\n" }));
for (const f of files) writeFileSync(join(md, f.name), f.text);
plan.bundleSha256 = createHash("sha256").update(files.map((f) => f.name + "\\0" + f.text).join("\\0")).digest("hex");
writeFileSync(join(dir, "plan.json"), JSON.stringify(plan, null, 2) + "\\n");
`;
const git = (...a: string[]) => execFileSync("git", ["-C", gitDir, "-c", "user.name=t", "-c", "user.email=t@x", ...a], { encoding: "utf8" }).trim();

before(async () => {
  if (skip) return;
  gitDir = mkdtempSync(join(tmpdir(), "image-copy-gitops-"));
  for (const d of ["tools/node_modules", "charts/app", "platform"]) mkdirSync(join(gitDir, d), { recursive: true });
  writeFileSync(join(gitDir, "tools", "render.mjs"), RENDER);
  writeFileSync(join(gitDir, "tools", "validate.mjs"), "process.exit(0);\n");
  writeFileSync(join(gitDir, "charts", "app", "Chart.yaml"), "apiVersion: v2\nname: app\nversion: 0.4.0\n");
  writeFileSync(join(gitDir, "platform", "project-platform-root.yaml"), "spec:\n  sourceRepos:\n    - https://example.invalid/gitops.git\n");
  writeFileSync(join(gitDir, ".gitignore"), "node_modules/\n");
  execFileSync("git", ["init", "-q", "-b", "main", gitDir]);
  git("add", "-A"); git("commit", "-q", "-m", "seed");
  Object.assign(process.env, { STUB_DELAY_MS: "5", MOCK_IAC: "1", MOCK_ARGO: "1", GITOPS_REPO_DIR: gitDir, GITOPS_PUSH: "0" });
  delete process.env.GITOPS_DISABLE; delete process.env.GITOPS_REPO_URL; delete process.env.SANDBOX_REHEARSAL;
  core = await import("@svc/core");
  adapters = await import("@svc/adapters");
  contracts = await import("@svc/contracts");
  dp = await import("../src/jobs/deploy.js");
  ic = await import("../src/jobs/image-copy.js");
  planV2 = await import("../src/jobs/plan-v2.js");
  step = await import("../src/jobs/_step.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1, 'test-image-copy')", [T]);
  await core.startBoss();
});
after(async () => {
  if (skip) return;
  ic.setImageCopyDeps(undefined);
  await owner.query("DELETE FROM env_locks WHERE tenant_id = $1", [T]);
  for (const [k, v] of Object.entries(prev)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  await core.boss.stop({ graceful: false }); await core.pool.end(); await owner.end();
  rmSync(gitDir, { recursive: true, force: true });
});

/** GKE 데모 출발(shop-api 만 사설 ECR 이미지로 바꿈) → AWS 도착, deploying */
async function seed() {
  const id = randomUUID(), s = randomUUID(), d = randomUUID(), planId = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status, account_id) VALUES ($1,$3,'gcp','s','connected',NULL), ($2,$3,'aws','d','connected',$4)`, [s, d, T, ACCOUNT]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status) VALUES ($1,$2,$3,$4,'deploying')`, [id, T, s, d]);
  await owner.query(`INSERT INTO env_locks (env_id, tenant_id, migration_id, holder, lease_expires_at) VALUES ($1,$3,$4,'reserved', now() + interval '2 hours'), ($2,$3,$4,'reserved', now() + interval '2 hours')`, [s, d, T, id]);
  const raw = structuredClone(adapters.normalizeV2(adapters.DEMO_INVENTORY.gcp!).result);
  raw.spec.components = raw.spec.components.map((c) => c.id === "shop-api" && c.kind === "service"
    ? { ...c, props: { ...c.props, image: { source: "registry" as const, repository: SRC, digest: DIGEST } } } : c);
  const result = contracts.ImportResultV2.parse(raw);
  const tfOutputs = { ...adapters.STUB_TF_OUTPUTS, ...adapters.stubTfOutputsV2(result.spec) };
  const helmValuesHash = step.stableHash(planV2.helmValuesV2(result.spec, { envId: d, provider: "aws", region: "default", migrationId: id }));
  await core.withTenant(T, async (tx) => {
    await core.saveSpecRevision(tx, { tenantId: T, migrationId: id, specV2: result });
    await core.savePlan(tx, T, contracts.PlanDoc.parse({
      planId, migrationId: id, adapterVersion: "test", steps: [], precheck: [], rollbackCriteria: { errorRatePct: 1, p95Multiplier: 2, windowSec: 30 },
      tfPlanHash: "t", helmValuesHash, planHash: "p", expiresAt: new Date(Date.now() + 3600_000).toISOString() }));
    await core.saveInfraReady(tx, { tenantId: T, migrationId: id, planId, tfOutputs, helmValuesKey: "k" });
  });
  return id;
}
const job = (id: string) => ({ tenantId: T, requestId: `r-ic-${id.slice(0, 8)}`, migrationId: id });
const mig = async (id: string) => (await owner.query(`SELECT status, failure_code FROM migrations WHERE id=$1`, [id])).rows[0] as { status: string; failure_code: string | null };
const lastAudit = async (id: string, action: string) => (await owner.query(`SELECT detail FROM audit_events WHERE target=$1 AND action=$2 ORDER BY seq DESC LIMIT 1`, [id, action])).rows[0]?.detail as Record<string, any> | undefined;
const commits = () => Number(git("rev-list", "--count", "HEAD"));

function fakeRegistry(o: { copyFails: boolean }) {
  const store = new Map<string, string>();
  const exec: Exec = async (cmd, args) => {
    const r = (code: number, stdout = "", stderr = "") => ({ code, stdout, stderr, ms: 1 });
    if (cmd === "aws") return r(0, args[1] === "get-login-password" ? "pw\n" : "{}");
    if (args[0] === "digest") return store.has(args[1]!) ? r(0, store.get(args[1]!)!) : r(1, "", "MANIFEST_UNKNOWN");
    if (o.copyFails) return r(1, "", "DENIED: not authorized to perform ecr:InitiateLayerUpload");
    store.set(args[2]!, args[1]!.split("@")[1]!);
    return r(0);
  };
  const withRoles = (async (_s: string, _j: unknown, _m: unknown, fn: (r: StepRoles) => Promise<unknown>) =>
    fn({ creds: [], skipped: [], denied: [], awsEnv: { source: { AWS_CONFIG_FILE: "/s" }, target: { AWS_CONFIG_FILE: "/t" } } })) as typeof withStepRoles;
  return { exec, withRoles, env: { PATH: process.env.PATH, REAL_STS: "1" } };
}

test("복사 실패 → 커밋 없이 paused(IMAGE_COPY_FAILED), 재개해 복사되면 도착 ECR 주소로 커밋 → syncing, 감사에 복사한 주소", { skip }, async () => {
  const id = await seed();
  const ref = `${ACCOUNT}.dkr.ecr.ap-northeast-2.amazonaws.com/platform/${contracts.tenantSlug(T)}/api@${DIGEST}`;
  const c0 = commits();
  ic.setImageCopyDeps(fakeRegistry({ copyFails: true }));
  await dp.handleDeploy(job(id));
  assert.deepEqual(await mig(id), { status: "paused", failure_code: "IMAGE_COPY_FAILED" });
  assert.equal(commits(), c0, "복사 실패면 GitOps 커밋 없음");
  const paused = (await lastAudit(id, "deploy.paused"))!;
  assert.equal(paused.deploy.step, "copy_failed");
  assert.equal(paused.deploy.image, contracts.redactText(ref), "감사엔 계정 번호를 가린 주소 (AUD-1)");
  assert.match(paused.deploy.reason, /ecr:InitiateLayerUpload/);

  await owner.query(`UPDATE migrations SET status='deploying', failure_code=NULL, version = version + 1 WHERE id=$1`, [id]);
  ic.setImageCopyDeps(fakeRegistry({ copyFails: false }));
  await dp.handleDeploy(job(id));
  assert.equal((await mig(id)).status, "syncing");
  assert.equal(commits(), c0 + 1);
  const a = (await lastAudit(id, "deploy.syncing"))!;
  assert.deepEqual(a.gitops.imageCopy, { copied: [contracts.redactText(ref)], present: [] });
  assert.match(git("grep", "-l", "-F", ref, "HEAD"), /manifests\/deployment-/, "커밋한 매니페스트가 복사한 주소를 가리킨다");
});
