// 공통 명세 v2 비용 (PLAN_IR=v2 계획서 고지용). 가격표에 있는 덩어리만 합계, 나머지는 이름으로
import { test } from "node:test";
import assert from "node:assert/strict";
import { AppSpec, AppSpecV2, upconvertV1 } from "@svc/contracts";
import { estimateCost, estimateCostV2, loadSampleCatalog, type EnvEstimate, type PriceCatalog } from "../src/index.js";
import { spec } from "./helpers.js";

const catalog = loadSampleCatalog();
const ALL = ["aws", "gcp", "onprem", "azure_mock"] as const;
type Raw = Record<string, any>;
const V1 = AppSpec.parse(spec({ cpu: "500m", memory: "1Gi" }));   // demo-shop: 1대 x 500m/1Gi + Postgres 20GB
const run = (s: AppSpecV2, peakRps = 10, cat: PriceCatalog = catalog) =>
  estimateCostV2({ spec: s, providers: [...ALL], peakRps }, cat);
const by = (r: { envs: EnvEstimate[] }, p: string) => r.envs.find((e) => e.provider === p)!;
/** upconvert 판을 고쳐 v2 명세를 만든다 */
const v2 = (mut: (s: Raw) => void = () => {}): AppSpecV2 => {
  const s: Raw = structuredClone(upconvertV1(V1).spec);
  mut(s);
  return AppSpecV2.parse(s);
};
const svc = (s: Raw) => s.components.find((c: Raw) => c.kind === "service");

test("v1 과 같다: upconvertV1 판은 estimateCost 와 환경별 금액·덩어리·노드가 같고 못 넣은 칸이 없다", () => {
  const cases = [V1, AppSpec.parse(spec({ replicas: 3, cpu: "1", memory: "2Gi" })), AppSpec.parse(spec({}, false))];
  for (const s of cases) for (const rps of [10, 300]) {
    const a = estimateCost({ spec: s, targets: [...ALL], traffic: { peakRps: rps } }, catalog, { breakpoints: false });
    const b = estimateCostV2({ spec: upconvertV1(s).spec, providers: [...ALL], peakRps: rps }, catalog);
    assert.deepEqual(b.envs, a.envs, `${s.service.replicas}x${s.service.cpu} rps=${rps}`);
    assert.equal(b.priceAsOf, a.priceAsOf);
  }
});

test("캐시·큐·버킷: 가격표에 줄이 없어 합계는 그대로, unknown 에 <종류>:<id> 로 남는다", () => {
  const r = run(v2((s) => s.components.push(
    { id: "shop-cache", kind: "cache", props: { engine: "redis", memoryMiB: 1024, tls: true, auth: false, ha: true } },
    { id: "shop-assets", kind: "objectStore", props: { versioning: false, public: false, sizeGb: 50 } },
    { id: "orders", kind: "queue", props: { model: "queue" } })));
  assert.equal(by(r, "aws").monthlyUsd, 227.5);
  assert.equal(by(r, "gcp").monthlyUsd, 146.9);
  for (const p of ALL) assert.deepEqual(by(r, p).unknown, ["cache:shop-cache", "objectStore:shop-assets", "queue:orders"], p);
});

test("관리형 컨테이너(ECS·Cloud Run): 서비스는 못 넣고, k8s 워크로드가 없으니 클러스터·노드도 안 센다 (DB 만)", () => {
  const r = run(v2((s) => { svc(s).props.runtime = "managedContainer"; svc(s).props.origin = { runtime: "managedContainer", product: "ecs" }; }));
  const aws = by(r, "aws"), gcp = by(r, "gcp");
  assert.equal(aws.monthlyUsd, 78.6);   // RDS 76 + 20GB x 0.131
  assert.deepEqual(aws.parts, { cluster: 0, nodes: 0, db: 76, storage: 2.6, fixed: 0 });
  assert.deepEqual([aws.nodeSku, aws.nodes, aws.candidatesEvaluated], [null, 0, 0]);
  assert.equal(gcp.monthlyUsd, 84.1);   // 크레딧도 안 씀 (관리비가 없음)
  assert.equal(gcp.creditUsd, 0);
  for (const p of ALL) assert.deepEqual(by(r, p).unknown, ["service:demo-shop"], p);
  // VM 도 같은 규칙
  assert.deepEqual(by(run(v2((s) => { svc(s).props.runtime = "vm"; })), "aws").unknown, ["service:demo-shop"]);
});

test("서비스 두 개: 요청량을 합쳐 노드 수를 정한다 (v1 투영은 주 서비스 하나만 셌다)", () => {
  const r = run(v2((s) => s.components.push({ id: "worker", kind: "service",
    props: { ...structuredClone(svc(s).props), replicas: { min: 2, max: 2 }, resources: { request: { cpuMilli: 1000, memMiB: 2048 } } } })));
  // 2.5 vCPU · 5GiB → t3.medium 3대
  assert.deepEqual([by(r, "aws").monthlyUsd, by(r, "aws").nodeSku, by(r, "aws").nodes], [265.5, "t3.medium", 3]);
  assert.deepEqual([by(r, "gcp").monthlyUsd, by(r, "gcp").nodes], [178.3, 3]);
  assert.equal(by(r, "onprem").monthlyUsd, 250);
  for (const p of ALL) assert.deepEqual(by(r, p).unknown, [], p);
  assert.ok(by(r, "aws").monthlyUsd! > by(run(v2()), "aws").monthlyUsd!);
});

test("Postgres 두 개는 단가 x 2, ha·readReplicas·compute 는 금액에 반영 못 해 칸 이름으로 남긴다", () => {
  const r = run(v2((s) => {
    const pg = s.components.find((c: Raw) => c.kind === "postgres");
    pg.props = { ...pg.props, ha: true, readReplicas: 1, compute: { cpuMilli: 4000, memMiB: 16384 } };
    s.components.push({ id: "db-2", kind: "postgres", props: { majorVersion: "16", storageGb: 50, ha: false, compute: { cpuMilli: null, memMiB: null } } });
  }));
  const aws = by(r, "aws");
  assert.deepEqual([aws.parts.db, aws.parts.storage], [152, 9.2]);   // 76 x 2, (20 + 50) x 0.131
  assert.equal(aws.monthlyUsd, 310.1);
  assert.deepEqual(aws.unknown, ["postgres:db.compute", "postgres:db.ha", "postgres:db.readReplicas"]);
});

test("요청량을 모르는 k8s 서비스·k8s 잡·크기를 모르는 DB 는 칸 이름으로, limit 만 있으면 limit 을 요청량으로 (k8s 규칙)", () => {
  const r = run(v2((s) => {
    s.components.push({ id: "api", kind: "service", props: { ...structuredClone(svc(s).props), resources: { request: { cpuMilli: null, memMiB: 512 } } } });
    s.components.push({ id: "nightly", kind: "job", props: { image: svc(s).props.image, resources: {}, env: [], serviceAccount: "default", schedule: "0 3 * * *" } });
    svc(s).props.resources = { limit: { cpuMilli: 4000, memMiB: 4096 } };
    s.components.find((c: Raw) => c.kind === "postgres").props.storageGb = null;
  }));
  const aws = by(r, "aws");
  assert.deepEqual(aws.unknown, ["job:nightly", "postgres:db.storageGb", "service:api.resources"]);
  assert.equal(aws.parts.storage, 0);
  // limit 4 vCPU·4GiB + api 0.5GiB → t3.medium 4대(CPU 기준)가 m6i.xlarge 2대보다 쌈
  assert.deepEqual([aws.nodeSku, aws.nodes], ["t3.medium", 4]);
});

test("거부: 노드 가격이 없으면 PRICE_MISSING(금액 null)이어도 못 넣은 칸 이름은 남기고, 명세 모양이 틀리면 던진다", () => {
  const noNodes: PriceCatalog = { ...catalog, rows: catalog.rows.filter((x) => !(x.vendor === "aws" && x.item === "node")) };
  const r = run(v2((s) => s.components.push({ id: "q", kind: "queue", props: { model: "topic" } })), 10, noNodes);
  const aws = by(r, "aws");
  assert.deepEqual([aws.feasible, aws.reason, aws.monthlyUsd], [false, "PRICE_MISSING", null]);
  assert.deepEqual(aws.unknown, ["node", "queue:q"]);
  assert.equal(by(r, "gcp").feasible, true);
  assert.throws(() => estimateCostV2({ spec: { schemaVersion: "1" } as unknown as AppSpecV2, providers: ["aws"], peakRps: 10 }, catalog));
});
