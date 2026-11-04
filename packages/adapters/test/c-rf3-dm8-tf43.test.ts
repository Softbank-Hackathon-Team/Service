// 38번 남은 칸: RF-3(ECS 작업 역할 IAM·다른 지역 Scheduler), DM-8(S3 크기 저장 등급 합), TF4-3(netpol 계약·ECS/VM 안 쓰는 칸 경고). 클라우드 CLI 는 가짜 exec
import { test } from "node:test";
import assert from "node:assert/strict";
import { NetpolTfVars, TF_KIND_VARS, type TargetEnv } from "@svc/contracts";
import { readEcsTaskIam } from "../src/discover/aws-iam.js";
import { readAwsData } from "../src/discover/data.js";
import { inferLinks } from "../src/import/links.js";
import { s3Mapper } from "../src/import/mappers/s3.js";
import type { RawAwsIamPolicy } from "../src/import/mappers/iam-grants.js";
import type { MappedComponent } from "../src/import/types.js";
import { readCloudRun, schedJobRegion } from "../src/import/readers/gcp-cloudrun.js";
import { managedWarnings } from "../src/target/managed.js";
import { DEMO_INVENTORY, normalizeV2, targetBuilderFor } from "../src/index.js";
import type { Exec } from "../src/terraform/real-runner.js";

type Reply = { code?: number; out?: unknown; err?: string };
function fakeExec(table: Array<[RegExp, Reply]>) {
  const calls: string[] = [];
  const exec: Exec = async (cmd, args) => {
    const line = `${cmd} ${args.join(" ")}`; calls.push(line);
    const hit = table.find(([re]) => re.test(line));
    if (!hit) return { code: 1, stdout: "", stderr: `no fake for: ${line}`, ms: 1 };
    return { code: hit[1].code ?? 0, stdout: JSON.stringify(hit[1].out ?? null), stderr: hit[1].err ?? "", ms: 1 };
  };
  return { exec, calls };
}

const ACC = "123456789012";
const ecs = (name: string, roleArn: string | null) => ({ kind: "ecs.service", serviceName: name, taskDefinition: { family: name, ...(roleArn ? { taskRoleArn: roleArn } : {}), containerDefinitions: [] } });

test("RF-3: ECS 작업 역할 정책을 읽어 같은 역할 이름을 쓰는 ECS 서비스에만 붙임, 다른 계정 역할은 안 읽음", async () => {
  const { exec, calls } = fakeExec([
    [/list-attached-role-policies --role-name shop-api-task/, { out: { AttachedPolicies: [] } }],
    [/list-role-policies --role-name shop-api-task/, { out: { PolicyNames: ["s3"] } }],
    [/get-role-policy --role-name shop-api-task --policy-name s3/, { out: { PolicyDocument: { Statement: [{ Effect: "Allow", Action: ["s3:GetObject"], Resource: ["arn:aws:s3:::shop-assets/*"] }] } } }],
  ]);
  const notes: string[] = [];
  const got = await readEcsTaskIam({ exec, env: {} }, [ecs("shop-api", `arn:aws:iam::${ACC}:role/shop-api-task`), ecs("shop-x", "arn:aws:iam::999999999999:role/x-task"), ecs("shop-n", null)] as never, notes, ACC);
  assert.deepEqual(got.map((p) => [p.roleName, p.serviceAccount, p.source, p.namespace]), [["shop-api-task", "shop-api-task", "ecs-task", undefined]]);
  assert.ok(notes.some((n) => /x-task 은 다른 계정/.test(n)), notes.join("\n"));
  assert.ok(!calls.some((c) => /x-task/.test(c)), "다른 계정 역할은 이름으로 안 부름");

  const svc = (id: string, type: string, ns?: string): MappedComponent => ({ id, name: id, kind: "service", props: { serviceAccount: "shop-api-task", env: [] }, meta: {},
    native: { type, name: id, ...(ns ? { namespace: ns } : {}) } });
  const bucket: MappedComponent = { id: "shop-assets", name: "shop-assets", kind: "objectStore", props: {}, meta: {}, native: { type: "s3.bucket", name: "shop-assets", endpoint: "shop-assets" } };
  const out = inferLinks([svc("shop-api", "ecs.service"), svc("k8s-api", "k8s.deployment", "shop"), bucket], [], got as RawAwsIamPolicy[]);
  assert.deepEqual(out.links.map((l) => `${l.from}->${String(l.to)}:${l.intent}`), ["shop-api->shop-assets:read"], "k8s 워크로드는 SA 이름이 같아도 안 붙음");
});

test("RF-3 거부: 네임스페이스 없는 k8s 정책은 여전히 아무 데도 안 붙고, ECS 역할을 쓰는 서비스가 없으면 이전 대상 밖", () => {
  const svc: MappedComponent = { id: "a", name: "a", kind: "service", props: { serviceAccount: "r", env: [] }, meta: {}, native: { type: "ecs.service", name: "a" } };
  const out = inferLinks([svc], [], [
    { kind: "aws.iamPolicy", roleName: "r", serviceAccount: "r", source: "irsa", statements: [] },
    { kind: "aws.iamPolicy", roleName: "other", serviceAccount: "other", source: "ecs-task", statements: [] },
  ]);
  assert.deepEqual(out.unmapped.map((u) => u.reason).sort(), ["ECS 작업 역할 other 를 쓰는 워크로드가 없음 → 이전 대상 밖 신원", "신원의 네임스페이스를 모름 → 어느 서비스 권한인지 사람이 확인"]);
});

test("RF-3: 다른 지역 Scheduler 가 부르는 Cloud Run 잡도 일정을 찾음 (URI 의 잡 지역으로 열쇠), 지역을 안 주면 예전처럼 같은 지역만", async () => {
  assert.equal(schedJobRegion("https://asia-northeast3-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/p/jobs/nightly:run"), "asia-northeast3");
  assert.equal(schedJobRegion("https://run.googleapis.com/v2/projects/p/locations/us-central1/jobs/nightly:run"), "us-central1");
  assert.equal(schedJobRegion("https://example.com/x"), null);
  const job = { metadata: { name: "nightly", labels: { "cloud.googleapis.com/location": "asia-northeast3" } },
    spec: { template: { spec: { template: { spec: { containers: [{ image: "r/x@sha256:" + "c".repeat(64) }] } } } } } };
  const table: Array<[RegExp, Reply]> = [
    [/^gcloud run services list/, { out: [] }],
    [/^gcloud run jobs list/, { out: [job] }],
    [/^gcloud scheduler jobs list --location asia-northeast3/, { out: [] }],
    [/^gcloud scheduler jobs list --location us-central1/, { out: [{ name: "projects/p/locations/us-central1/jobs/t", schedule: "0 3 * * *", timeZone: "UTC", state: "ENABLED",
      httpTarget: { uri: "https://asia-northeast3-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/p/jobs/nightly:run" } }] }],
  ];
  const a = await readCloudRun({ exec: fakeExec(table).exec, env: {} }, "p", { IMPORT_GCP_SCHEDULER_REGIONS: "us-central1" });
  assert.deepEqual((a.items.find((i) => i.kind === "cloudrun.job") as Record<string, unknown>).schedule, { cron: "0 3 * * *", timeZone: "UTC", paused: false });
  const b = await readCloudRun({ exec: fakeExec(table).exec, env: {} }, "p", {});
  assert.equal((b.items.find((i) => i.kind === "cloudrun.job") as Record<string, unknown>).schedule, null);
});

const s3Table = (extra: Array<[RegExp, Reply]>): Array<[RegExp, Reply]> => [
  [/^aws s3api list-buckets/, { out: { Buckets: [{ Name: "shop-assets" }] } }],
  [/get-bucket-versioning/, { out: { Status: "Enabled" } }],
  [/get-public-access-block/, { code: 254, err: "NoSuchPublicAccessBlockConfiguration" }],
  [/get-bucket-policy-status/, { code: 254, err: "NoSuchBucketPolicy" }],
  [/get-bucket-acl/, { out: { Grants: [] } }],
  [/get-bucket-lifecycle-configuration/, { code: 254, err: "NoSuchLifecycleConfiguration" }],
  [/get-bucket-cors/, { code: 254, err: "NoSuchCORSConfiguration" }],
  ...extra,
  [/StorageType,Value=StandardStorage/, { out: { Datapoints: [{ Timestamp: "2026-11-01T00:00:00Z", Average: 1073741824 }] } }],
  [/StorageType,Value=GlacierStorage/, { out: { Datapoints: [{ Timestamp: "2026-11-01T00:00:00Z", Average: 2147483648 }] } }],
  [/^aws sqs list-queues/, { out: { QueueUrls: [] } }],
  [/^aws elasticache describe-replication-groups/, { out: { ReplicationGroups: [] } }],
];
const sizeOf = (items: Array<Record<string, unknown>>) => items.find((i) => i.kind === "s3.bucket")!;

test("DM-8: S3 크기 = 버킷에 있는 저장 등급 전부 합 (Standard 1GiB + Glacier 2GiB = 3GiB), 근거에 등급 이름", async () => {
  const { exec, calls } = fakeExec(s3Table([[/cloudwatch list-metrics/, { out: { Metrics: [
    { Dimensions: [{ Name: "BucketName", Value: "shop-assets" }, { Name: "StorageType", Value: "StandardStorage" }] },
    { Dimensions: [{ Name: "StorageType", Value: "GlacierStorage" }, { Name: "BucketName", Value: "shop-assets" }] }] } }]]));
  const b = sizeOf(await readAwsData({ exec, env: {} }, "ap-northeast-1", [], new Date("2026-11-03T00:00:00Z")) as never);
  assert.equal(b.SizeBytes, 3 * 1024 ** 3);
  assert.deepEqual(b.SizeStorageTypes, ["GlacierStorage", "StandardStorage"]);
  assert.ok(calls.every((c) => !/s3api get-object|s3 cp/.test(c)));
  const m = s3Mapper.map(b as never) as MappedComponent;
  assert.equal(m.props.sizeGb, 3);
  assert.deepEqual(m.meta.sizeGb, ["s3:shop-assets.BucketSizeBytes", 0.9, "CloudWatch 하루 1번 값 (등급 GlacierStorage·StandardStorage 합)"]);
});

test("DM-8 거부: 등급 목록을 못 읽으면(ListMetrics 거부) Standard 만 세고 검토 표시 — 확신하지 않음", async () => {
  const { exec } = fakeExec(s3Table([[/cloudwatch list-metrics/, { code: 254, err: "AccessDenied: not authorized to perform cloudwatch:ListMetrics" }]]));
  const b = sizeOf(await readAwsData({ exec, env: {} }, "ap-northeast-1", [], new Date("2026-11-03T00:00:00Z")) as never);
  assert.equal(b.SizeBytes, 1024 ** 3);
  assert.equal(b.SizeStorageTypes, null);
  const m = s3Mapper.map(b as never) as MappedComponent;
  assert.equal(m.meta.sizeGb![1], 0.6);
  assert.match(String(m.meta.sizeGb![2]), /StandardStorage 만 셈/);
});

const T = (p: TargetEnv["provider"]) => ({ envId: "33333333-3333-4333-8333-333333333333", provider: p, region: "local", migrationId: "44444444-4444-4444-8444-444444444444" }) as TargetEnv;

test("TF4-3: 온프레 netpol_json 이 계약(NetpolTfVars)을 거침, 모르는 칸·잘못된 id 는 거부", () => {
  assert.equal(TF_KIND_VARS.netpol, NetpolTfVars);
  assert.deepEqual(NetpolTfVars.parse({ id: "default", allow_namespaces_json: "[\"cnpg-system\"]" }), { id: "default", allow_namespaces_json: "[\"cnpg-system\"]" });
  assert.throws(() => NetpolTfVars.parse({ id: "Default", allow_namespaces_json: "[]" }));
  assert.throws(() => NetpolTfVars.parse({ id: "default", allow_namespaces_json: "[]", extra: 1 }));
  const spec = normalizeV2(DEMO_INVENTORY.onprem).result.spec;
  assert.equal(targetBuilderFor("onprem").toTerraformV2(spec, T("onprem")).vars.netpol_json, "[]");
});

test("TF4-3: ECS 는 준비 확인 http 경로·입구 공개를 안 씀 → 경고, Cloud Run 은 씀 → 그 경고 없음", () => {
  const spec = normalizeV2(DEMO_INVENTORY.aws).result.spec;
  const aws = managedWarnings("aws", spec);
  assert.ok(aws.some((m) => /shop-web: 준비 확인 http \/healthz 는 ECS 모듈이 아직 안 씀/.test(m)), aws.join("\n"));
  assert.ok(aws.some((m) => /shop-web: 입구 대상\(public\)이지만 ECS 모듈/.test(m)));
  assert.ok(!managedWarnings("gcp", spec).some((m) => /모듈이 아직 안 씀|공개 설정/.test(m)));
});
