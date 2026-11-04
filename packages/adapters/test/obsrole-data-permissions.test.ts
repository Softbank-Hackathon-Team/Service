// OBSROLE: 데이터 자원 읽기(S3·SQS·ElastiCache / GCS·Pub/Sub·Memorystore)에 필요한 관찰 권한이
//   (1) discover/data.ts 가 실제로 부르는 명령과 맞고 (2) AWS 관찰 역할 템플릿·GCP 연결 스크립트에 들어 있고 (3) 객체·메시지 내용 읽기는 없음을 고정한다. 클라우드 호출 0
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { AWS_DATA_READ_ACTIONS, GCP_DATA_READ_PERMISSIONS, AWS_DATA_READ_PENDING, GCP_DATA_READ_PENDING } from "../src/index.js";
import { OBSERVE_EXTRA_ACTIONS } from "../scripts/aws-connect-template.js";

const dataSrc = readFileSync(new URL("../src/discover/data.ts", import.meta.url), "utf8");
const tpl = JSON.parse(readFileSync(new URL("../../../infra/onboarding/aws-connect.json", import.meta.url), "utf8"));
const sh = readFileSync(new URL("../../../infra/onboarding/gcp-connect.sh", import.meta.url), "utf8");
const FORBIDDEN = [/^s3:GetObject/, /^s3:ListBucket$/, /^s3:GetBucketPolicy$/, /^sqs:(Receive|Send|Purge|Delete)/, /^elasticache:(Connect|Modify|Create|Delete)/,
  /^storage\.objects\./, /^pubsub\.(topics|subscriptions)\.(publish|consume|update|create|delete)/, /^redis\.instances\.(update|create|delete|export|import)/];

// aws CLI 호출 → IAM 동작 이름. CLI 이름과 IAM 동작 이름이 다른 것만 표로 둔다
const AWS_IAM_NAME: Record<string, string> = {
  "s3api list-buckets": "s3:ListAllMyBuckets",
  "s3api get-bucket-lifecycle-configuration": "s3:GetLifecycleConfiguration",
  "s3api get-bucket-cors": "s3:GetBucketCORS",
  "s3api get-public-access-block": "s3:GetBucketPublicAccessBlock",   // CLI 이름과 IAM 동작 이름이 다름
  "cloudwatch get-metric-statistics": "cloudwatch:GetMetricStatistics",
  "s3api get-bucket-notification-configuration": "s3:GetBucketNotification",
};
const camel = (s: string) => s.split("-").map((p) => p[0]!.toUpperCase() + p.slice(1)).join("");
const SVC: Record<string, string> = { s3api: "s3", sqs: "sqs", elasticache: "elasticache", cloudwatch: "cloudwatch", sns: "sns" };
const GCP_PERM: Record<string, string> = {
  "storage buckets list": "storage.buckets.list", "storage buckets get-iam-policy": "storage.buckets.getIamPolicy",
  "pubsub topics list": "pubsub.topics.list", "pubsub subscriptions list": "pubsub.subscriptions.list", "redis instances list": "redis.instances.list",
  "storage buckets notifications": "storage.buckets.get",
};

test("data.ts 가 부르는 aws 읽기 명령 = AWS_DATA_READ_ACTIONS (빠진 권한도 남는 권한도 없음)", () => {
  const used = new Set<string>();
  for (const m of dataSrc.matchAll(/runJson\(d, "aws", \["([a-z0-9]+)", "([a-z0-9-]+)"/g)) {
    const key = `${m[1]} ${m[2]}`;
    used.add(AWS_IAM_NAME[key] ?? `${SVC[m[1]!]}:${camel(m[2]!)}`);
  }
  assert.ok(used.size >= 10, [...used].join());
  // TODO(human): B-1b·B-2 읽기 권한(AWS_DATA_READ_PENDING)은 관찰 역할 템플릿에 아직 없음. 넣을지 정하면 ACTIONS 로 옮김. 그전엔 못 읽음 검토 줄
  assert.deepEqual([...used].sort(), [...AWS_DATA_READ_ACTIONS, ...AWS_DATA_READ_PENDING].sort());
});

test("data.ts 가 부르는 gcloud 읽기 명령 = GCP_DATA_READ_PERMISSIONS", () => {
  const used = new Set<string>();
  for (const m of dataSrc.matchAll(/runJson\(d, "gcloud", \["([a-z]+)", "([a-z]+)", "([a-z-]+)"/g)) {
    const p = GCP_PERM[`${m[1]} ${m[2]} ${m[3]}`];
    assert.ok(p, `표에 없는 gcloud 명령: ${m[0]}`);
    used.add(p!);
  }
  assert.deepEqual([...used].sort(), [...new Set([...GCP_DATA_READ_PERMISSIONS, ...GCP_DATA_READ_PENDING])].sort());   // TODO(human): PENDING 은 위 AWS 와 같음
});

test("AWS 관찰 역할 템플릿: 데이터 읽기 13개(DM-8 ListMetrics)가 인라인에 있고, 객체·메시지·정책 본문 읽기와 쓰기는 0", () => {
  const actions: string[] = tpl.Resources.ObserveRole.Properties.Policies[0].PolicyDocument.Statement.flatMap((s: { Action: string[] }) => s.Action);
  assert.equal(AWS_DATA_READ_ACTIONS.length, 13);
  for (const a of AWS_DATA_READ_ACTIONS) assert.ok(actions.includes(a), `템플릿에 없음: ${a}`);
  for (const a of actions) {
    assert.ok(!FORBIDDEN.some((r) => r.test(a)), `금지 동작 ${a}`);
    assert.match(a, /:(Describe|Get|List)/, `읽기 아님 ${a}`);
    assert.ok(!a.includes("*"), `와일드카드 ${a}`);
  }
  assert.equal(new Set(actions).size, actions.length, "중복 동작");
  assert.deepEqual(actions, OBSERVE_EXTRA_ACTIONS);   // 생성기와 파일이 같음 (재생성 안 해서 어긋나지 않음)
  assert.deepEqual(tpl.Resources.ObserveRole.Properties.ManagedPolicyArns, ["arn:aws:iam::aws:policy/job-function/ViewOnlyAccess"]);
});

test("GCP 연결 스크립트: 관찰 역할 --permissions 에 데이터 읽기 5개가 들어가고 객체·메시지 권한과 쓰기는 0 (DRY_RUN 출력)", () => {
  const SA = "t-" + "0123456789abcdef0123456789ab" + "@platform-prj.iam.gserviceaccount.com";
  const out = spawnSync("bash", [new URL("../../../infra/onboarding/gcp-connect.sh", import.meta.url).pathname], {
    env: { PATH: process.env.PATH, PLATFORM_SA: SA, PROJECT_ID: "cust-prj", TARGET_PROJECT_ID: "cust-mig", DRY_RUN: "1" }, encoding: "utf8" }).stdout;
  const line = out.split("\n").find((l) => l.includes("roles create platform_observe"));
  assert.ok(line, out);
  const perms = /--permissions=(\S+)/.exec(line!)![1]!.replace(/^["']|["']$/g, "").split(",");
  for (const p of GCP_DATA_READ_PERMISSIONS) assert.ok(perms.includes(p), `없음: ${p}`);
  for (const p of perms) {
    assert.ok(!FORBIDDEN.some((r) => r.test(p)), `금지 권한 ${p}`);
    assert.match(p, /\.(get|list|getIamPolicy)$/, `읽기 아님 ${p}`);
  }
  assert.equal(new Set(perms).size, perms.length, "중복 권한");
  assert.match(sh, /OBSROLE/);
});
