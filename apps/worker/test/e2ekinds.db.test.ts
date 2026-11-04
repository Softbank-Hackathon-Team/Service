// DB 시험 (E2EKINDS): 출발 종류 3가지(k8s·ECS·VM)를 흉내 길로 22상태 끝까지.
//   진짜 API(buildApp, app.inject) + 진짜 워커 처리 함수(HANDLERS). 큐는 pg-boss 표에서 이 이전의 작업을 하나씩 꺼내 처리 함수에 넘긴다(워커 흉내).
//   흉내 길: MOCK_SEED(출발 원본 = 데모) · MOCK_PRECHECK · MOCK_IAC · MOCK_ARGO, IMPORT_IR=v2 · PLAN_IR=v2 · PLAN_ACKS=1. 실클라우드 호출 0.
//   VM 출발은 MOCK_SEED 데모가 없어 가짜 aws CLI(PATH 앞, 읽기 명령만 답함)로 가져온다. 이미지가 빌드 자리(IR-11 사람 결정)라 계획 전에 멈추는 것을 기록한다
process.env.TRAFFIC_OBSERVE_SEC = "1";   // @svc/core 를 부르기 전에 (관찰 최소 시간은 불러올 때 읽음)
process.env.PROM_URL = "";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import type { FastifyInstance } from "fastify";
import { smokeConfirmReview, smokePlanBodies } from "../../../tools/smoke-env.js";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;
const P = "/api/v1";
const T = randomUUID();
const FLAGS: Record<string, string> = {
  MOCK_SEED: "1", MOCK_PRECHECK: "1", MOCK_IAC: "1", MOCK_ARGO: "1", IMPORT_IR: "v2", PLAN_IR: "v2", PLAN_ACKS: "1",
  ROLLBACK_WINDOW_SEC: "0", TRAFFIC_TICK_MS: "1", STUB_DELAY_MS: "5", GITOPS_DISABLE: "1", GITOPS_REPO_DIR: "", GITOPS_REPO_URL: "",
  REPL_SOURCE_URL: "", SPEC_MIN_CONFIDENCE: "", TENANT_MAX_ACTIVE: "", RATE_LIMIT: "0",
};
const prev = Object.fromEntries([...Object.keys(FLAGS), "PATH", "AWS_REGION"].map((k) => [k, process.env[k]]));

let core: typeof import("@svc/core");
let H: typeof import("../src/jobs/index.js")["HANDLERS"];
let app: FastifyInstance;
let owner: pg.Client;
let dir = "";

before(async () => {
  if (skip) return;
  Object.assign(process.env, FLAGS);
  core = await import("@svc/core");
  H = (await import("../src/jobs/index.js")).HANDLERS;
  app = (await (await import("../../api/src/app.js")).buildApp({ logStream: { write: () => {} } })).app;
  await app.ready();
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1, 'test-e2ekinds')", [T]);
  dir = mkdtempSync(join(tmpdir(), "e2ekinds-"));
  await core.startBoss();
});
after(async () => {
  if (skip) return;
  for (const [k, v] of Object.entries(prev)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  rmSync(dir, { recursive: true, force: true });
  await owner.query("DELETE FROM env_locks WHERE tenant_id=$1", [T]);
  await core.boss.stop({ graceful: false }); await app.close(); await core.pool.end(); await owner.end();
});

type Call = (method: string, path: string, body?: unknown) => Promise<Record<string, unknown>>;
const call: Call = async (method, path, body) => {
  const r = await app.inject({ method: method as "GET", url: `${P}${path}`, headers: { "x-dev-tenant": T, "idempotency-key": randomUUID() },
    ...(method === "GET" ? {} : { payload: (body ?? {}) as object }) });
  const json = r.json() as Record<string, unknown>;
  if (r.statusCode >= 400) throw new Error(`${method} ${path} → ${r.statusCode} ${JSON.stringify(json).slice(0, 400)}`);
  return json;
};
const status = async (id: string) => (await owner.query(`SELECT status, failure_code FROM migrations WHERE id=$1`, [id])).rows[0] as { status: string; failure_code: string | null };
/** 감사에 남은 상태 전이 순서 (advance 가 남기는 from·to) */
const path = async (id: string) => {
  const r = await owner.query(`SELECT detail->>'from' AS f, detail->>'to' AS t FROM audit_events WHERE target=$1 AND detail ? 'from' AND detail ? 'to' ORDER BY seq`, [id]);
  return r.rows.length ? [r.rows[0].f as string, ...r.rows.map((x) => x.t as string)] : [];
};

/** 워커 흉내: 이 이전의 대기 작업을 하나씩 꺼내 처리 함수에 넘긴다. stop 상태에 닿거나 작업이 없으면 멈춘다 */
async function drain(id: string, stop: string[], max = 80): Promise<string> {
  for (let i = 0; i < max; i++) {
    const s = (await status(id)).status;
    if (stop.includes(s)) return s;
    const j = (await owner.query(`SELECT id, name, data FROM pgboss.job WHERE state IN ('created','retry') AND data->>'migrationId' = $1
      ORDER BY created_on, id LIMIT 1`, [id])).rows[0] as { id: string; name: string; data: unknown } | undefined;
    if (!j) return s;
    await owner.query(`UPDATE pgboss.job SET state='completed', completed_on=now() WHERE id=$1`, [j.id]);
    const h = H[j.name as keyof typeof H];
    if (h) await h(j.data);
  }
  return (await status(id)).status;
}

async function envs(src: "aws" | "gcp", dst: "aws" | "gcp") {
  const s = randomUUID(), d = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status, account_id) VALUES ($1,$3,$4,'src','connected',$6), ($2,$3,$5,'dst','connected',$7)`,
    [s, d, T, src, dst, src === "aws" ? "000000000000" : "demo-project", dst === "aws" ? "000000000000" : "demo-project"]);
  return { sourceEnvId: s, targetEnvId: d };
}

/** 연결된 두 환경 → 이전 만들기 → … → completed. 각 단계 결과와 전이 순서를 돌려준다 */
async function runAll(src: "aws" | "gcp", dst: "aws" | "gcp") {
  const { id } = await call("POST", "/migrations", await envs(src, dst)) as { id: string };
  let s = await drain(id, ["spec_review", "failed"]);
  assert.equal(s, "spec_review", `가져오기 ${s}`);
  await smokeConfirmReview(call, id);                       // 사람 확인 칸 confirm + 방화벽 모름 → 허용 목록 [] (smoke 와 같은 사람 결정)
  await call("POST", `/migrations/${id}/plan`);
  s = await drain(id, ["awaiting_approval", "spec_review", "failed"]);
  return { id, s };
}
async function approveAndFinish(id: string) {
  const plan = await call("GET", `/migrations/${id}/plan`) as { planId: string; planHash: string; acknowledgements?: { id: string }[] };
  const b = smokePlanBodies(plan);
  await call("POST", `/plans/${plan.planId}/approvals`, b.approve);
  assert.equal((await status(id)).status, "approved");
  await call("POST", `/migrations/${id}/start`, b.start);
  const s = await drain(id, ["completed", "paused", "failed", "rolled_back"]);
  return { s, plan };
}
const HAPPY = ["draft", "importing", "spec_review", "prechecking", "planning", "awaiting_approval", "approved", "provisioning",
  "deploying", "syncing", "shifting", "cutover", "rollback_window", "cleanup", "completed"];
/** 정상 경로 부분열인지 (precheck 가 spec_review 로 돌려보낸 뒤 다시 오는 것은 허용) */
const assertHappy = (p: string[], why: string) => {
  const flat = p.filter((x, i) => !(x === "spec_review" && p[i - 1] === "prechecking") && !(x === "prechecking" && p[i - 1] === "spec_review" && p.slice(0, i - 1).includes("prechecking")));
  const dedup = flat.filter((x, i) => x !== flat[i - 1]);
  assert.deepEqual(dedup.filter((x) => HAPPY.includes(x)), dedup, `${why}: 정상 경로 밖 상태 ${dedup.join("→")}`);
  assert.deepEqual(HAPPY.filter((x) => dedup.includes(x)), HAPPY.filter((x) => x !== "draft" || dedup.includes("draft")), `${why}: 빠진 상태 ${dedup.join("→")}`);
};
const deployDetail = async (id: string) => (await owner.query(`SELECT detail FROM audit_events WHERE target=$1 AND detail ? 'deploy' ORDER BY seq DESC LIMIT 1`, [id])).rows[0]?.detail;

for (const dst of ["gcp", "aws"] as const) {
  test(`k8s 출발(GKE 데모) → ${dst} k8s: 연결 → … → completed, 배포는 gitops(MOCK_ARGO) 길, 상태 순서`, { skip }, async () => {
    const { id, s } = await runAll("gcp", dst);
    assert.equal(s, "awaiting_approval", `계획 전 멈춤: ${JSON.stringify(await status(id))}`);
    const { s: end, plan } = await approveAndFinish(id);
    const p = await path(id);
    console.log(`E2EKINDS k8s→${dst}: ${p.join("→")}`);
    assert.equal(end, "completed", `${JSON.stringify(await status(id))} ${p.join("→")}`);
    assertHappy(p, `k8s→${dst}`);
    assert.ok(!(plan.acknowledgements ?? []).some((a) => /runtime_change/.test(a.id)), "출발과 같은 종류인데 실행 방식 바뀜 승인 줄");
    assert.deepEqual((await deployDetail(id)).gitops, { mock: true });
  });
}

for (const dst of ["aws", "gcp"] as const) {
  test(`ECS 출발(aws 데모) → ${dst === "aws" ? "ECS" : "Cloud Run"}: 끝까지 completed, 배포는 gitops 건너뜀(terraform_runtime), 상태 순서`, { skip }, async () => {
    const { id, s } = await runAll("aws", dst);
    assert.equal(s, "awaiting_approval", `계획 전 멈춤: ${JSON.stringify(await status(id))}`);
    const { s: end } = await approveAndFinish(id);
    const p = await path(id);
    console.log(`E2EKINDS ecs→${dst}: ${p.join("→")}`);
    assert.equal(end, "completed", `${JSON.stringify(await status(id))} ${p.join("→")}`);
    assertHappy(p, `ecs→${dst}`);
    const d = await deployDetail(id);
    assert.equal(d.gitops.skipped, "terraform_runtime");
    assert.equal(d.gitops.runtime, "managedContainer");
    assert.ok(d.deploy.resources.every((r: string) => r.startsWith(dst === "aws" ? "EcsService/" : "CloudRunService/")), d.deploy.resources.join());
  });
}

// ── VM: 가짜 aws CLI (EC2 2묶음, EKS·ECS 없음) ─────────────────────────────
type Reply = { code?: number; out?: unknown; err?: string };
const inst = (id: string, name: string, type: string, sg: string) => ({ InstanceId: id, InstanceType: type, State: { Name: "running" },
  Placement: { AvailabilityZone: "ap-northeast-2a" }, SecurityGroups: [{ GroupId: sg }], PrivateIpAddress: "10.0.1.5", Tags: [{ Key: "Name", Value: name }] });
const AWS_VM: Array<[string, Reply]> = [
  ["^aws sts get-caller-identity", { out: { Account: "000000000000" } }],
  ["^aws eks list-clusters", { out: { clusters: [] } }], ["^aws ecs list-clusters", { out: { clusterArns: [] } }],
  ["^aws ec2 describe-instances", { out: { Reservations: [{ Instances: [inst("i-web", "shop-web-1", "t3.medium", "sg-web"), inst("i-api", "shop-api-1", "m5.large", "sg-api")] }] } }],
  ["^aws ec2 describe-security-groups", { out: { SecurityGroups: [
    { GroupId: "sg-web", IpPermissions: [{ IpProtocol: "tcp", FromPort: 80, ToPort: 80, IpRanges: [{ CidrIp: "0.0.0.0/0" }], UserIdGroupPairs: [] }] },
    { GroupId: "sg-api", IpPermissions: [{ IpProtocol: "tcp", FromPort: 8080, ToPort: 8080, IpRanges: [], UserIdGroupPairs: [{ GroupId: "sg-web" }] }] }] } }],
  ["^aws ec2 describe-instance-types", { out: { InstanceTypes: [{ InstanceType: "t3.medium", VCpuInfo: { DefaultVCpus: 2 }, MemoryInfo: { SizeInMiB: 4096 } },
    { InstanceType: "m5.large", VCpuInfo: { DefaultVCpus: 2 }, MemoryInfo: { SizeInMiB: 8192 } }] } }],
  ["^aws rds describe-db-instances", { out: { DBInstances: [] } }],
  ["^aws ", { out: {} }],
];
function installFakeAws() {
  writeFileSync(join(dir, "fake.mjs"), `
const table = JSON.parse(${JSON.stringify(JSON.stringify(AWS_VM))});
const line = process.argv.slice(2).join(" ");
const hit = table.find(([re]) => new RegExp(re).test(line));
if (!hit) { process.stderr.write("no fake for: " + line); process.exit(1); }
const r = hit[1]; process.stdout.write(typeof r.out === "string" ? r.out : JSON.stringify(r.out ?? null)); process.stderr.write(r.err ?? ""); process.exit(r.code ?? 0);
`);
  writeFileSync(join(dir, "aws"), `#!/bin/sh\nexec node "${join(dir, "fake.mjs")}" aws "$@"\n`); chmodSync(join(dir, "aws"), 0o755);
}

for (const dst of ["aws", "gcp"] as const) {
  test(`VM 출발(EC2 가짜 CLI) → ${dst === "aws" ? "EC2" : "GCE"}: 명세 검토(spec_review)까지 간다, 이미지는 빌드 자리로 남음`, { skip }, async () => {
    installFakeAws();
    process.env.PATH = `${dir}:${prev.PATH}`; process.env.AWS_REGION = "ap-northeast-2";
    delete process.env.MOCK_SEED;
    try {
      const { id } = await call("POST", "/migrations", await envs("aws", dst)) as { id: string };
      const s1 = await drain(id, ["spec_review", "failed"]);
      const last = (await owner.query(`SELECT detail FROM audit_events WHERE target=$1 AND detail ? 'to' ORDER BY seq DESC LIMIT 1`, [id])).rows[0]?.detail as { error?: string } | undefined;
      const p = await path(id);
      console.log(`E2EKINDS vm→${dst}: ${p.join("→")} · ${JSON.stringify(await status(id))} · ${last?.error}`);
      // 명세가 하나(spec_v2)가 된 뒤로는 v1 투영이 없어 VM 출발도 명세 검토까지 간다. 이미지 빌드 자리(IR-11)는 명세에 build 로 남고 계획 단계 몫
      assert.equal(s1, "spec_review", String(last?.error));
      assert.deepEqual(p, ["draft", "importing", "spec_review"]);
      const v = (await owner.query(`SELECT spec, spec_v2 FROM spec_versions WHERE migration_id=$1`, [id])).rows[0];
      assert.deepEqual(v.spec, {});
      const svcs = (v.spec_v2.spec.components as Array<{ kind: string; props: { image?: { source: string } } }>).filter((c) => c.kind === "service");
      assert.ok(svcs.length > 0 && svcs.some((c) => c.props.image?.source === "build"), JSON.stringify(svcs.map((c) => c.props.image)));
      assert.equal((await owner.query(`SELECT count(*)::int AS n FROM plans WHERE migration_id=$1`, [id])).rows[0].n, 0);
    } finally {
      process.env.MOCK_SEED = "1"; process.env.PATH = prev.PATH!;
    }
  });
}
