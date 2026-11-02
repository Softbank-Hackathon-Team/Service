import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { AppSpec, AppSpecV2, ImportResultV2, ApprovalRowV2, checkV2, upconvertV1, LINK_OUTPUTS } from "../src/index.js";

const D = (c: string) => "sha256:" + c.repeat(64);

// 손으로 쓴 3티어 v2 명세 (웹 · API · DB + 캐시 · 버킷 · 정리 작업)
const good = (): AppSpecV2 => ({
  schemaVersion: "2",
  app: { name: "shop" },
  components: [
    { id: "shop-api", kind: "service", props: {
      runtime: "k8s", origin: { runtime: "k8s", product: "eks" }, namespace: "shop",
      image: { source: "registry", repository: "ghcr.io/demo/shop-api", digest: D("a") },
      resources: { request: { cpuMilli: 300, memMiB: 768 } },
      ports: [{ port: 8080, protocol: "TCP" }],
      probes: { readiness: { type: "http", path: "/healthz", port: 8080 } },
      serviceAccount: "shop-api",
      endpoints: [{ name: "shop-api", type: "ClusterIP", ports: [{ name: "http", port: 80, targetPort: 8080, protocol: "TCP" }] }],
      replicas: { min: 2, max: 6 }, scale: { targetCpuPct: 70 },
      env: [
        { name: "DB_HOST", fromLink: { to: "shop-db", output: "host" } },
        { name: "REDIS_URL", template: "rediss://${shop-cache.host}:6379" },
        { name: "UPLOAD_BUCKET", fromLink: { to: "shop-uploads", output: "name" } },
        { name: "DATABASE_PASSWORD", fromSecret: { secret: "shop-db", key: "password" } },
        { name: "APP_VERSION", value: "10.4.1" },
      ] } },
    { id: "shop-cache", kind: "cache", props: { engine: "redis", version: "7.1", memoryMiB: null, tls: true, auth: true } },
    { id: "shop-cleanup", kind: "job", props: {
      image: { source: "registry", repository: "ghcr.io/demo/shop-api", digest: D("a") },
      resources: {}, env: [{ name: "DB_HOST", fromLink: { to: "shop-db", output: "host" } }],
      serviceAccount: "default", schedule: "0 3 * * *" } },
    { id: "shop-db", kind: "postgres", props: { majorVersion: "16", storageGb: 20, ha: false } },
    { id: "shop-uploads", kind: "objectStore", props: { versioning: true, public: false, sizeGb: null } },
    { id: "shop-web", kind: "service", props: {
      runtime: "k8s", origin: { runtime: "k8s", product: "eks" }, namespace: "shop",
      image: { source: "registry", repository: "ghcr.io/demo/shop-web", digest: D("b") },
      resources: {}, ports: [{ port: 3000 }], serviceAccount: "default",
      replicas: { min: 2, max: 2 },
      env: [{ name: "API_URL", template: "http://${shop-api.host}" }] } },
  ],
  links: [
    { from: "shop-api", to: "shop-cache", intent: "connect" },
    { from: "shop-api", to: "shop-db", intent: "connect" },
    { from: "shop-api", to: "shop-uploads", intent: "readwrite",
      grants: [{ effect: "Allow", actions: ["s3:GetObject", "s3:PutObject"], resources: ["arn:aws:s3:::shop-uploads/*"] }] },
    { from: "shop-cleanup", to: "shop-db", intent: "connect" },
    { from: "shop-web", to: "shop-api", intent: "call" },
  ],
  entry: { via: "cloudflare-lb", hosts: [{ hostnames: ["shop.example.com"], tls: { mode: "terminate", source: "ingress.spec.tls" },
    routes: [
      { matches: [{ path: { type: "PathPrefix", value: "/api" } }], backends: [{ to: "shop-api", port: 80, weight: 1 }] },
      { matches: [{ path: { type: "PathPrefix", value: "/" } }], backends: [{ to: "shop-web", port: 3000, weight: 1 }] },
    ] }] },
  posture: {
    permissions: [{ subject: "shop-api", source: "iam:shop-api-role", effect: "Allow", actions: ["s3:ListAllMyBuckets"], resources: ["*"], mode: "mirror" }],
    network: [
      { scope: "namespace", namespace: "shop", mode: "mirror", policies: [], default: "allow-all" },
      { scope: "component", subject: "shop-db", mode: "mirror", ingress: "unknown", public: null },
    ],
  },
});

// 시험이 일부러 망가뜨리는 곳 (타입 밖 값도 넣으려고 느슨하게)
type Loose = { components: { id: string; kind: string; props: Record<string, any> }[]; links: Record<string, any>[]; entry?: any };
const loose = (s: AppSpecV2) => s as unknown as Loose;
const comp = (s: AppSpecV2, id: string) => loose(s).components.find((c) => c.id === id)!;

test("IR v2: 손으로 쓴 3티어 명세는 Zod 통과 + checkV2 오류·검토·승인 0", () => {
  const s = good();
  const p = AppSpecV2.safeParse(s);
  assert.equal(p.success, true, p.success ? "" : JSON.stringify(p.error.issues));
  assert.deepEqual(checkV2(s), { errors: [], reviews: [], approvals: [] });
});

test("IR v2: Zod 는 모양만 본다 — 모르는 필드·id 모양은 거부", () => {
  const s = good();
  assert.equal(AppSpecV2.safeParse({ ...s, extra: 1 }).success, false);
  comp(s, "shop-db").id = "1-db";
  assert.equal(AppSpecV2.safeParse(s).success, false);
});

test("checkV2 거부: 끊어진 의존성 (대상 없음)", () => {
  const s = good();
  loose(s).links.push({ from: "shop-api", to: "nope", intent: "call" });
  const r = checkV2(s);
  assert.ok(r.errors.some((e) => e.includes("의존성 대상 없음: nope")), r.errors.join("\n"));
});

test("checkV2 거부: 중복 id", () => {
  const s = good();
  loose(s).components.push({ id: "shop-db", kind: "cache", props: { engine: "redis", memoryMiB: null, tls: null, auth: null } });
  assert.ok(checkV2(s).errors.some((e) => e.includes("id 중복: shop-db")));
});

test("checkV2 거부: source=registry 인데 digest 없음", () => {
  const s = good();
  comp(s, "shop-web").props.image = { source: "registry", repository: "ghcr.io/demo/shop-web", digest: null };
  assert.ok(checkV2(s).errors.some((e) => e.includes("shop-web.image digest 아님")));
  comp(s, "shop-web").props.image.digest = "latest";
  assert.ok(checkV2(s).errors.some((e) => e.includes("shop-web.image digest 아님")));
});

test("checkV2 거부: 의도가 대상과 안 맞음 (버킷에 connect, DB 에 read)", () => {
  const s = good();
  loose(s).links[2]!.intent = "connect";   // shop-api → shop-uploads
  loose(s).links[1]!.intent = "read";      // shop-api → shop-db
  const errs = checkV2(s).errors;
  assert.ok(errs.some((e) => e.includes("의도가 대상과 안 맞음: shop-api->shop-uploads connect")));
  assert.ok(errs.some((e) => e.includes("의도가 대상과 안 맞음: shop-api->shop-db read")));
});

test("checkV2 거부: 라우팅이 DB 를 가리킴", () => {
  const s = good();
  loose(s).entry.hosts[0].routes[0].backends[0].to = "shop-db";
  assert.ok(checkV2(s).errors.some((e) => e.includes("라우팅 대상이 service 아님: shop-db")));
});

test("checkV2 거부: env 출력 이름이 LINK_OUTPUTS 에 없음 (postgres 에 name)", () => {
  assert.equal((LINK_OUTPUTS.postgres as readonly string[]).includes("name"), false);
  const s = good();
  comp(s, "shop-api").props.env[0] = { name: "DB_HOST", fromLink: { to: "shop-db", output: "name" } };
  assert.ok(checkV2(s).errors.some((e) => e.includes("출력 name 가 postgres 에 없음")));
  // template 쪽도 같은 규칙
  const t = good();
  comp(t, "shop-api").props.env[1] = { name: "REDIS_URL", template: "rediss://${shop-cache.user}:6379" };
  assert.ok(checkV2(t).errors.some((e) => e.includes("출력 user 가 cache 에 없음")));
});

test("checkV2 거부: env 참조에 맞는 의존성 없음", () => {
  const s = good();
  loose(s).links = loose(s).links.filter((l) => !(l.from === "shop-cleanup"));
  assert.ok(checkV2(s).errors.some((e) => e.includes("shop-cleanup.env.DB_HOST 참조 shop-db 에 맞는 의존성 없음")));
});

test("checkV2 거부: 기타 구조 (replicas min>max, deadLetter, 기준선 대상, 출발이 DB, NaN)", () => {
  const s = good();
  comp(s, "shop-web").props.replicas = { min: 6, max: 2 };
  loose(s).components.push({ id: "jobs-q", kind: "queue", props: { model: "queue", deadLetter: { to: "shop-uploads" } } });
  s.posture.permissions.push({ subject: "ghost", source: "iam:x", effect: "Deny", actions: ["*"], resources: ["*"], mode: "mirror" });
  loose(s).links.push({ from: "shop-db", to: "shop-uploads", intent: "read" });
  comp(s, "shop-db").props.storageGb = Number.NaN;
  const errs = checkV2(s).errors;
  for (const want of ["shop-web.replicas min > max", "jobs-q.deadLetter.to 가 queue 아님", "보안 기준선 대상 없음: ghost",
    "의존성 출발이 service·job 아님: shop-db", "shop-db.storageGb 숫자 아님"])
    assert.ok(errs.some((e) => e.includes(want)), `${want} 없음:\n${errs.join("\n")}`);
});

test("checkV2 reviews: env 에 벤더 주소 → errors 0, reviews 1 / legacy:true → reviews 0", () => {
  const s = good();
  comp(s, "shop-api").props.env.push({ name: "LEGACY_DB", value: "x.rds.amazonaws.com" });
  const r = checkV2(s);
  assert.deepEqual(r.errors, []);
  assert.equal(r.reviews.length, 1);
  assert.match(r.reviews[0]!, /shop-api\.env\.LEGACY_DB 에 벤더 주소/);
  assert.deepEqual(checkV2(s, { legacy: true }).reviews, []);
});

test("checkV2 reviews: 사설 IP 는 네 칸일 때만, external 의존성 호스트는 예외", () => {
  const s = good();
  comp(s, "shop-api").props.args = ["--db=10.0.3.7"];
  comp(s, "shop-api").props.env.push({ name: "SES", value: "email.ap-northeast-1.amazonaws.com" });
  loose(s).links.push({ from: "shop-api", to: { external: "email.ap-northeast-1.amazonaws.com" }, intent: "call" });
  const r = checkV2(s);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.reviews, ["shop-api.args[0] 에 출발 사설 IP 가 값으로 남음"]);   // APP_VERSION=10.4.1 은 안 걸림
});

test("checkV2 approvals: origin.runtime ≠ runtime → runtime_change 한 줄", () => {
  const s = good();
  comp(s, "shop-web").props.origin = { runtime: "vm", product: "ec2" };
  const r = checkV2(s);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.approvals, [{ kind: "runtime_change", subject: "shop-web", from: "vm", to: "k8s" }]);
  for (const a of r.approvals) assert.equal(ApprovalRowV2.safeParse(a).success, true);
});

test("checkV2 approvals: image.source=build → build 한 줄 (detail = method), 계획 없으면 오류", () => {
  const s = good();
  comp(s, "shop-web").props.image = { source: "build", repository: "shop-web", digest: null,
    build: { repo: "github.com/demo/shop", commit: "abc123", path: "web", method: "buildpacks", evidence: ["web/package.json"] } };
  assert.equal(AppSpecV2.safeParse(s).success, true);
  const r = checkV2(s);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.approvals, [{ kind: "build", subject: "shop-web", detail: "buildpacks" }]);
  delete comp(s, "shop-web").props.image.build;
  assert.ok(checkV2(s).errors.some((e) => e.includes("shop-web.image build 계획 없음")));
});

test("v1 → v2: 지금 데모 v1 명세가 그대로 올라가고, v1 이 지어낸 값은 0.6", () => {
  const v1 = AppSpec.parse({ schemaVersion: "1", app: { name: "demo-app" },
    service: { image: "registry/demo@sha256:" + "0".repeat(64), port: 8080, healthPath: "/healthz", replicas: 2, cpu: "500m", memory: "1Gi", env: [], secretRefs: [] },
    database: { engine: "postgres", majorVersion: "16", storageGb: 20 },
    ingress: { hostname: "demo.example.com", entry: "cloudflare-lb" } });
  const out = upconvertV1(v1);
  assert.equal(ImportResultV2.safeParse(out).success, true);
  assert.deepEqual(checkV2(out.spec), { errors: [], reviews: [], approvals: [] });
  assert.equal(out.spec.components.length, 2);
  assert.deepEqual(out.spec.links, [{ from: "demo-app", to: "db", intent: "connect" }]);
  assert.equal(out.fieldMeta["components.demo-app.resources"]?.confidence, 0.6);
  assert.equal(out.fieldMeta["components.demo-app.probes"]?.needs_review, true);
  const svc = out.spec.components[0]!;
  assert.equal(svc.kind, "service");
  if (svc.kind === "service") {
    assert.deepEqual(svc.props.resources, { request: { cpuMilli: 500, memMiB: 1024 } });
    assert.deepEqual(svc.props.image, { source: "registry", repository: "registry/demo", digest: "sha256:" + "0".repeat(64) });
  }
});

test("v1 올리기: 비밀 이름·DB 용량·벤더 주소 값은 0.6, 벤더 주소가 남은 판은 legacy 검사로만 깨끗", () => {
  const v1 = AppSpec.parse({ schemaVersion: "1", app: { name: "demo" },
    service: { image: "r/d@sha256:" + "0".repeat(64), port: 8080, healthPath: "/healthz", replicas: 1, cpu: "500m", memory: "1Gi",
      env: [{ name: "DB_HOST", value: "d.x.rds.amazonaws.com" }], secretRefs: [{ name: "DB_PASSWORD", key: "password" }] },
    database: { engine: "postgres", majorVersion: "16", storageGb: 100 }, ingress: { hostname: "d.example.com", entry: "cloudflare-lb" } });
  const { spec, fieldMeta } = upconvertV1(v1);
  assert.equal(fieldMeta["components.demo.env.DB_PASSWORD"]?.confidence, 0.6);
  assert.equal(fieldMeta["components.demo.env.DB_HOST"]?.confidence, 0.6);
  assert.equal(fieldMeta["components.db.storageGb"]?.confidence, 0.6);
  const db = spec.components[1]!;
  assert.equal(db.kind === "postgres" ? db.props.ha : "x", undefined);
  const r = checkV2(spec);
  assert.deepEqual(r.errors, []);
  assert.ok(r.reviews.some((e) => e.includes("벤더 주소")));
  assert.deepEqual(checkV2(spec, { legacy: true }), { errors: [], reviews: [], approvals: [] });
});

test("v1 올리기: 앱 이름이 db 여도 id 가 안 겹침", () => {
  const v1 = AppSpec.parse({ schemaVersion: "1", app: { name: "db" },
    service: { image: "r/d@sha256:" + "0".repeat(64), port: 80, healthPath: "/", replicas: 1, cpu: "250m", memory: "512Mi", env: [], secretRefs: [] },
    database: { engine: "postgres", majorVersion: "16", storageGb: 5 }, ingress: { hostname: "d.example.com", entry: "cloudflare-lb" } });
  assert.deepEqual(checkV2(upconvertV1(v1).spec).errors, []);
});

test("JSON Schema 로 뽑힌다 (npm run schemas 가 안 깨짐)", () => {
  assert.doesNotThrow(() => z.toJSONSchema(AppSpecV2));
  assert.doesNotThrow(() => z.toJSONSchema(ImportResultV2));
});
