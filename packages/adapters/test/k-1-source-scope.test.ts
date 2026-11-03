// K-1: 가져올 대상 고르기를 워커 환경변수가 아니라 이전마다의 출발 범위(SourceScope)로. 범위가 없으면 자동 고르기 + 검토 줄
import { test } from "node:test";
import assert from "node:assert/strict";
import { SourceScope } from "@svc/contracts";
import { discoverSource, scopedEnv } from "../src/discover/index.js";
import { normalizeV2 } from "../src/import/pipeline.js";
import { fakeExec, DIGEST, type Reply } from "./fake-cli.js";

const dep = (name: string, ns: string) => ({ metadata: { name, namespace: ns }, spec: { replicas: 1, selector: { matchLabels: { app: name } },
  template: { metadata: { labels: { app: name } }, spec: { containers: [{ name, image: `${name}@${DIGEST("a")}` }] } } } });
const table = (): Array<[RegExp, Reply]> => [
  [/^kubectl get nodes/, { out: { items: [] } }],
  [/^kubectl get deployments -A/, { out: { items: [dep("a-app", "alpha"), dep("b-app", "beta")] } }],
  [/^kubectl get deployments -n beta/, { out: { items: [dep("b-app", "beta")] } }],
  [/^kubectl get clusters.postgresql.cnpg.io/, { out: { items: [] } }],
];

test("K-1: 계약 — 이름 글자만, 모르는 칸 거부", () => {
  assert.equal(SourceScope.safeParse({ cluster: "us-central1/gke", namespaces: ["shop"], database: "shop/db", partOf: "shop", appName: "shop" }).success, true);
  assert.equal(SourceScope.safeParse({ cluster: "x y" }).success, false);
  assert.equal(SourceScope.safeParse({ cluster: "$(id)" }).success, false);
  assert.equal(SourceScope.safeParse({ region: "x" }).success, false);
  assert.equal(SourceScope.safeParse({ appName: "Shop" }).success, false);
});

test("K-1: 출발 범위 namespaces 가 워커 환경변수보다 먼저 (회사·이전마다 다르게)", async () => {
  const { exec, calls } = fakeExec(table());
  const inv = await discoverSource("onprem", { exec, env: { IMPORT_NAMESPACE: "alpha" } }, { scope: { namespaces: ["beta"] } });
  assert.ok(calls.some((c) => c.startsWith("kubectl get deployments -n beta")));
  const r = normalizeV2(inv).result;
  assert.deepEqual(r.spec.components.map((c) => c.id), ["b-app"]);
  assert.equal(Object.keys(r.fieldMeta).some((k) => k.startsWith("check.pick.")), false, "정한 범위면 자동 고르기 줄 없음");
});

test("K-1: 범위가 비면 자동 고르기 + 검토 줄 check.pick.namespace", async () => {
  const { exec } = fakeExec(table());
  const r = normalizeV2(await discoverSource("onprem", { exec, env: {} }, {})).result;
  assert.equal(r.fieldMeta["check.pick.namespace"]?.needs_review, true);
});

test("K-1: scopedEnv — 빈 범위는 env 그대로, 칸은 IMPORT_* 로 덮음 (프로세스 env 는 안 바꿈)", () => {
  const env = { IMPORT_AWS_DB_ID: "dev-db" };
  assert.equal(scopedEnv(env, {}), env);
  const o = scopedEnv(env, { database: "prod-db", cluster: "c" });
  assert.equal(o.IMPORT_AWS_DB_ID, "prod-db");
  assert.equal(o.IMPORT_AWS_EKS_CLUSTER, "c");
  assert.equal(env.IMPORT_AWS_DB_ID, "dev-db");
});

test("K-1: 지정한 EKS 클러스터가 없으면 ECS 로 조용히 넘어가지 않고 멈춤", async () => {
  const { exec } = fakeExec([[/^aws sts/, { out: { Account: "111122223333" } }], [/^aws eks list-clusters/, { out: { clusters: ["other"] } }]]);
  await assert.rejects(discoverSource("aws", { exec, env: {} }, { scope: { cluster: "prod" } }), (e: { code?: string }) => e.code === "SOURCE_INCOMPLETE");
});
