// 클라우드 → 클라우드 대체 상품 (AWS ↔ GCP): 도착 Builder substitutionsV2 가 내는 substitute 승인 행
import { test } from "node:test";
import assert from "node:assert/strict";
import { AppSpecV2, type ApprovalRowV2, type Provider } from "@svc/contracts";
import { targetBuilderFor } from "../src/index.js";

type Raw = Record<string, unknown>;
const SHOP = { id: "shop", kind: "service", props: { runtime: "k8s", origin: { runtime: "k8s", product: "unknown" },
  image: { source: "registry", repository: "r/shop", digest: "sha256:" + "a".repeat(64) }, ports: [{ port: 8080, protocol: "TCP" }],
  replicas: { min: 1, max: 1 }, serviceAccount: "default", resources: { request: { cpuMilli: 500, memMiB: 1024 } }, env: [] } };
const spec = (...data: Raw[]): AppSpecV2 => AppSpecV2.parse({ schemaVersion: "2", app: { name: "shop" }, components: [SHOP, ...data],
  links: data.filter((d) => !(d.props as Raw).inCluster).map((d) => ({ from: "shop", to: d.id, intent: "connect" })),
  posture: { permissions: [], network: [] } });
const subs = (s: AppSpecV2, source: Provider, target: Provider) => targetBuilderFor(target).substitutionsV2!(s, source);
const one = (s: AppSpecV2, source: Provider, target: Provider): ApprovalRowV2 => {
  const rows = subs(s, source, target);
  assert.equal(rows.length, 1, JSON.stringify(rows));
  return rows[0]!;
};
// 잃는 것의 이름만 (괄호 안 설명 글은 빼고)
const lostNames = (r: ApprovalRowV2) => (r.lost ?? []).map((x) => x.replace(/ \(.*$/, ""));

const cache = (props: Raw = {}) => ({ id: "shop-cache", kind: "cache", props: { engine: "redis", memoryMiB: 1024, tls: false, auth: false, ...props } });
const queue = (props: Raw = {}) => ({ id: "orders", kind: "queue", props: { model: "queue", ...props } });
const bucket = (props: Raw = {}) => ({ id: "shop-assets", kind: "objectStore", props: { versioning: true, public: false, sizeGb: 5, ...props } });
const db = (props: Raw = {}) => ({ id: "shop-db", kind: "postgres", props: { majorVersion: "16", storageGb: 20, ...props } });

test("캐시 AWS→GCP: ElastiCache → Memorystore, 쓰는 설정만 잃는 것에 (엔진·포트·AUTH·서버 CA), 데이터는 늘", () => {
  const all = one(spec(cache({ engine: "valkey", port: 6380, tls: true, auth: true })), "aws", "gcp");
  assert.deepEqual({ ...all, lost: lostNames(all) }, { kind: "substitute", subject: "shop-cache", from: "ElastiCache (valkey)", to: "Memorystore (redis)",
    lost: ["Valkey engine", "Port", "AUTH password", "TLS server CA certificate", "Cached data"], appChange: false });
  assert.match(all.lost![2]!, /app-<app>-<id>-cache-auth/);
  assert.deepEqual(lostNames(one(spec(cache()), "aws", "gcp")), ["Cached data"]);
});

test("캐시 GCP→AWS: Memorystore → ElastiCache, 잃는 것은 데이터뿐 (AUTH 는 v2Blockers 가 사람에게 물음)", () => {
  const r = one(spec(cache({ tls: true })), "gcp", "aws");
  assert.deepEqual([r.from, r.to, r.appChange], ["Memorystore (redis)", "ElastiCache (redis)", false]);
  assert.deepEqual(lostNames(r), ["Cached data"]);
});

test("큐 AWS→GCP: SQS FIFO → Pub/Sub, 중복 제거·남은 메시지를 잃고 앱 코드 변경", () => {
  const r = one(spec(queue({ ordered: true })), "aws", "gcp");
  assert.deepEqual([r.from, r.to, r.appChange], ["SQS FIFO", "Pub/Sub topic + subscription", true]);
  assert.deepEqual(lostNames(r), ["FIFO deduplication", "Pending messages"]);
  assert.match(r.detail!, /Pub\/Sub SDK/);
  assert.deepEqual(lostNames(one(spec(queue()), "aws", "gcp")), ["Pending messages"]);
  assert.equal(one(spec(queue({ model: "topic" })), "aws", "gcp").from, "SNS");
});

test("큐 GCP→AWS: Pub/Sub → SQS FIFO, 내용 기반 중복 제거 없음·구독 자동 삭제·남은 메시지를 잃고 앱 코드 변경", () => {
  const r = one(spec(queue({ ordered: true, idleExpirySec: 86400 })), "gcp", "aws");
  assert.deepEqual([r.from, r.to, r.appChange], ["Pub/Sub topic + subscription", "SQS FIFO", true]);
  assert.deepEqual(lostNames(r), ["Sends that relied on ordering keys only", "Auto-delete of idle subscriptions", "Pending messages"]);
  assert.match(r.detail!, /SQS\/SNS SDK/);
});

for (const [source, target, from, to, policy, cold] of [
  ["aws", "gcp", "S3", "Cloud Storage", "Bucket policy body", "COLDLINE"],
  ["gcp", "aws", "Cloud Storage", "S3", "Bucket IAM policy", "GLACIER_IR"],
] as const) {
  test(`버킷 ${source}→${target}: ${from} → ${to}, 정책 본문·차가운 등급·객체를 잃고 앱 코드 변경`, () => {
    const r = one(spec(bucket({ lifecycle: [{ prefix: "old/", toColdAfterDays: 30 }] })), source, target);
    assert.deepEqual([r.from, r.to, r.appChange], [from, to, true]);
    assert.deepEqual(lostNames(r), [policy, "Cold storage class", "Objects"]);
    assert.match(r.lost![1]!, new RegExp(cold));
    assert.deepEqual(lostNames(one(spec(bucket()), source, target)), [policy, "Objects"]);
  });
}

test("DB: RDS ↔ Cloud SQL 은 앱 코드 그대로. AWS→GCP 는 5432 아닌 포트·분 단위 유지보수 창을 잃음", () => {
  const r = one(spec(db({ port: 6432, maintenanceWindow: "sun:03:30-sun:04:30" })), "aws", "gcp");
  assert.deepEqual([r.from, r.to, r.appChange], ["RDS for PostgreSQL", "Cloud SQL for PostgreSQL", false]);
  assert.deepEqual(lostNames(r), ["Port", "Maintenance window minutes"]);
  assert.deepEqual(one(spec(db({ port: 5432, maintenanceWindow: "sun:03:00-sun:04:00" })), "aws", "gcp").lost, []);
  const back = one(spec(db({ port: 6432 })), "gcp", "aws");
  assert.deepEqual([back.from, back.to, back.lost, back.appChange], ["Cloud SQL for PostgreSQL", "RDS for PostgreSQL", [], false]);
});

test("여러 데이터 자원은 id 순으로 하나씩, 서비스·잡은 줄 없음", () => {
  assert.deepEqual(subs(spec(queue(), cache(), bucket(), db()), "aws", "gcp").map((r) => r.subject), ["orders", "shop-assets", "shop-cache", "shop-db"]);
});

test("0줄: 같은 클라우드, 온프레·azure_mock 출발, 클러스터 안 데이터", () => {
  const s = spec(queue(), cache(), bucket(), db());
  for (const p of ["aws", "gcp"] as const) assert.deepEqual(subs(s, p, p), [], `${p}→${p}`);
  for (const source of ["onprem", "azure_mock"] as const) for (const target of ["aws", "gcp"] as const)
    assert.deepEqual(subs(s, source, target), [], `${source}→${target}`);
  const inCluster = spec(cache({ inCluster: { workload: "shop", product: "redis" } }));
  assert.deepEqual(subs(inCluster, "aws", "gcp"), []);
});
