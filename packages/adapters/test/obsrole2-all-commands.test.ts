// OBSROLE2: 플랫폼이 관찰 역할로 부르는 "모든" aws·gcloud 읽기 명령(discover·verify·precheck·security live)이 권한 표에 있고,
//   그 권한이 AWS 관찰 인라인 정책·GCP 연결 스크립트에 들어 있으며, 쓰기·비밀값·내용 읽기는 0임을 소스 대조로 고정한다. 클라우드 호출 0
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { AWS_COMMAND_ACTIONS, GCP_COMMAND_PERMISSIONS, actionsOfCommands } from "../src/index.js";

const root = new URL("../../../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, root), "utf8");
// 부르는 쪽 소스: adapters/src 아래 모든 .ts (새 읽기 파일이 생겨도 자동으로 잡힘. 표 파일 자신은 제외) + security live
function walk(dir: string): string[] {
  return readdirSync(new URL(dir, root), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(`${dir}${e.name}/`) : e.name.endsWith(".ts") && e.name !== "observe-permissions.ts" ? [`${dir}${e.name}`] : []);
}
const SOURCES = [...walk("packages/adapters/src/"), "packages/security/src/live/aws.ts", "packages/security/src/live/gcp.ts", "packages/security/src/live/exec.ts"];
const code = (p: string) => read(p).split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");

const PENDING_AWS = ["s3api get-bucket-notification-configuration", "sns list-topics", "sns list-subscriptions-by-topic"];
const PENDING_GCP = ["storage buckets notifications"];
/** 소스에서 부르는 명령 키 모음. aws: 서비스+동사 / gcloud: 동사 앞 단어들(옵션·이름 앞까지) */
function found(): { aws: Set<string>; gcp: Set<string> } {
  const aws = new Set<string>(), gcp = new Set<string>();
  const gcpKnown = Object.keys(GCP_COMMAND_PERMISSIONS);
  for (const p of SOURCES) {
    const c = code(p);
    for (const m of c.matchAll(/"aws",\s*\[\s*"([a-z0-9-]+)",\s*"([a-z0-9-]+)"/g)) aws.add(`${m[1]} ${m[2]}`);
    for (const m of c.matchAll(/\baws\(c,\s*\[\s*"([a-z0-9-]+)",\s*"([a-z0-9-]+)"/g)) aws.add(`${m[1]} ${m[2]}`);
    for (const m of c.matchAll(/usage:\s*\[\s*"([a-z0-9-]+)",\s*"([a-z0-9-]+)"/g)) aws.add(`${m[1]} ${m[2]}`);
    // gcloud: ["a","b","c" ...] 형태의 앞 3단어를 표의 키와 가장 긴 접두로 맞춘다
    for (const m of c.matchAll(/(?:"gcloud",|gcloud\(c,|\bgcloud\(.*?,)\s*\[\s*((?:"[a-z][a-z0-9-]*",?\s*){1,4})/g)) {
      const words = [...m[1]!.matchAll(/"([a-z][a-z0-9-]*)"/g)].map((x) => x[1]!);
      const key = gcpKnown.filter((k) => k.split(" ").every((w, i) => words[i] === w)).sort((a, b) => b.length - a.length)[0];
      gcp.add(key ?? words.slice(0, 3).join(" "));
    }
  }
  // security live: 허용 목록 표 두 개를 그대로 읽는다
  const ex = code("packages/security/src/live/exec.ts");
  const awsAllowed = /AWS_ALLOWED = new Set\(\[([\s\S]*?)\]\)/.exec(ex)![1]!;
  for (const m of awsAllowed.matchAll(/"([a-z0-9-]+ [a-z0-9-]+)"/g)) aws.add(m[1]!);
  const gAllowed = /GCLOUD_ALLOWED = \[([\s\S]*?)\n\];/.exec(ex)![1]!;
  for (const m of gAllowed.matchAll(/\[((?:"[a-z-]+",?\s*)+)\]/g)) gcp.add([...m[1]!.matchAll(/"([a-z-]+)"/g)].map((x) => x[1]).join(" "));
  // TODO(human): B-1b·B-2 읽기(AWS_DATA_READ_PENDING·GCP_DATA_READ_PENDING)는 관찰 역할에 넣을지 안 정함 → 표·템플릿 대조에서 뺌. 못 읽으면 "못 읽음" 검토 줄
  for (const k of PENDING_AWS) aws.delete(k);
  for (const k of PENDING_GCP) gcp.delete(k);
  return { aws, gcp };
}

test("소스가 부르는 모든 aws 명령이 권한 표에 있고, 표에 남는 쓸모없는 명령도 없음", () => {
  const { aws } = found();
  assert.ok(aws.size >= 25, [...aws].join());
  const missing = [...aws].filter((k) => !(k in AWS_COMMAND_ACTIONS));
  assert.deepEqual(missing, [], `표에 없는 aws 명령: ${missing.join(", ")}`);
  const stale = Object.keys(AWS_COMMAND_ACTIONS).filter((k) => !aws.has(k));
  assert.deepEqual(stale, [], `소스에서 안 부르는데 표에 있음: ${stale.join(", ")}`);
});

test("소스가 부르는 모든 gcloud 명령이 권한 표에 있고, 표에 남는 쓸모없는 명령도 없음", () => {
  const { gcp } = found();
  assert.ok(gcp.size >= 15, [...gcp].join());
  const missing = [...gcp].filter((k) => !(k in GCP_COMMAND_PERMISSIONS));
  assert.deepEqual(missing, [], `표에 없는 gcloud 명령: ${missing.join(", ")}`);
  const stale = Object.keys(GCP_COMMAND_PERMISSIONS).filter((k) => !gcp.has(k));
  assert.deepEqual(stale, [], `소스에서 안 부르는데 표에 있음: ${stale.join(", ")}`);
});

test("AWS 관찰 인라인 정책 = 표의 모든 동작을 포함, 읽기 동사만·와일드카드·중복 0", () => {
  const tpl = JSON.parse(read("infra/onboarding/aws-connect.json"));
  const actions: string[] = tpl.Resources.ObserveRole.Properties.Policies[0].PolicyDocument.Statement.flatMap((s: { Action: string[] }) => s.Action);
  const need = actionsOfCommands("aws", Object.keys(AWS_COMMAND_ACTIONS));
  const lacking = need.filter((a) => !actions.includes(a));
  assert.deepEqual(lacking, [], `관찰 역할에 없는 권한: ${lacking.join(", ")}`);
  assert.equal(new Set(actions).size, actions.length);
  for (const a of actions) { assert.match(a, /:(Describe|Get|List|BatchGet)/, a); assert.ok(!a.includes("*"), a); }
});

test("GCP 연결 스크립트의 관찰 역할 권한 = 표의 모든 권한을 포함, 읽기 접미사만·중복 0 (DRY_RUN 출력)", () => {
  const SA = "t-" + "0123456789abcdef0123456789ab" + "@platform-prj.iam.gserviceaccount.com";
  const out = spawnSync("bash", [new URL("infra/onboarding/gcp-connect.sh", root).pathname], {
    env: { PATH: process.env.PATH, PLATFORM_SA: SA, PROJECT_ID: "cust-prj", TARGET_PROJECT_ID: "cust-mig", DRY_RUN: "1" }, encoding: "utf8" }).stdout;
  const line = out.split("\n").find((l) => l.includes("roles create platform_observe"))!;
  const perms = /--permissions=(\S+)/.exec(line)![1]!.replace(/^["']|["']$/g, "").split(",");
  const need = actionsOfCommands("gcp", Object.keys(GCP_COMMAND_PERMISSIONS));
  const lacking = need.filter((p) => !perms.includes(p));
  assert.deepEqual(lacking, [], `관찰 역할에 없는 권한: ${lacking.join(", ")}`);
  assert.equal(new Set(perms).size, perms.length);
  for (const p of perms) assert.match(p, /\.(get|list|getIamPolicy)$/, p);
});

test("거부: 표 전체에 쓰기·비밀값·내용 읽기 권한이 하나도 없음 (표에 넣으면 이 시험이 깨짐)", () => {
  const FORBIDDEN = [/^secretsmanager:(GetSecretValue|BatchGetSecretValue|Put|Create|Delete|Update|Rotate)/, /^ssm:/, /^kms:/, /^s3:(GetObject|PutObject|DeleteObject|ListBucket$|GetBucketPolicy$)/,
    /^sqs:(Receive|Send|Purge|Delete|Set|Create)/, /^iam:(Create|Put|Delete|Attach|Detach|Update|PassRole|AssumeRole)/, /^eks:(Create|Delete|Update|Associate)/, /^rds:(Create|Modify|Delete)/,
    /^secretmanager\.versions\./, /^secretmanager\.secrets\.(create|update|delete|get)$/, /^storage\.objects\./, /^compute\.[a-z]+\.(create|delete|update|insert|setIamPolicy)/,
    /^iam\.serviceAccounts\.(actAs|create|delete|getAccessToken|signBlob|implicitDelegation)/, /^container\.[a-z]+\.(create|delete|update)/, /^sql\.[a-z]+\.(create|delete|update|export|import)/];
  const all = [...actionsOfCommands("aws", Object.keys(AWS_COMMAND_ACTIONS)), ...actionsOfCommands("gcp", Object.keys(GCP_COMMAND_PERMISSIONS))];
  assert.ok(all.length >= 50, String(all.length));
  for (const a of all) assert.ok(!FORBIDDEN.some((r) => r.test(a)), `금지 권한 ${a}`);
  assert.throws(() => actionsOfCommands("aws", ["s3api put-object"]), /표에 없는/);
});

test("소스 훑기가 실제로 읽기 파일을 다 잡음 (ECS 읽기·데이터·IAM·verify·precheck 가 목록에 있음)", () => {
  for (const f of ["import/readers/aws-ecs.ts", "discover/data.ts", "discover/aws-iam.ts", "discover/index.ts", "verify/aws.ts", "verify/gcp.ts", "precheck/cloud-precheck.ts"])
    assert.ok(SOURCES.includes(`packages/adapters/src/${f}`), f);
  assert.ok(found().aws.has("ecs list-clusters") && found().aws.has("application-autoscaling describe-scaling-policies"));
});

test("ECS 읽기 권한 목록(ECS_OBSERVE_ACTIONS)은 표와 같음 — 따로 적은 목록이 표에서 어긋나면 깨짐", async () => {
  const { ECS_OBSERVE_ACTIONS } = await import("../src/index.js");
  const fromTable = actionsOfCommands("aws", Object.keys(AWS_COMMAND_ACTIONS)).filter((a) => /^(ecs:|application-autoscaling:|elasticloadbalancing:Describe(TargetGroups|Listeners|Rules))/.test(a));
  assert.deepEqual([...ECS_OBSERVE_ACTIONS].sort(), fromTable.sort());
});
