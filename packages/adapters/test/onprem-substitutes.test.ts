// 클라우드 → 온프레 대체: substitute 승인 행과 Valkey 값 (온프레 어댑터 설계 S3~S5)
import { test } from "node:test";
import assert from "node:assert/strict";
import { AppSpecV2, ChartValues, type Provider, type TargetEnv } from "@svc/contracts";
import { requirementsV2, targetBuilderFor, v2Blockers } from "../src/index.js";

type Raw = Record<string, unknown>;
const SHOP = (env: Raw[] = []) => ({ id: "shop", kind: "service", props: { runtime: "k8s", origin: { runtime: "k8s", product: "unknown" },
  image: { source: "registry", repository: "ghcr.io/demo/shop", digest: "sha256:" + "a".repeat(64) }, ports: [{ port: 8080, protocol: "TCP" }],
  replicas: { min: 1, max: 1 }, serviceAccount: "default", resources: { request: { cpuMilli: 500, memMiB: 1024 } }, env } });
const spec = (data: Raw[], env: Raw[] = []): AppSpecV2 => AppSpecV2.parse({ schemaVersion: "2", app: { name: "shop" }, components: [SHOP(env), ...data],
  links: data.filter((d) => !(d.props as Raw).inCluster).map((d) => ({ from: "shop", to: d.id, intent: "connect" })),
  posture: { permissions: [], network: [] } });
const db = (props: Raw = {}) => ({ id: "db", kind: "postgres", props: { majorVersion: "16", storageGb: 20, ...props } });
const cache = (props: Raw = {}) => ({ id: "sess", kind: "cache", props: { engine: "redis", version: "7.1", memoryMiB: 1024, tls: false, auth: false, ...props } });
const T = { envId: "33333333-3333-4333-8333-333333333333", provider: "onprem", region: "local" } as TargetEnv;
const on = targetBuilderFor("onprem");
const subs = (s: AppSpecV2, source: Provider) => on.substitutionsV2!(s, source);
const lostNames = (lost: string[] | undefined) => (lost ?? []).map((x) => x.replace(/ \(.*$/, ""));

test("RDS → CloudNativePG 승인 행: 앱 코드 그대로, 쓰는 설정만 잃는 것에", () => {
  const [r] = subs(spec([db({ port: 6432, backup: { retentionDays: 7, pitr: true }, maintenanceWindow: "sun:03:00-sun:04:00", storageMaxGb: 100 })]), "aws");
  assert.deepEqual({ ...r, lost: lostNames(r!.lost) }, { kind: "substitute", subject: "db", from: "RDS for PostgreSQL", to: "CloudNativePG",
    lost: ["Port", "Automated backups and point-in-time recovery", "Maintenance window", "Storage autoscaling"], appChange: false });
  assert.deepEqual(subs(spec([db({ port: 5432, backup: { retentionDays: 0, pitr: false } })]), "gcp")[0], { kind: "substitute", subject: "db", from: "Cloud SQL for PostgreSQL", to: "CloudNativePG", lost: [], appChange: false });
});

test("ElastiCache → Valkey 승인 행: 판을 고르고 단일 서버·평문·빈 캐시를 적는다 (조용히 안 버림)", () => {
  const [all] = subs(spec([cache({ version: "7.4", clusterMode: true, shards: 3, ha: true, tls: true })]), "aws");
  assert.deepEqual([all!.from, all!.to, all!.appChange], ["ElastiCache (redis)", "Valkey 7.2", true], "클러스터 모드는 클라이언트 설정을 바꿔야 함");
  assert.match(all!.detail!, /Single-server client/);
  assert.equal(subs(spec([cache()]), "aws")[0]!.appChange, false);
  assert.deepEqual(lostNames(all!.lost), ["Newer source version features", "Cluster mode and shards", "Replicas and automatic failover", "In-transit encryption", "Cached data"]);
  assert.deepEqual(lostNames(subs(spec([cache()]), "aws")[0]!.lost), ["Cached data"]);
  assert.equal(subs(spec([cache({ engine: "valkey", version: "8.0" })]), "aws")[0]!.to, "Valkey 8.1");
  assert.equal(subs(spec([cache({ tls: null })]), "gcp")[0]!.from, "Memorystore (redis)");
});

test("0줄: 온프레·azure_mock 출발, 클러스터 안 데이터. 여러 자원은 id 순", () => {
  const s = spec([db(), cache()]);
  for (const source of ["onprem", "azure_mock"] as const) assert.deepEqual(subs(s, source), [], source);
  assert.deepEqual(subs(spec([cache({ inCluster: { workload: "shop", product: "redis" } })]), "aws"), []);
  assert.deepEqual(subs(s, "aws").map((r) => r.subject), ["db", "sess"]);
});

test("Valkey 값: 계약 통과, 이름·포트·메모리, 앱 env 링크는 평문 redis:// 주소", () => {
  const s = spec([cache({ port: 6380 })], [{ name: "REDIS_URL", fromLink: { to: "sess", output: "url" } }, { name: "REDIS_HOST", fromLink: { to: "sess", output: "host" } }]);
  const v = ChartValues.parse(on.toWorkloadValues(s, {}, T));
  assert.deepEqual(v.dataServices, [{ id: "sess", kind: "valkey", name: "shop-sess", port: 6380, maxmemoryMi: 1024,
    image: v.dataServices![0]!.image, resources: { requests: { cpu: "100m", memory: "1280Mi" }, limits: { memory: "1280Mi" } } }]);
  assert.match(v.dataServices![0]!.image, /^docker\.io\/valkey\/valkey:7\.2-alpine@sha256:[0-9a-f]{64}$/);
  const env = v.workloads[0]!.env as Array<{ name: string; value: string }>;
  assert.deepEqual(env.map((e) => e.value), ["redis://shop-sess:6380", "shop-sess"]);
});

test("Valkey 값: 출발 메모리를 못 읽어도 maxmemory 를 줘서 OOM 대신 교체. 캐시 없으면 칸 자체가 없음", () => {
  const d = (on.toWorkloadValues(spec([cache({ memoryMiB: null })]), {}, T) as ChartValues).dataServices![0]!;
  assert.equal(d.maxmemoryMi, 200);
  assert.deepEqual(d.resources, { requests: { cpu: "100m", memory: "250Mi" }, limits: { memory: "250Mi" } });
  assert.equal("dataServices" in on.toWorkloadValues(spec([db()]), {}, T), false);
});

test("거부: 캐시 이름이 CNPG Service(shop-db-rw)와 겹치면 값과 링크 주소 모두 다른 이름으로", () => {
  const s = spec([db(), { ...cache(), id: "db-rw" }], [{ name: "REDIS_HOST", fromLink: { to: "db-rw", output: "host" } }]);
  const v = ChartValues.parse(on.toWorkloadValues(s, {}, T));
  const name = v.dataServices![0]!.name;
  assert.match(name, /^shop-db-rw-[0-9a-f]{6}$/);
  assert.equal((v.workloads[0]!.env as Array<{ value: string }>)[0]!.value, name);
});

test("거부: 캐시 이름이 워크로드·입구와 겹쳐도 계획 값에서 다른 이름으로 (렌더까지 가서 실패하지 않음)", () => {
  const nameOf = (s: AppSpecV2) => (on.toWorkloadValues(s, {}, T) as ChartValues).dataServices![0]!.name;
  const worker = { ...SHOP(), id: "shop-sess" };
  const s = AppSpecV2.parse({ ...spec([cache()]), components: [...spec([cache()]).components, worker] });
  assert.match(nameOf(s), /^shop-sess-[0-9a-f]{6}$/);
  assert.match(nameOf(spec([{ ...cache(), id: "cloudflared" }])), /^shop-cloudflared-[0-9a-f]{6}$/);
});

test("rediss 주소: 캐시로 가면 env·args·설정 파일 모두 redis:// 로. 다른 서버로 가는 rediss:// 는 그대로, 글자 값도 그대로", () => {
  const s = spec([cache({ tls: true })], [
    { name: "REDIS_URL", template: "rediss://${sess.host}:${sess.port}/0" },
    { name: "WITH_USER", template: "rediss://app@${sess.host}:6379" },
    { name: "OTHER", template: "rediss://${shop.host}:6379" },
    { name: "LITERAL", value: "rediss://outside.example.com:6379" },
  ]);
  const shop = s.components[0]!.props as Raw;
  Object.assign(shop, { args: ["--cache", "rediss://${sess.host}:${sess.port}"], argTemplates: [1],
    configs: [{ name: "app", data: { url: "rediss://${sess.host}:${sess.port}" }, templateKeys: ["url"] }] });
  const w = ChartValues.parse(on.toWorkloadValues(s, {}, T)).workloads[0]! as unknown as { env: Array<{ value: string }>; args: string[]; configs: Array<{ data: { url: string } }> };
  assert.deepEqual(w.env.map((e) => e.value), ["redis://shop-sess:6379/0", "redis://app@shop-sess:6379", "rediss://shop.app-shop.svc:6379","rediss://outside.example.com:6379"]);
  assert.equal(w.args[1], "redis://shop-sess:6379");
  assert.equal(w.configs[0]!.data.url, "redis://shop-sess:6379");
});

test("rediss 주소: 클라우드 도착은 그대로 둔다", () => {
  const s = spec([cache({ tls: true })], [{ name: "REDIS_URL", template: "rediss://${sess.host}:6379" }]);
  const v = ChartValues.parse(targetBuilderFor("gcp").toWorkloadValues(s, {}, { ...T, provider: "gcp" }));
  assert.match((v.workloads[0]!.env as Array<{ value: string }>)[0]!.value, /^rediss:\/\//);
});

test("할당량에 Valkey 몫을 더하고, 생길 자원에 Deployment·Service 권한을 넣는다", () => {
  const quotaOf = (s: AppSpecV2) => JSON.parse(on.toTerraformV2(s, T).vars.namespace_json as string)[0];
  const base = quotaOf(spec([]));
  const withCache = quotaOf(spec([cache()]));
  assert.equal(withCache.quota_cpu_m - base.quota_cpu_m, 200);
  assert.equal(withCache.quota_memory_mi - base.quota_memory_mi, 2560);
  assert.ok(on.operateActionsV2(spec([cache()]), "apply").some((a) => /deployments/.test(a)));
});

test("거부: AUTH 출발은 사람에게 묻고, memcached·버킷·큐는 표 밖이라 막힌다", () => {
  const caps = on.capabilities();
  assert.ok(v2Blockers(spec([cache({ auth: true })]), caps).needsHuman.some((x) => /AUTH/.test(x)));
  assert.ok(v2Blockers(spec([cache({ auth: null })]), caps).needsHuman.some((x) => /AUTH/.test(x)));
  const memcached = spec([cache({ engine: "memcached" })]);
  assert.ok(requirementsV2(memcached).includes("kind.cache.memcached"));
  assert.ok(v2Blockers(memcached, caps).unsupported.some((x) => /kind\.cache\.memcached/.test(x)));
  assert.deepEqual(subs(memcached, "aws"), []);
  for (const data of [{ id: "b", kind: "objectStore", props: { versioning: true, public: false, sizeGb: 5 } }, { id: "q", kind: "queue", props: { model: "queue" } }]) {
    assert.ok(v2Blockers(spec([data]), caps).unsupported.length > 0, data.kind);
    assert.deepEqual(subs(spec([data]), "aws"), [], data.kind);
  }
});
