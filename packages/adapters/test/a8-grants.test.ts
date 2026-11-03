// A8: 출발 IAM 권한(I4 grants·posture.permissions) → 도착 Builder. 순수·결정적. 도착별 정상 1 + 못 옮기는 동작 거부 1 + 깃발 on 끝까지
import { test } from "node:test";
import assert from "node:assert/strict";
import { AppSpec, AppSpecV2, checkV2, ComponentV2, ImportResultV2, type RawInventory, type TargetEnv } from "@svc/contracts";
import {
  targetBuilderFor, v2PrecheckItems, AdapterError, UNSUPPORTED_V2, normalizeV2, type Target,
} from "../src/index.js";
import { awsGrantPlan, gcpGrantPlan, grantBlockers } from "../src/target/grants.js";

const T = (p: TargetEnv["provider"], extra: Partial<Target> = {}): Target =>
  ({ envId: "33333333-3333-4333-8333-333333333333", provider: p, region: "default", tenantId: "11111111-1111-4111-8111-111111111111", migrationId: "22222222-2222-4222-8222-222222222222", ...extra }) as Target;
const D = (c: string) => `sha256:${c.repeat(64)}`;

// v1 데모 (DB·시크릿 있는 API 층)
const V1: AppSpec = AppSpec.parse({
  schemaVersion: "1", app: { name: "shop" },
  service: { image: `registry/shop-api@${D("a")}`, port: 8080, healthPath: "/healthz", replicas: 2, cpu: "500m", memory: "1Gi",
    env: [{ name: "LOG_LEVEL", value: "info" }], secretRefs: [{ name: "DATABASE_PASSWORD", key: "password" }] },
  database: { engine: "postgres", majorVersion: "16", storageGb: 20 },
  ingress: { hostname: "shop.example.com", entry: "cloudflare-lb" },
});

// 3티어 v2: web → api → db, + 예약 잡 (api 와 같은 SA)
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

const tf = (p: "aws" | "gcp" | "onprem" | "azure_mock", s: AppSpecV2) => targetBuilderFor(p).toTerraformV2(s, T(p));
const identityRows = (p: "aws" | "gcp", s: AppSpecV2) => JSON.parse(String(tf(p, s).vars.identity_json)) as Array<Record<string, string>>;
const blocks = (p: "aws" | "gcp" | "onprem" | "azure_mock", s: AppSpecV2) =>
  v2PrecheckItems(p, { spec: {}, specV2: s, hadV2Before: false }).filter((i) => i.level === "block");
const warns = (p: "aws" | "gcp" | "onprem" | "azure_mock", s: AppSpecV2) =>
  v2PrecheckItems(p, { spec: {}, specV2: s, hadV2Before: false }).filter((i) => i.id.startsWith("PC-V2-GRANTS"));
const throwsUnsup = (f: () => unknown, msg?: RegExp) => assert.throws(f, (e: unknown) => e instanceof AdapterError && e.code === UNSUPPORTED_V2 && (!msg || msg.test(e.message)));

// DB 관리 권한 + 계정 단위 보기 + Deny * (I4 가 RDS 출발에서 만드는 모양)
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

test("aws 정상: grants·기준선 → 앱 신원 grants_json (자원 = IR id, 출발 계정·ARN 없음), precheck block 0 + 경계 경고", () => {
  const s = withIam();
  assert.deepEqual(blocks("aws", s), []);
  const rows = identityRows("aws", s);
  const api = rows.find((r) => r.id === "api")!;
  assert.deepEqual(JSON.parse(api.grants_json!), [
    { effect: "Allow", actions: ["rds:DescribeDBInstances"], star: true, targets: [] },
    { effect: "Allow", actions: ["rds:RebootDBInstance"], star: false, targets: [{ kind: "postgres", id: "db", paths: [""] }] },
    { effect: "Deny", actions: ["rds:DeleteDBInstance"], star: true, targets: [] },
  ]);
  assert.equal(rows.find((r) => r.id === "web")!.grants_json, undefined, "권한 없는 신원엔 칸 자체가 없음");
  assert.doesNotMatch(String(tf("aws", s).vars.identity_json), /999999999999|arn:aws:rds/, "출발 계정·ARN 이 도착 변수에 섞임");
  assert.ok(warns("aws", s).some((w) => /권한 경계/.test(w.message)));
  targetBuilderFor("aws").toWorkloadValues(s, {}, T("aws"));   // 값 만들기도 안 던짐
});

test("aws 거부: 대상 서비스가 아닌 동작·조건·NotAction·IR 밖 Allow → precheck block 과 Builder UNSUPPORTED_V2 가 같은 이유", () => {
  const cases: Array<[string, (s: AppSpecV2) => void, RegExp]> = [
    ["다른 서비스 동작", (s) => { s.links[1] = { ...s.links[1]!, grants: [{ effect: "Allow", actions: ["s3:GetObject"], resources: ["*"] }] }; }, /대상 서비스가 아닌 동작 s3:GetObject/],
    ["조건", (s) => { s.links[1] = { ...s.links[1]!, grants: [{ effect: "Allow", actions: ["rds:RebootDBInstance"], resources: [DB_ARN], conditions: { Bool: { "aws:SecureTransport": "true" } } }] }; }, /조건 붙은 권한/],
    ["NotAction", (s) => { s.posture.permissions.push({ subject: "api", source: "iam:r", effect: "Allow", actions: [], notActions: ["iam:*"], resources: ["*"], mode: "mirror" }); }, /NotAction/],
    ["IR 밖 Allow", (s) => { s.posture.permissions.push({ subject: "api", source: "iam:r", effect: "Allow", actions: ["dynamodb:GetItem"], resources: ["arn:aws:dynamodb:r:999999999999:table/t"], mode: "mirror" }); }, /IR 밖 자원/],
  ];
  for (const [name, mut, re] of cases) {
    const s = withIam(); mut(s);
    const b = blocks("aws", s).filter((x) => x.id.startsWith("PC-V2-UNSUP"));
    assert.equal(b.length, 1, name);
    assert.match(b[0]!.message, re, name);
    throwsUnsup(() => tf("aws", s), re);
    throwsUnsup(() => targetBuilderFor("aws").toWorkloadValues(s, {}, T("aws")), re);
  }
  // IR 밖 자원에 대한 Deny 는 빼도 넓어지지 않음 → 막지 않고 경고
  const d = withIam(); d.posture.permissions.push({ subject: "api", source: "iam:r", effect: "Deny", actions: ["s3:*"], resources: ["arn:aws:s3:::other"], mode: "mirror" });
  assert.deepEqual(blocks("aws", d), []);
  assert.ok(warns("aws", d).some((w) => /IR 밖 자원에 대한 Deny/.test(w.message)));
});

// S3·SQS 대상은 Builder capability(TA12)와 별개로 권한 계획만 본다
const DATA = (): AppSpecV2 => {
  const s = TIER3();
  s.components.push(ComponentV2.parse({ id: "uploads", kind: "objectStore", props: { versioning: true, public: false, sizeGb: 1 } }),
    ComponentV2.parse({ id: "orders", kind: "queue", props: { model: "queue" } }));
  s.links.push({ from: "api", to: "uploads", intent: "readwrite", grants: [{ effect: "Allow", actions: ["s3:GetObject", "s3:PutObject"], resources: ["arn:aws:s3:::src-uploads/*"] }] },
    { from: "nightly", to: "orders", intent: "readwrite", grants: [{ effect: "Allow", actions: ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:SendMessage"], resources: ["*"] }] });
  return AppSpecV2.parse(s);
};

test("aws 권한 계획: 버킷 경로(/*) 유지, Resource \"*\" 는 그 대상 하나로 좁힘(경고), 같은 SA 잡은 api 신원에 붙음", () => {
  const p = awsGrantPlan(DATA());
  assert.deepEqual(p.unsupported, []);
  assert.deepEqual(p.byIdentity.api, [
    { effect: "Allow", actions: ["s3:GetObject", "s3:PutObject"], star: false, targets: [{ kind: "objectStore", id: "uploads", paths: ["/*"] }] },
    { effect: "Allow", actions: ["sqs:DeleteMessage", "sqs:ReceiveMessage", "sqs:SendMessage"], star: false, targets: [{ kind: "queue", id: "orders", paths: [""] }] },
  ].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
  assert.ok(p.warnings.some((w) => /nightly→orders: Resource "\*"/.test(w)));
});

test("gcp 정상: S3 Get+Put → 버킷 objectUser 하나, SQS 보내기·받기 → 토픽 publisher + 구독 subscriber (자원 단위)", () => {
  const p = gcpGrantPlan(DATA());
  assert.deepEqual(p.unsupported, []);
  assert.deepEqual(p.byIdentity.api, [
    { kind: "objectStore", target: "uploads", role: "roles/storage.objectUser", scope: "bucket" },
    { kind: "queue", target: "orders", role: "roles/pubsub.subscriber", scope: "subscription" },
    { kind: "queue", target: "orders", role: "roles/pubsub.publisher", scope: "topic" },
  ]);
  // 보기만이면 objectViewer
  const ro = DATA(); ro.links = ro.links.map((l) => l.to === "uploads" ? { ...l, grants: [{ effect: "Allow" as const, actions: ["s3:GetObject", "s3:ListBucket"], resources: ["*"] }] } : l);
  assert.equal(gcpGrantPlan(AppSpecV2.parse(ro)).byIdentity.api!.find((b) => b.kind === "objectStore")!.role, "roles/storage.objectViewer");
});

test("gcp 거부: 대응 역할 없는 동작(RDS 재부팅)·계정 단위 권한·Deny 와 겹치는 역할은 block + Builder UNSUPPORTED_V2 (TODO(human))", () => {
  const s = withIam();
  const msgs = blocks("gcp", s).map((b) => b.message);
  assert.ok(msgs.some((m) => /GCP 대응 역할 없음 rds:RebootDBInstance/.test(m)), msgs.join("\n"));
  assert.ok(msgs.some((m) => /계정 단위 권한/.test(m)));
  throwsUnsup(() => tf("gcp", s), /GCP 대응 역할 없음/);
  const deny = DATA(); deny.posture.permissions.push({ subject: "api", source: "iam:r", effect: "Deny", actions: ["s3:DeleteObject"], resources: ["*"], mode: "mirror" });
  assert.match(gcpGrantPlan(AppSpecV2.parse(deny)).unsupported.join(";"), /Deny s3:DeleteObject 가 줄 역할 roles\/storage.objectUser\(uploads\) 과 겹침/);
  // 보기 역할만 주면 쓰기 Deny 는 저절로 지켜짐 → 막지 않음
  const ok = DATA(); ok.links = ok.links.filter((l) => l.to !== "orders").map((l) => l.to === "uploads" ? { ...l, grants: [{ effect: "Allow" as const, actions: ["s3:GetObject"], resources: ["*"] }] } : l);
  ok.posture.permissions.push({ subject: "api", source: "iam:r", effect: "Deny", actions: ["s3:DeleteObject"], resources: ["*"], mode: "mirror" });
  assert.deepEqual(gcpGrantPlan(AppSpecV2.parse(ok)).unsupported, []);
});

test("gcp 정상(Builder): 대응되는 권한만 있으면 신원 행에 바인딩 grants_json, 권한 없으면 칸 없음", () => {
  const s = TIER3();
  s.posture.permissions = [{ subject: "api", source: "iam:r", effect: "Deny", actions: ["rds:DeleteDBInstance"], resources: ["*"], mode: "mirror" }];
  const v = AppSpecV2.parse(s);
  assert.deepEqual(blocks("gcp", v), []);
  assert.ok(identityRows("gcp", v).every((r) => r.grants_json === undefined), "Deny 만이면 줄 역할 없음");
  assert.ok(warns("gcp", v).some((w) => /GCP 는 역할을 안 줘서 지킴/.test(w.message)));
});

test("onprem STUB·azure_mock 가짜: 권한이 있어도 막지 않고 변수는 권한 없는 판과 같음, precheck 는 검토 경고", () => {
  for (const p of ["onprem", "azure_mock"] as const) {
    const base = p === "azure_mock" ? (() => { const s = TIER3(); s.components = s.components.filter((c) => c.id !== "web" && c.id !== "nightly"); s.links = s.links.filter((l) => l.from === "api"); s.entry = { ...s.entry!, hosts: [{ ...s.entry!.hosts[0]!, routes: [s.entry!.hosts[0]!.routes[0]!] }] }; return AppSpecV2.parse(s); })() : TIER3();
    const withP = structuredClone(base); withP.posture.permissions = withIam().posture.permissions;
    withP.links = withP.links.map((l) => l.from === "api" && l.to === "db" ? { ...l, grants: withIam().links[1]!.grants } : l);
    const s = AppSpecV2.parse(withP);
    assert.deepEqual(blocks(p, s), [], p);
    assert.deepEqual(tf(p, s).vars, tf(p, base).vars, p);
    assert.equal(warns(p, s).length, 1, p);
    assert.deepEqual(warns(p, base), [], `${p}: 권한 없으면 경고도 없음`);
  }
});

test("결정적: 의존성·기준선 순서를 뒤집어도 grants_json 이 같다, 권한 없는 명세는 A8 전과 같은 변수(칸 없음)", () => {
  const a = withIam(), b = withIam();
  b.links.reverse(); b.posture.permissions.reverse();
  for (const p of ["aws", "gcp"] as const) assert.deepEqual(awsGrantPlan(a), awsGrantPlan(AppSpecV2.parse(b)), p);
  assert.deepEqual(gcpGrantPlan(DATA()), gcpGrantPlan(AppSpecV2.parse({ ...DATA(), links: [...DATA().links].reverse() })));
  for (const p of ["aws", "gcp"] as const) assert.ok(identityRows(p, TIER3()).every((r) => !("grants_json" in r)), p);
  assert.deepEqual(grantBlockers("onprem", withIam()), []);
});

// 깃발 on 끝까지 (순수): I4 IAM 근거가 든 원본 → normalizeV2 → 검사 → precheck → 도착 Terraform
const DG = "sha256:" + "ef".repeat(32);
const dep = (name: string, env: Record<string, string>[] = []) => ({
  kind: "k8s.deployment", imageDigest: DG, metadata: { name, namespace: "shop", labels: { app: name } },
  spec: { replicas: 1, selector: { matchLabels: { app: name } }, template: { metadata: { labels: { app: name } }, spec: { serviceAccountName: name, containers: [{
    name, image: `ghcr.io/demo/${name}:1.0`, ports: [{ containerPort: 8080 }], env }] } } },
});
const rds = { kind: "rds.dbInstance", DBInstanceIdentifier: "shop-db", Engine: "postgres", EngineVersion: "16.3", AllocatedStorage: 20,
  Endpoint: "shop-db.abc.ap-northeast-2.rds.amazonaws.com", DBInstanceArn: DB_ARN };
const inv = (statements: unknown[]): RawInventory => ({ provider: "aws", coverage: {}, items: [dep("shop-api", [{ name: "DB_HOST", value: rds.Endpoint }]), rds,
  { kind: "aws.iamPolicy", roleName: "shop-api-role", serviceAccount: "shop-api", namespace: "shop", statements }] as RawInventory["items"] });

test("깃발 on 끝까지: IAM 근거 원본 → 명세 → aws 도착 precheck block 0·Terraform 변수에 grants, gcp 는 대응 없는 동작으로 block", () => {
  const { result } = normalizeV2(inv([
    { Effect: "Allow", Action: ["rds:RebootDBInstance"], Resource: [DB_ARN] },
    { Effect: "Allow", Action: "rds:DescribeDBInstances", Resource: "*" },
    { Effect: "Deny", Action: "rds:DeleteDBInstance", Resource: "*" },
  ]));
  assert.equal(ImportResultV2.safeParse(result).success, true);
  assert.deepEqual(checkV2(result.spec).errors, []);
  const s = result.spec;
  assert.ok(s.links.some((l) => l.grants?.length) && s.posture.permissions.length === 2);
  // 출발 방화벽 못 읽음(PC-V2-HUMAN, 가져오기 쪽 검토 칸)은 권한과 무관 → 렌더 미지원(UNSUP)이 없어야 함
  assert.deepEqual(blocks("aws", s).filter((b) => b.id.startsWith("PC-V2-UNSUP")).map((b) => b.message), []);
  const row = identityRows("aws", s).find((r) => r.grants_json)!;
  assert.equal(JSON.parse(row.grants_json!).length, 3);
  assert.doesNotMatch(row.grants_json!, /999999999999/);
  assert.ok(blocks("gcp", s).some((b) => /rds:RebootDBInstance/.test(b.message)));
  assert.deepEqual(blocks("onprem", s).filter((b) => b.id.startsWith("PC-V2-UNSUP")).map((b) => b.message).filter((m) => /권한/.test(m)), []);
});
