// DB 시험 (E2EDATA): 데이터 자원(S3·SQS+DLQ·ElastiCache / GCS·Pub/Sub·Memorystore)이 낀 v2 끝-끝.
//   가짜 aws·gcloud·kubectl(PATH 앞에 둔 실행 파일, 읽기 명령만 답함) → handleImport(MOCK_SEED 끔) → 계획(PLAN_IR=v2) → 사전 점검.
//   각 단계에서 데이터 자원이 빠지거나 지어낸 값이 생기지 않는지 본다. 실클라우드 호출 0
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;

let core: typeof import("@svc/core");
let imp: typeof import("../src/jobs/import.js");
let plan: typeof import("../src/jobs/plan.js");
let pre: typeof import("../src/jobs/precheck.js");
let owner: pg.Client;
let dir = "";
const T = randomUUID(), OTHER = randomUUID();
const KEYS = ["MOCK_IAC", "PATH", "MOCK_SEED", "IMPORT_IR", "PLAN_IR", "AWS_REGION", "GCP_PROJECT", "FAKE_CLI_LOG"];
const prev = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

type Reply = { code?: number; out?: unknown; err?: string };
const D = "sha256:" + "ab".repeat(32);
const KC: Array<[string, Reply]> = [
  ["^kubectl get deployments", { out: { items: [{ kind: "Deployment", metadata: { name: "shop-api", namespace: "shop", labels: { app: "shop-api" } }, spec: { replicas: 2, selector: { matchLabels: { app: "shop-api" } },
    template: { metadata: { labels: { app: "shop-api" } }, spec: { containers: [{ name: "api", image: "ghcr.io/demo/shop-api:1.0", ports: [{ containerPort: 8080 }], resources: { requests: { cpu: "500m", memory: "512Mi" } },
      env: [{ name: "QUEUE_URL", value: "https://sqs.ap-northeast-1.amazonaws.com/123456789012/orders" }, { name: "BUCKET", value: "shop-assets" },
            { name: "REDIS_HOST", value: "shop-cache.abc.ng.0001.apne1.cache.amazonaws.com" }] }] } } } }] } }],
  ["^kubectl get pods", { out: { items: [{ metadata: { name: "shop-api-1", namespace: "shop", labels: { app: "shop-api" } }, status: { containerStatuses: [{ name: "api", imageID: `ghcr.io/demo/shop-api@${D}` }] } }] } }],
  ["^kubectl get nodes", { out: { items: [] } }],
  ["^kubectl get (services|ingresses|horizontalpodautoscalers|cronjobs|statefulsets|configmaps|namespaces)", { out: { items: [] } }],
];
const AWS: Array<[string, Reply]> = [
  ["^aws sts get-caller-identity", { out: { Account: "123456789012" } }],
  ["^aws eks list-clusters", { out: { clusters: ["c1"] } }],
  ["^aws eks describe-cluster", { out: { cluster: { version: "1.31", resourcesVpcConfig: { vpcId: "vpc-1" } } } }],
  ["^aws eks update-kubeconfig", { out: "ok" }],
  ["^aws rds describe-db-instances", { out: { DBInstances: [] } }], ["^aws ec2 describe-vpcs", { out: { Vpcs: [] } }], ["^aws elbv2", { out: { LoadBalancers: [] } }],
  ["^aws ecr", { out: { repositories: [] } }], ["^aws secretsmanager", { out: { SecretList: [] } }],
  ["^aws s3api list-buckets", { out: { Buckets: [{ Name: "shop-assets" }] } }],
  ["get-bucket-versioning", { out: { Status: "Enabled" } }],
  ["get-public-access-block", { out: { PublicAccessBlockConfiguration: { BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: true, RestrictPublicBuckets: true } } }],
  ["get-bucket-policy-status", { out: { PolicyStatus: { IsPublic: false } } }],
  ["get-bucket-acl", { out: { Grants: [] } }],
  ["get-bucket-lifecycle-configuration", { code: 254, err: "NoSuchLifecycleConfiguration" }],
  ["get-bucket-cors", { code: 254, err: "NoSuchCORSConfiguration" }],
  ["cloudwatch get-metric-statistics", { out: { Datapoints: [{ Timestamp: "2026-11-01T00:00:00Z", Average: 2147483648 }] } }],
  ["^aws sqs list-queues", { out: { QueueUrls: ["https://sqs.ap-northeast-1.amazonaws.com/123456789012/orders", "https://sqs.ap-northeast-1.amazonaws.com/123456789012/orders-dlq"] } }],
  ["^aws sqs get-queue-attributes.*orders-dlq", { out: { Attributes: { VisibilityTimeout: "30", MessageRetentionPeriod: "1209600", QueueArn: "arn:aws:sqs:ap-northeast-1:123456789012:orders-dlq" } } }],
  ["^aws sqs get-queue-attributes", { out: { Attributes: { VisibilityTimeout: "60", MessageRetentionPeriod: "345600", QueueArn: "arn:aws:sqs:ap-northeast-1:123456789012:orders",
    RedrivePolicy: JSON.stringify({ deadLetterTargetArn: "arn:aws:sqs:ap-northeast-1:123456789012:orders-dlq", maxReceiveCount: 5 }) } } }],
  ["^aws elasticache describe-replication-groups", { out: { ReplicationGroups: [{ ReplicationGroupId: "shop-cache", MemberClusters: ["shop-cache-001"], CacheNodeType: "cache.t4g.medium",
    NodeGroups: [{ PrimaryEndpoint: { Address: "shop-cache.abc.ng.0001.apne1.cache.amazonaws.com" } }], ClusterEnabled: false, MultiAZ: "enabled", TransitEncryptionEnabled: true }] } }],
  ["^aws elasticache describe-cache-clusters", { out: { CacheClusters: [{ Engine: "redis", EngineVersion: "7.1.0" }] } }],
  ...KC,
];
const GCP: Array<[string, Reply]> = [
  ["^gcloud projects describe", { out: { projectId: "p" } }],
  ["^gcloud container clusters list", { out: [{ name: "g1", location: "asia-northeast3" }] }],
  ["^gcloud container clusters get-credentials", { out: "ok" }],
  ["^gcloud sql instances list", { out: [] }], ["^gcloud compute", { out: [] }], ["^gcloud artifacts", { out: [] }], ["^gcloud secrets", { out: [] }],
  ["gcloud storage buckets list", { out: [{ name: "shop-assets", versioning_enabled: true, public_access_prevention: "enforced" }] }],
  ["gcloud storage buckets get-iam-policy", { out: { bindings: [{ role: "roles/storage.objectViewer", members: ["serviceAccount:x@p.iam.gserviceaccount.com"] }] } }],
  ["gcloud pubsub topics list", { out: [{ name: "projects/p/topics/orders" }, { name: "projects/p/topics/orders-dlq" }] }],
  ["gcloud pubsub subscriptions list", { out: [{ name: "projects/p/subscriptions/orders-sub", topic: "projects/p/topics/orders", ackDeadlineSeconds: 60,
    deadLetterPolicy: { deadLetterTopic: "projects/p/topics/orders-dlq", maxDeliveryAttempts: 5 } }] }],
  ["gcloud redis instances list", { out: [{ name: "projects/p/locations/asia-northeast3/instances/shop-cache", redisVersion: "REDIS_7_0", memorySizeGb: 2, tier: "STANDARD_HA", host: "10.9.0.3" }] }],
  ...KC,
];

function installFakeClis(table: Array<[string, Reply]>) {
  const js = `import { readFileSync, appendFileSync } from "node:fs";
const table = JSON.parse(${JSON.stringify(JSON.stringify(table))});
const [bin, ...args] = process.argv.slice(2); const line = bin + " " + args.join(" ");
if (process.env.FAKE_CLI_LOG) appendFileSync(process.env.FAKE_CLI_LOG, line + "\\n");
const hit = table.find(([re]) => new RegExp(re).test(line));
if (!hit) { process.stderr.write("no fake for: " + line); process.exit(1); }
const r = hit[1]; process.stdout.write(typeof r.out === "string" ? r.out : JSON.stringify(r.out ?? null)); process.stderr.write(r.err ?? ""); process.exit(r.code ?? 0);
`;
  writeFileSync(join(dir, "fake.mjs"), js);
  for (const b of ["aws", "gcloud", "kubectl"]) {
    writeFileSync(join(dir, b), `#!/bin/sh\nexec node "${join(dir, "fake.mjs")}" ${b} "$@"\n`); chmodSync(join(dir, b), 0o755);
  }
  writeFileSync(join(dir, "calls.log"), "");
  process.env.FAKE_CLI_LOG = join(dir, "calls.log");
}

before(async () => {
  if (skip) return;
  core = await import("@svc/core");
  imp = await import("../src/jobs/import.js");
  plan = await import("../src/jobs/plan.js");
  pre = await import("../src/jobs/precheck.js");
  dir = mkdtempSync(join(tmpdir(), "e2edata-"));
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1, 'test-e2edata'), ($2, 'test-e2edata-other')", [T, OTHER]);
  await core.startBoss();
});
after(async () => {
  if (skip) return;
  for (const [k, v] of Object.entries(prev)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  rmSync(dir, { recursive: true, force: true });
  await core.boss.stop({ graceful: false }); await core.pool.end(); await owner.end();
});

async function seed(src: "aws" | "gcp", dst: "aws" | "gcp", status = "importing") {
  const id = randomUUID(), s = randomUUID(), d = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES ($1,$3,$4,'s','connected'), ($2,$3,$5,'d','connected')`, [s, d, T, src, dst]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status) VALUES ($1,$2,$3,$4,$5)`, [id, T, s, d, status]);
  return id;
}
const mig = async (id: string) => (await owner.query(`SELECT status, failure_code FROM migrations WHERE id=$1`, [id])).rows[0] as { status: string; failure_code: string | null };
const specRow = async (id: string) => (await owner.query(`SELECT spec, field_meta, spec_v2 FROM spec_versions WHERE migration_id=$1 ORDER BY version DESC LIMIT 1`, [id])).rows[0] as
  { spec: any; field_meta: any; spec_v2: any };
const pjob = (id: string) => ({ tenantId: T, requestId: `r-e2ed-${id.slice(0, 8)}`, migrationId: id });
const job = (id: string) => ({ ...pjob(id), planId: randomUUID() });
const comps = (v2: any, kind: string) => (v2.spec.components as Array<{ id: string; kind: string; props: any }>).filter((c) => c.kind === kind);

async function importWith(provider: "aws" | "gcp", dst: "aws" | "gcp") {
  installFakeClis(provider === "aws" ? AWS : GCP);
  process.env.PATH = `${dir}:${prev.PATH}`;
  delete process.env.MOCK_SEED;
  process.env.IMPORT_IR = "v2"; process.env.AWS_REGION = "ap-northeast-1"; process.env.GCP_PROJECT = "p";
  const id = await seed(provider, dst);
  await imp.handleImport({ tenantId: T, requestId: `r-e2ed-i-${id.slice(0, 8)}`, migrationId: id });
  process.env.MOCK_SEED = "1"; delete process.env.IMPORT_IR;
  return id;
}

test("가져오기 aws: S3·SQS(+DLQ)·ElastiCache 가 spec_v2 에 들어오고 값은 가짜 CLI 응답 그대로 (지어낸 값 없음)", { skip }, async () => {
  const id = await importWith("aws", "gcp");
  assert.equal((await mig(id)).status, "spec_review");
  const { spec_v2: v2 } = await specRow(id);
  assert.ok(v2, "spec_v2");
  const [bucket] = comps(v2, "objectStore"), qs = comps(v2, "queue"), [cache] = comps(v2, "cache");
  assert.equal(bucket!.id, "shop-assets");
  assert.equal(bucket!.props.versioning, true);
  assert.equal(bucket!.props.public, false);
  assert.equal(bucket!.props.sizeGb, 2);
  assert.deepEqual(qs.map((q) => q.id).sort(), ["orders", "orders-dlq"]);
  assert.equal(cache!.id, "shop-cache");
  const links = v2.spec.links.map((l: { from: string; to: unknown }) => `${l.from}->${JSON.stringify(l.to)}`);
  assert.ok(links.some((l: string) => l.startsWith("shop-api->") && l.includes("orders")), links.join());
  assert.ok(!JSON.stringify(v2.spec).includes("amazonaws.com"), "출발 주소가 명세에 남음");
  assert.ok(!JSON.stringify(v2.spec).includes("123456789012"), "계정 번호가 명세에 남음");
  // 읽기 명령만
  const log = (await import("node:fs")).readFileSync(process.env.FAKE_CLI_LOG!, "utf8");
  assert.ok(!/\b(create|delete|put|modify|remove|add|tag|purge|send)-|update-(?!kubeconfig)/.test(log), "쓰기 의심 명령");
});

test("가져오기 gcp: GCS·Pub/Sub(+DLQ)·Memorystore 가 spec_v2 에 들어온다", { skip }, async () => {
  const id = await importWith("gcp", "aws");
  assert.equal((await mig(id)).status, "spec_review");
  const { spec_v2: v2 } = await specRow(id);
  assert.ok(v2);
  assert.equal(comps(v2, "objectStore").length, 1);
  assert.ok(comps(v2, "queue").length >= 1, "Pub/Sub 큐");
  const [cache] = comps(v2, "cache");
  assert.ok(cache, "Memorystore 캐시");
  assert.equal(cache!.props.ha, true);
});

// 사람이 명세 검토에서 하는 일을 PATCH 라우트와 같은 부품(applySpecV2Patch·rebuildFromV2·saveSpecRevision)으로 흉내
//   ① 데이터 자원으로 가는 링크 intent 를 connect 로 ② 못 읽은 방화벽(ingress "unknown")을 사람이 정함 ③ 검토 표시 전부 확인
async function humanFix(id: string) {
  const adapters = await import("@svc/adapters");
  const contracts = await import("@svc/contracts");
  const cur = await specRow(id);
  const v2 = cur.spec_v2;
  const dataIds = new Set(comps(v2, "cache").concat(comps(v2, "objectStore"), comps(v2, "queue")).map((c) => c.id));
  // 발견(E2EDATA2): checkV2 는 objectStore·queue 링크에 connect 를 막고(read/write/readwrite/admin 만), 도착 Builder 는 link.connect 만 그릴 수 있다 →
  //   버킷·큐로 가는 링크는 어떤 intent 로도 계획이 통과하지 못한다. 그래서 사람이 그 링크를 빼는 것으로 흉내 (캐시 링크는 connect 로 통과)
  const plainIds = new Set([...dataIds].filter((d) => comps(v2, "cache").every((c) => c.id !== d)));
  const links = v2.spec.links.filter((l: any) => !(typeof l.to === "string" && plainIds.has(l.to)));
  // 그 데이터 자원을 가리키는 env(fromLink·template)도 사람이 뺀다 (링크 없는 참조는 checkV2 가 막음)
  const svc = v2.spec.components.find((c: any) => c.kind === "service" && Array.isArray(c.props.env))!;
  const env = svc.props.env.filter((e: any) => ![...plainIds].some((d) => JSON.stringify(e).includes(`"${d}"`) || JSON.stringify(e).includes(`${d}.`)));
  const posture = { ...v2.spec.posture, network: v2.spec.posture.network.map((n: any) =>
    n.scope === "component" && n.ingress === "unknown" ? { ...n, ingress: [{ from: "10.0.0.0/16" }], public: false } : n) };
  const confirm = Object.entries(v2.fieldMeta as Record<string, { needs_review: boolean }>).filter(([, m]) => m.needs_review).map(([k]) => k);
  const next = core.applySpecV2Patch({ spec: v2.spec, fieldMeta: v2.fieldMeta }, { changes: [{ path: "links", value: links }, { path: `components.${svc.id}.env`, value: env }, { path: "posture", value: posture }], confirm });
  const parsed = contracts.AppSpecV2.parse(next.spec);
  assert.deepEqual(contracts.checkV2(parsed).errors, []);
  const result = contracts.ImportResultV2.parse({ ...v2, spec: parsed, fieldMeta: next.fieldMeta });
  const v1 = adapters.rebuildFromV2(result, contracts.AppSpec.parse(cur.spec), { confirmed: [...next.changed, ...confirm], prevMeta: cur.field_meta });
  await core.withTenant(T, async (tx) => { await core.saveSpecRevision(tx, { tenantId: T, migrationId: id, spec: v1.spec, fieldMeta: v1.fieldMeta, specV2: result }); });
  return dataIds;
}

for (const [src, dst] of [["aws", "gcp"], ["aws", "aws"], ["gcp", "aws"], ["gcp", "gcp"]] as const) {
  test(`끝-끝 ${src}→${dst}: 점검 → 사람 수정 → 점검 통과 → 계획 → 승인 → apply(흉내) 까지 데이터 자원이 빠지지 않는다`, { skip }, async () => {
    const id = await importWith(src, dst);
    await owner.query(`UPDATE migrations SET status='prechecking' WHERE id=$1`, [id]);
    process.env.PLAN_IR = "v2";
    await pre.handlePrecheck(pjob(id));
    let m = await mig(id);
    const blocksOf = async () => ((await owner.query(`SELECT detail FROM audit_events WHERE target=$1 AND detail ? 'precheck' ORDER BY seq DESC LIMIT 1`, [id])).rows[0]?.detail?.precheck as
      Array<{ level: string; message: string }> ?? []).filter((i) => i.level === "block").map((b) => b.message);
    // ① 첫 점검: 데이터 종류 자체는 이제 그릴 수 있다 (TA12). 남은 막힘은 사람이 정할 것(링크 의도·못 읽은 방화벽)뿐이고 이유가 글로 나온다
    const first = await blocksOf();
    console.log(`E2EDATA2 ${src}->${dst}: 첫 점검 ${m.status}; ${first.join(" | ")}`);
    assert.equal(m.status, "spec_review");
    assert.ok(first.length > 0 && first.every((x) => /link\.|방화벽/.test(x)), `예상 밖 막힘: ${first.join(" | ")}`);
    // ② 사람 수정 → 새 판
    const dataIds = await humanFix(id);
    assert.ok(dataIds.size >= 3, `데이터 자원 ${[...dataIds]}`);
    // ③ 다시 점검 → 계획
    await owner.query(`UPDATE migrations SET status='prechecking' WHERE id=$1`, [id]);
    await pre.handlePrecheck(pjob(id));
    m = await mig(id);
    assert.equal(m.status, "planning", `둘째 점검 막힘: ${(await blocksOf()).join(" | ")}`);
    const planId = randomUUID();
    await plan.handlePlan({ ...pjob(id), planId });
    m = await mig(id);
    assert.equal(m.status, "awaiting_approval", `계획 ${m.status}/${m.failure_code}`);
    const p = (await core.withTenant(T, (tx) => core.loadLatestPlan(tx, id)))!;
    const kinds = new Set((p.instances ?? []).map((x) => x.kind));
    for (const k of ["objectStore", "queue", "cache"] as const) assert.ok(kinds.has(k), `계획서에서 ${k} 가 조용히 빠짐: ${[...kinds]}`);
    // ④ 승인 → apply(MOCK_IAC)
    const mg = (await owner.query(`SELECT source_env_id s, target_env_id d FROM migrations WHERE id=$1`, [id])).rows[0];
    await owner.query(`INSERT INTO plan_approvals (tenant_id, plan_id, migration_id, decision, approved_by, plan_hash) VALUES ($1,$2,$3,'approve','user:dev',$4)`, [T, planId, id, p.planHash]);
    await owner.query(`UPDATE migrations SET status='provisioning' WHERE id=$1`, [id]);
    await owner.query(`INSERT INTO env_locks (env_id, tenant_id, migration_id, holder, lease_expires_at) VALUES ($1,$3,$4,'reserved', now() + interval '2 hours'), ($2,$3,$4,'reserved', now() + interval '2 hours')`, [mg.s, mg.d, T, id]);
    const ap = await import("../src/jobs/apply.js");
    process.env.MOCK_IAC = "1";
    await ap.handleApply({ ...pjob(id), planId, planHash: p.planHash });
    m = await mig(id);
    assert.equal(m.status, "deploying", `apply ${m.status}/${m.failure_code}`);
    const infra = (await core.withTenant(T, (tx) => core.loadInfraReady(tx, id)))!;
    for (const d of dataIds) assert.ok(Object.keys(infra.tfOutputs).some((k) => k.startsWith(`link.${d}.`)), `apply 출력에 link.${d}.* 없음: ${Object.keys(infra.tfOutputs).join()}`);
    await owner.query("DELETE FROM env_locks WHERE migration_id=$1", [id]);
  });
}

test("다른 회사에선 이 판이 안 보인다", { skip }, async () => {
  const id = await importWith("aws", "gcp");
  const seen = await core.withTenant(OTHER, (tx) => tx.query("SELECT 1 FROM spec_versions WHERE migration_id=$1", [id]));
  assert.equal(seen.rowCount, 0);
  void pre;
});
