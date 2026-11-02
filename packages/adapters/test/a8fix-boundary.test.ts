// A8fix: 옮긴 권한이 실제로 먹게 — AWS 앱 역할 경계에 app- 버킷·큐 데이터 동작만, GCP 실행 역할엔 자원 단위 setIamPolicy(조건부) 만
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AppSpec, AppSpecV2, ComponentV2, type TargetEnv } from "@svc/contracts";
import { aws, gcp, targetBuilderFor, v2PrecheckItems, type Target } from "../src/index.js";
import { awsGrantPlan, grantWarnings, insideBoundary, gcpGrantTypes } from "../src/target/grants.js";

const T = (p: TargetEnv["provider"], extra: Partial<Target> = {}): Target =>
  ({ envId: "33333333-3333-4333-8333-333333333333", provider: p, region: "default", tenantId: "11111111-1111-4111-8111-111111111111", migrationId: "22222222-2222-4222-8222-222222222222", ...extra }) as Target;
const D = (c: string) => `sha256:${c.repeat(64)}`;
const V1: AppSpec = AppSpec.parse({
  schemaVersion: "1", app: { name: "shop" },
  service: { image: `registry/shop-api@${D("a")}`, port: 8080, healthPath: "/healthz", replicas: 2, cpu: "500m", memory: "1Gi",
    env: [{ name: "LOG_LEVEL", value: "info" }], secretRefs: [{ name: "DATABASE_PASSWORD", key: "password" }] },
  database: { engine: "postgres", majorVersion: "16", storageGb: 20 },
  ingress: { hostname: "shop.example.com", entry: "cloudflare-lb" },
});
const svc = (id: string, extra: Record<string, unknown> = {}) => ({
  id, kind: "service",
  props: {
    runtime: "k8s", origin: { runtime: "k8s", product: "eks" }, namespace: "shop",
    image: { source: "registry", repository: `ghcr.io/demo/${id}`, digest: D(id === "web" ? "b" : "c") },
    resources: { request: { cpuMilli: 250, memMiB: 512 } }, env: [], serviceAccount: id, replicas: { min: 2, max: 2 },
    ports: [{ port: 8080, protocol: "TCP" }],
    endpoints: [{ name: id, type: "ClusterIP", ports: [{ port: 80, targetPort: 8080, protocol: "TCP" }] }],
    ...extra,
  },
});
const TIER3 = (): AppSpecV2 => AppSpecV2.parse({
  schemaVersion: "2", app: { name: "shop" },
  components: [
    svc("web", { env: [{ name: "API_URL", fromLink: { to: "api", output: "url" } }],
      probes: { readiness: { type: "http", path: "/", port: 8080 } } }),
    svc("api", {
      env: [
        { name: "DB_HOST", fromLink: { to: "db", output: "host" } },
        { name: "JDBC", template: "jdbc:postgresql://${db.host}:5432/shop?sslmode=require" },
        { name: "DATABASE_PASSWORD", fromSecret: { secret: "shop-db", key: "password" } },
        { name: "LOG_LEVEL", value: "info" },
      ],
      scale: { targetCpuPct: 70 }, replicas: { min: 2, max: 4 },
    }),
    { id: "nightly", kind: "job", props: {
      image: { source: "registry", repository: "ghcr.io/demo/api", digest: D("c") }, resources: {}, env: [], serviceAccount: "api",
      schedule: "0 3 * * *", concurrencyPolicy: "Forbid" } },
    { id: "db", kind: "postgres", props: { majorVersion: "16", storageGb: 50, compute: { cpuMilli: 2000, memMiB: 4096 }, parameters: { max_connections: "200" } } },
  ],
  links: [
    { from: "web", to: "api", intent: "call" },
    { from: "api", to: "db", intent: "connect" },
    { from: "nightly", to: "db", intent: "connect" },
  ],
  entry: { via: "cloudflare-lb", hosts: [{ hostnames: ["shop.example.com"], tls: { mode: "terminate" },
    routes: [{ matches: [{ path: { type: "PathPrefix", value: "/api" } }], backends: [{ to: "api", port: 80, weight: 1 }] },
      { matches: [{ path: { type: "PathPrefix", value: "/" } }], backends: [{ to: "web", port: 80, weight: 1 }] }] }] },
  posture: { permissions: [], network: [{ scope: "namespace", namespace: "shop", mode: "mirror", policies: [], default: "allow-all" }] },
});
const DB_ARN = "arn:aws:rds:ap-northeast-2:999999999999:db:shop-db";
const withIam = (): AppSpecV2 => {
  const s = TIER3();
  s.links = s.links.map((l) => l.from === "api" && l.to === "db" ? { ...l, grants: [{ effect: "Allow" as const, actions: ["rds:RebootDBInstance"], resources: [DB_ARN] }] } : l);
  s.posture.permissions = [
    { subject: "api", source: "iam:api-role", effect: "Allow", actions: ["rds:DescribeDBInstances"], resources: ["*"], mode: "mirror" },
    { subject: "api", source: "iam:api-role", effect: "Deny", actions: ["rds:DeleteDBInstance"], resources: ["*"], mode: "mirror", note: "Deny" },
  ];
  return AppSpecV2.parse(s);
};
const DATA = (): AppSpecV2 => {
  const s = TIER3();
  s.components.push(ComponentV2.parse({ id: "uploads", kind: "objectStore", props: { versioning: true, public: false, sizeGb: 1 } }),
    ComponentV2.parse({ id: "orders", kind: "queue", props: { model: "queue" } }));
  s.links.push({ from: "api", to: "uploads", intent: "readwrite", grants: [{ effect: "Allow", actions: ["s3:GetObject", "s3:PutObject"], resources: ["arn:aws:s3:::src-uploads/*"] }] },
    { from: "nightly", to: "orders", intent: "readwrite", grants: [{ effect: "Allow", actions: ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:SendMessage"], resources: ["*"] }] });
  return AppSpecV2.parse(s);
};

const root = join(import.meta.dirname, "../../..");
const boundaryWarn = (s: AppSpecV2) => grantWarnings("aws", s).filter((w) => /권한 경계/.test(w));

test("경계: MigratedDataGrants = app- 버킷·큐 데이터 동작만 (관리 동작·RDS·ElastiCache·Resource \"*\" 없음), 파일·온보딩 템플릿과 같음", () => {
  const b = aws.appRoleBoundary("ap-northeast-2");
  const st = b.Statement.find((x) => x.Sid === "MigratedDataGrants")!;
  assert.ok(st.Resource.every((r) => /^arn:aws:(s3|sqs):[^:]*:[^:]*:?app-\*/.test(r)), JSON.stringify(st.Resource));
  assert.ok(!st.Resource.includes("*"));
  assert.ok(st.Action.every((a) => /^(s3|sqs):/.test(a) && !a.includes("*")));
  for (const bad of ["s3:PutBucketPolicy", "s3:DeleteBucket", "sqs:DeleteQueue", "sqs:SetQueueAttributes", "rds:RebootDBInstance"]) assert.ok(!st.Action.includes(bad as never), bad);
  assert.deepEqual(JSON.parse(readFileSync(join(root, "infra/permissions/aws-app-role-boundary.json"), "utf8")), b);
  const tpl = JSON.parse(readFileSync(join(root, "infra/onboarding/aws-connect.json"), "utf8"));
  assert.deepEqual(tpl.Resources.BoundaryPolicy.Properties.PolicyDocument, b);
});

test("insideBoundary: app- 버킷·큐 데이터 동작 = 안, 와일드카드·RDS·star Allow = 밖, Deny = 늘 안", () => {
  const t = (kind: "objectStore" | "queue" | "postgres", id = "x") => [{ kind, id, paths: [""] }];
  assert.equal(insideBoundary({ effect: "Allow", actions: ["s3:GetObject", "s3:PutObject"], star: false, targets: t("objectStore") }), true);
  assert.equal(insideBoundary({ effect: "Allow", actions: ["sqs:SendMessage"], star: false, targets: t("queue") }), true);
  assert.equal(insideBoundary({ effect: "Allow", actions: ["s3:*"], star: false, targets: t("objectStore") }), false);
  assert.equal(insideBoundary({ effect: "Allow", actions: ["sqs:SendMessage"], star: false, targets: t("objectStore") }), false, "서비스가 대상과 다르면 밖");
  assert.equal(insideBoundary({ effect: "Allow", actions: ["rds:RebootDBInstance"], star: false, targets: t("postgres") }), false);
  assert.equal(insideBoundary({ effect: "Allow", actions: ["s3:ListAllMyBuckets"], star: true, targets: [] }), false);
  assert.equal(insideBoundary({ effect: "Deny", actions: ["s3:*"], star: true, targets: [] }), true);
});

test("정상: 버킷·큐 데이터 권한만이면 경계 경고 없음 (precheck PC-V2-GRANTS 에 경계 줄 없음)", () => {
  const s = DATA();
  assert.ok(Object.values(awsGrantPlan(s).byIdentity).flat().every(insideBoundary));
  assert.deepEqual(boundaryWarn(s), []);
  const items = v2PrecheckItems("aws", { spec: {}, specV2: s, hadV2Before: false });
  assert.ok(!items.some((i) => i.id.startsWith("PC-V2-GRANTS") && /권한 경계/.test(i.message)));
});

test("거부(경고 유지): RDS 관리·계정 단위 Allow 는 경계 밖 → 그 문장만 이름 붙여 경고, Deny 는 경고 안 함", () => {
  const w = boundaryWarn(withIam());
  assert.equal(w.length, 1);
  assert.match(w[0]!, /rds:RebootDBInstance → db/);
  assert.match(w[0]!, /rds:DescribeDBInstances → \*/);
  assert.doesNotMatch(w[0]!, /DeleteDBInstance/);
  const wild = DATA(); wild.links = wild.links.map((l) => l.to === "uploads" ? { ...l, grants: [{ effect: "Allow" as const, actions: ["s3:*"], resources: ["*"] }] } : l);
  assert.match(boundaryWarn(AppSpecV2.parse(wild))[0]!, /s3:\* → uploads/);
});

test("GCP: 옮긴 권한이 있으면 실행 권한에 그 자원 단위 setIamPolicy, 프로젝트 setIamPolicy 는 없음, 권한 없으면 지금과 같음", () => {
  const s = DATA();
  assert.deepEqual(gcpGrantTypes(s), ["google_pubsub_subscription_iam_member", "google_pubsub_topic_iam_member", "google_storage_bucket_iam_member"]);
  const acts = targetBuilderFor("gcp").operateActionsV2(s, "apply");
  for (const p of ["storage.buckets.setIamPolicy", "pubsub.topics.setIamPolicy", "pubsub.subscriptions.setIamPolicy"]) assert.ok(acts.includes(p), p);
  assert.ok(!acts.some((a) => a.startsWith("resourcemanager.projects.setIamPolicy")));
  const none = TIER3();
  assert.ok(!targetBuilderFor("gcp").operateActionsV2(none, "apply").some((a) => /^(storage\.buckets|pubsub\.(topics|subscriptions))\.setIamPolicy$/.test(a)));
  // 막힌(대응 없는) 명세는 바인딩 종류도 안 냄 (계획 단계 전에 precheck 가 막음)
  assert.deepEqual(gcpGrantTypes(withIam()), []);
  assert.match(gcp.IAM_CONDITION, /storage\.googleapis\.com\/Bucket/);
});
