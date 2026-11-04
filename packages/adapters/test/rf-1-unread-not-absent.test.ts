// RF-1·RF-3: 출발 읽기 실패를 "없음"으로 삼키지 않는다. 일시 오류 → SOURCE_TRANSIENT(재시도), 거부 → 검토 줄(check.unread.*), DB 목록 → 멈춤
import { test } from "node:test";
import assert from "node:assert/strict";
import { discoverGcp, discoverOnprem } from "../src/discover/index.js";
import { readAwsData, readGcpData } from "../src/discover/data.js";
import { readEcs } from "../src/import/readers/aws-ecs.js";
import { readK8sNamespace } from "../src/discover/k8s.js";
import { readAwsIam } from "../src/discover/aws-iam.js";
import { normalizeV2 } from "../src/import/pipeline.js";
import { fakeExec, onpremApp, DIGEST, type Reply } from "./fake-cli.js";

const THROTTLE: Reply = { code: 254, err: "An error occurred (ThrottlingException) when calling the ListBuckets operation: Rate exceeded" };
const DENIED: Reply = { code: 254, err: "An error occurred (AccessDenied) when calling the ListBuckets operation: Access Denied" };
const empty = (x: string): [RegExp, Reply] => [new RegExp(`^aws ${x}`), { out: {} }];
const awsRest = [empty("sqs list-queues"), empty("elasticache describe-replication-groups")];

test("RF-1: S3 목록 스로틀링 → 없음이 아니라 SOURCE_TRANSIENT 로 던짐 (워커 재시도)", async () => {
  const { exec } = fakeExec([[/^aws s3api list-buckets/, THROTTLE], ...awsRest]);
  await assert.rejects(readAwsData({ exec, env: {} }, "ap-northeast-2", []), (e: { code?: string }) => e.code === "SOURCE_TRANSIENT");
});

test("RF-1: S3 목록 권한 거부 → 검토 줄 check.unread.s3 (신뢰도 0.6, needs_review)", async () => {
  const { exec } = fakeExec([[/^aws s3api list-buckets/, DENIED], ...awsRest]);
  const items = await readAwsData({ exec, env: {} }, "ap-northeast-2", []);
  const r = normalizeV2({ provider: "aws", items, coverage: {} }).result;
  const m = r.fieldMeta["check.unread.s3"];
  assert.equal(m?.needs_review, true);
  assert.equal(m?.confidence, 0.6);
  assert.match(m?.rationale ?? "", /못 읽음/);
});

test("RF-1: SQS 큐 하나 속성 거부 → 그 큐가 조용히 빠지지 않고 검토 줄", async () => {
  const { exec } = fakeExec([[/^aws s3api list-buckets/, { out: { Buckets: [] } }], [/^aws sqs list-queues/, { out: { QueueUrls: ["https://sqs.x/1/orders"] } }],
    [/^aws sqs get-queue-attributes/, { code: 254, err: "AccessDenied" }], empty("elasticache describe-replication-groups")]);
  const items = await readAwsData({ exec, env: {} }, "r", []);
  assert.ok(items.some((i) => i.kind === "import.unread" && i.what === "sqs.orders"));
});

test("RF-1: GCS·Pub/Sub·Memorystore 목록 거부 → 종류마다 검토 줄", async () => {
  const deny: Reply = { code: 1, err: "ERROR: (gcloud) PERMISSION_DENIED: forbidden" };
  const { exec } = fakeExec([[/^gcloud storage buckets list/, deny], [/^gcloud pubsub topics list/, deny], [/^gcloud redis instances list/, deny]]);
  const items = await readGcpData({ exec, env: {} }, "p", []);
  assert.deepEqual(items.map((i) => i.what).sort(), ["gcs", "memorystore", "pubsub"]);
});

test("RF-1: ECS 서비스 하나의 작업 정의를 못 읽어도 다른 서비스는 남고, 그 서비스는 검토 줄", async () => {
  const td = { family: "web", containerDefinitions: [{ name: "web", image: `x@${DIGEST("a")}`, essential: true }] };
  const { exec } = fakeExec([
    [/^aws ecs list-clusters/, { out: { clusterArns: ["arn:aws:ecs:r:1:cluster/c"] } }],
    [/^aws ecs list-services/, { out: { serviceArns: ["arn:1/api", "arn:1/web"] } }],
    [/^aws ecs describe-services/, { out: { services: [{ serviceName: "api", taskDefinition: "arn:td/api:1" }, { serviceName: "web", taskDefinition: "arn:td/web:1" }] } }],
    [/^aws ecs describe-task-definition --task-definition arn:td\/api/, { code: 254, err: "AccessDeniedException: not authorized" }],
    [/^aws ecs describe-task-definition --task-definition arn:td\/web/, { out: { taskDefinition: td } }],
    [/^aws ecs list-tasks/, { out: { taskArns: [] } }],
    [/^aws application-autoscaling/, { out: {} }],
  ]);
  const r = await readEcs({ exec, env: {} }, "r", {});
  assert.deepEqual(r.items.filter((i) => i.kind === "ecs.service").map((i) => i.serviceName), ["web"]);
  assert.ok(r.items.some((i) => i.kind === "import.unread" && i.what === "ecs.api"));
  assert.equal(r.counts["ecs.service"], 1);
});

test("RF-1: Cloud SQL 목록 권한 거부 → DB 없이 계속하지 않고 SOURCE_UNAVAILABLE / API 꺼짐 → DB 없음으로 계속", async () => {
  const base: Array<[RegExp, Reply]> = [
    [/^gcloud projects describe/, { out: {} }],
    [/^gcloud container clusters list/, { out: [] }],
    [/^gcloud compute instances list/, { out: [] }],
    [/^gcloud run services list/, { out: [{ metadata: { name: "api", labels: { "cloud.googleapis.com/location": "r" } }, spec: { template: { spec: { containers: [{ image: `x@${DIGEST("b")}` }] } } } }] }],
    [/^gcloud run jobs list/, { out: [] }],
  ];
  const deny = fakeExec([[/^gcloud sql instances list/, { code: 1, err: "ERROR: (gcloud.sql.instances.list) PERMISSION_DENIED: The caller does not have permission" }], ...base]);
  await assert.rejects(discoverGcp({ exec: deny.exec, env: { GCP_PROJECT: "p" } }), (e: { code?: string; message: string }) => e.code === "SOURCE_UNAVAILABLE" && /Cloud SQL/.test(e.message));
  const off = fakeExec([[/^gcloud sql instances list/, { code: 1, err: "ERROR: SERVICE_DISABLED: Cloud SQL Admin API has not been used in project p" }], ...base]);
  const inv = await discoverGcp({ exec: off.exec, env: { GCP_PROJECT: "p" } });
  assert.ok(inv.items.some((i) => /Cloud SQL API 가 꺼진/.test(String((i as { text?: string }).text))));
});

test("RF-3: GKE 이름이 두 location 에 있으면 아무거나 안 고르고 멈춤, location/이름 이면 그것", async () => {
  const two = [{ name: "gke", location: "asia-northeast3" }, { name: "gke", location: "us-central1" }];
  const { exec } = fakeExec([[/^gcloud projects describe/, { out: {} }], [/^gcloud container clusters list/, { out: two }]]);
  await assert.rejects(discoverGcp({ exec, env: { GCP_PROJECT: "p", IMPORT_GCP_GKE_CLUSTER: "gke" } }), /여러 location/);
  const ok = fakeExec([[/^gcloud projects describe/, { out: {} }], [/^gcloud container clusters list/, { out: two }],
    [/^gcloud container clusters get-credentials gke --location us-central1/, { code: 1, err: "stop here" }]]);
  await assert.rejects(discoverGcp({ exec: ok.exec, env: { GCP_PROJECT: "p", IMPORT_GCP_GKE_CLUSTER: "us-central1/gke" } }), /GKE gke kubeconfig/);
});

test("RF-1: CNPG 목록 권한 거부 → DB 없음이 아니라 SOURCE_UNAVAILABLE / 안 깔림 → DB 없이 계속", async () => {
  const deny = fakeExec(onpremApp([[/^kubectl get clusters.postgresql.cnpg.io/, { code: 1, err: "Error from server (Forbidden): clusters.postgresql.cnpg.io is forbidden" }]]));
  await assert.rejects(discoverOnprem({ exec: deny.exec, env: {} }), (e: { code?: string }) => e.code === "SOURCE_UNAVAILABLE");
  const none = fakeExec(onpremApp([[/^kubectl get clusters.postgresql.cnpg.io/, { code: 1, err: "error: the server doesn't have a resource type \"clusters\"" }]]));
  const inv = await discoverOnprem({ exec: none.exec, env: {} });
  assert.ok(!inv.items.some((i) => (i as { kind: string }).kind === "cnpg.cluster"));
});

test("RF-3: Deployment 없이 CronJob 만 있는 네임스페이스도 자동으로 고른다", async () => {
  const cron = { metadata: { name: "nightly", namespace: "batch" }, spec: { schedule: "0 3 * * *", jobTemplate: { spec: { template: { spec: { containers: [{ name: "c", image: `c@${DIGEST("c")}` }] } } } } } };
  const { exec } = fakeExec([[/^kubectl get deployments -A/, { out: { items: [] } }], [/^kubectl get cronjobs -A/, { out: { items: [cron] } }],
    [/^kubectl get cronjobs -n batch/, { out: { items: [cron] } }]]);
  const r = await readK8sNamespace({ exec, env: {} }, []);
  assert.equal(r.namespace, "batch");
  const none = fakeExec([[/^kubectl get deployments -A/, { out: { items: [] } }], [/^kubectl get cronjobs -A/, { out: { items: [] } }]]);
  await assert.rejects(readK8sNamespace({ exec: none.exec, env: {} }, []), (e: { code?: string }) => e.code === "SOURCE_INCOMPLETE");
});

test("RF-3: IRSA 역할이 다른 계정이면 이름만으로 우리 계정 역할 정책을 읽지 않는다", async () => {
  const { exec, calls } = fakeExec([[/^aws eks list-pod-identity-associations/, { out: { associations: [] } }],
    [/^aws iam list-attached-role-policies/, { out: { AttachedPolicies: [] } }], [/^aws iam list-role-policies/, { out: { PolicyNames: [] } }]]);
  const notes: string[] = [];
  const ids = [{ namespace: "shop", serviceAccount: "a", irsaRoleArn: "arn:aws:iam::999988887777:role/app" },
    { namespace: "shop", serviceAccount: "b", irsaRoleArn: "arn:aws:iam::111122223333:role/mine" }];
  const out = await readAwsIam({ exec, env: {} }, [], "c", ids, notes, "111122223333");
  assert.deepEqual(out.map((x) => x.roleName), ["mine"]);
  assert.ok(!calls.some((c) => c.includes("--role-name app")));
  assert.ok(notes.some((n) => /다른 계정/.test(n) && !n.includes("999988887777")));
});
