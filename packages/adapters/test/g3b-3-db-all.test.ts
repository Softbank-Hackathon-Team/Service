// G3b-3: DB 를 "이름순 첫 번째 하나"로 고르지 않고 전부 읽어 앱 경계가 근거로 고른다. Aurora Postgres 도 읽는다
import { test } from "node:test";
import assert from "node:assert/strict";
import { discoverOnprem } from "../src/discover/index.js";
import { normalizeV2 } from "../src/import/pipeline.js";
import { rdsMapper, auroraEndpoints } from "../src/import/mappers/rds.js";
import { fakeExec, DIGEST, type Reply } from "./fake-cli.js";

const cnpg = (name: string, ns: string) => ({ metadata: { name, namespace: ns }, spec: { imageName: "ghcr.io/cloudnative-pg/postgresql:16.4", storage: { size: "5Gi" }, instances: 1 } });
const app = (dbHost: string | null): Array<[RegExp, Reply]> => [
  [/^kubectl get nodes/, { out: { items: [] } }],
  [/^kubectl get deployments/, { out: { items: [{ metadata: { name: "api", namespace: "shop" }, spec: { replicas: 1, selector: { matchLabels: { app: "api" } },
    template: { metadata: { labels: { app: "api" } }, spec: { containers: [{ name: "api", image: `api@${DIGEST("a")}`, env: dbHost ? [{ name: "DB_HOST", value: dbHost }] : [] }] } } } }] } }],
  // 이름순으로는 aaa-other 가 앞이지만 앱은 shop-db 를 씀
  [/^kubectl get clusters.postgresql.cnpg.io/, { out: { items: [cnpg("aaa-other", "other"), cnpg("shop-db", "shop")] } }],
];

test("G3b-3: 이름순 앞 DB 가 아니라 앱이 env 로 가리키는 DB 가 명세에 들어간다", async () => {
  const { exec } = fakeExec(app("shop-db-rw.shop.svc"));
  const r = normalizeV2(await discoverOnprem({ exec, env: {} })).result;
  assert.deepEqual(r.spec.components.filter((c) => c.kind === "postgres").map((c) => c.id), ["shop-db"]);
  assert.ok(r.outOfBoundary?.some((o) => o.resource === "cnpg.cluster:aaa-other"));
  assert.equal(r.fieldMeta["check.boundary.postgres"], undefined);
});

test("G3b-3: 앱이 닿는 근거가 없으면 DB 없는 명세가 조용히 나오지 않고 검토 줄", async () => {
  const { exec } = fakeExec(app(null));
  const r = normalizeV2(await discoverOnprem({ exec, env: {} })).result;
  assert.equal(r.spec.components.some((c) => c.kind === "postgres"), false);
  assert.equal(r.fieldMeta["check.boundary.postgres"]?.needs_review, true);
});

test("G3b-3·RF-3: 지정한 CNPG 가 없으면 조용히 DB 없음이 아니라 검토 줄", async () => {
  const { exec } = fakeExec(app("shop-db-rw.shop.svc"));
  const r = normalizeV2(await discoverOnprem({ exec, env: { IMPORT_ONPREM_CNPG: "shop/nope" } })).result;
  assert.equal(r.fieldMeta["check.unread.cnpg.wanted"]?.needs_review, true);
});

test("G3b-3: Aurora Postgres 인스턴스 → 클러스터 이름·클러스터 주소의 postgres + '출발과 달라짐' 검토", () => {
  const c = rdsMapper.map({ kind: "rds.dbInstance", DBInstanceIdentifier: "shop-aurora-1", DBClusterIdentifier: "shop-aurora", Engine: "aurora-postgresql",
    EngineVersion: "16.2", AllocatedStorage: 1, Endpoint: "shop-aurora-1.abc123.ap-northeast-2.rds.amazonaws.com" });
  assert.ok(!("skip" in c));
  if ("skip" in c) return;
  assert.equal(c.name, "shop-aurora");
  assert.equal(c.native.endpoint, "shop-aurora.cluster-abc123.ap-northeast-2.rds.amazonaws.com");
  assert.ok(c.native.aliases?.includes("shop-aurora.cluster-ro-abc123.ap-northeast-2.rds.amazonaws.com"));
  assert.equal(c.props.storageGb, null);
  assert.equal(c.meta.engine?.[1], 0.6);
});

test("G3b-3: MySQL 등 Postgres 아닌 엔진은 그대로 unmapped C (Aurora MySQL 포함)", () => {
  const c = rdsMapper.map({ kind: "rds.dbInstance", DBInstanceIdentifier: "m", Engine: "aurora-mysql" });
  assert.ok("skip" in c);
  assert.deepEqual(auroraEndpoints(null, "x"), []);
});

test("G3b-3: AWS 는 RDS Postgres 를 전부 읽고(복제본은 원본 별칭), 지정한 DB 가 없으면 검토 줄", async () => {
  const { discoverAws } = await import("../src/discover/index.js");
  const table = (): Array<[RegExp, Reply]> => [
    [/^aws sts get-caller-identity/, { out: { Account: "111122223333" } }],
    [/^aws eks list-clusters/, { out: { clusters: ["c"] } }],
    [/^aws eks describe-cluster/, { out: { cluster: { version: "1.31", resourcesVpcConfig: { vpcId: "vpc-1" } } } }],
    [/^aws eks update-kubeconfig/, { out: "ok" }],
    [/^kubectl get deployments/, { out: { items: [{ metadata: { name: "api", namespace: "shop" }, spec: { replicas: 1, selector: { matchLabels: { app: "api" } },
      template: { metadata: { labels: { app: "api" } }, spec: { containers: [{ name: "api", image: `api@${DIGEST("a")}`,
        env: [{ name: "DB_RO", value: "shop-db-ro.x.ap-northeast-2.rds.amazonaws.com" }] }] } } } }] } }],
    [/^aws rds describe-db-instances/, { out: { DBInstances: [
      { DBInstanceIdentifier: "aaa-other", Engine: "postgres", EngineVersion: "16.4", AllocatedStorage: 20, Endpoint: { Address: "aaa-other.x.ap-northeast-2.rds.amazonaws.com" } },
      { DBInstanceIdentifier: "shop-db", Engine: "postgres", EngineVersion: "16.4", AllocatedStorage: 20, Endpoint: { Address: "shop-db.x.ap-northeast-2.rds.amazonaws.com" } },
      { DBInstanceIdentifier: "shop-db-ro", Engine: "postgres", EngineVersion: "16.4", ReadReplicaSourceDBInstanceIdentifier: "shop-db", Endpoint: { Address: "shop-db-ro.x.ap-northeast-2.rds.amazonaws.com" } },
    ] } }],
    [/^aws ecs list-clusters/, { out: { clusterArns: [] } }],
  ];
  const { exec } = fakeExec(table());
  const inv = await discoverAws({ exec, env: {} });
  const rds = inv.items.filter((i) => (i as { kind: string }).kind === "rds.dbInstance") as Array<{ DBInstanceIdentifier: string }>;
  assert.deepEqual(rds.map((x) => x.DBInstanceIdentifier), ["aaa-other", "shop-db"], "복제본은 따로 안 읽음");
  const r = normalizeV2(inv).result;
  assert.deepEqual(r.spec.components.filter((c) => c.kind === "postgres").map((c) => c.id), ["shop-db"], "복제본 주소로도 원본 DB 가 경계 안");
  const w = fakeExec(table());
  const inv2 = await discoverAws({ exec: w.exec, env: { IMPORT_AWS_DB_ID: "nope" } });
  assert.equal(normalizeV2(inv2).result.fieldMeta["check.unread.rds.wanted"]?.needs_review, true);
});
