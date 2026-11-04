// VA8fix: 권한 경계 검증. app- 아닌 이름 거부, 프로젝트 단위 권한 0, 경고 조건, 생성 템플릿 재생성 일치, 경계 ⇔ 계획 일치
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppSpecV2, ComponentV2, type TargetEnv } from "@svc/contracts";
import { aws, v2PrecheckItems, type Target } from "../src/index.js";
import { BOUNDARY_GRANT_ACTIONS } from "../src/aws/index.js";
import { awsGrantPlan, grantWarnings, insideBoundary, gcpGrantTypes } from "../src/target/grants.js";
import { objectStoreVars, queueVars } from "../src/target/data.js";
import { TIER3 } from "./va8-fixture.js";

const root = join(import.meta.dirname, "../../..");
const T = (p: TargetEnv["provider"]): Target =>
  ({ envId: "33333333-3333-4333-8333-333333333333", provider: p, region: "default", tenantId: "11111111-1111-4111-8111-111111111111", migrationId: "22222222-2222-4222-8222-222222222222" }) as Target;
const G = (actions: string[], resources: string[] = ["*"]) => ({ effect: "Allow" as const, actions, resources });
const build = (links: Array<Record<string, unknown>>, perms: Array<Record<string, unknown>> = [], ids: { bucket?: string; queue?: string } = {}): AppSpecV2 => {
  const s = TIER3();
  s.components.push(ComponentV2.parse({ id: ids.bucket ?? "uploads", kind: "objectStore", props: { versioning: true, public: false, sizeGb: 1 } }),
    ComponentV2.parse({ id: ids.queue ?? "orders", kind: "queue", props: { model: "queue" } }));
  s.links.push(...(links as never[]));
  s.posture.permissions.push(...(perms as never[]));
  return AppSpecV2.parse(s);
};
const bucketLink = (acts: string[], to = "uploads") => ({ from: "api", to, intent: "readwrite", grants: [G(acts)] });
const queueLink = (acts: string[], to = "orders") => ({ from: "api", to, intent: "readwrite", grants: [G(acts)] });
const boundaryWarn = (s: AppSpecV2) => grantWarnings("aws", s).filter((w) => /권한 경계/.test(w));

test("경계가 허용하는 자원 이름은 실제로 만드는 이름과 맞는다: 버킷·큐 이름이 항상 app- 로 시작 (금지어 id 포함), 경계 Resource 는 app-* 뿐", () => {
  const s = build([], [], { bucket: "google", queue: "orders" });
  for (const id of ["sthree", "goog-cache", "x".repeat(40)])
    s.components.push(ComponentV2.parse({ id, kind: "objectStore", props: { versioning: false, public: false, sizeGb: 1 } }) as never);
  s.components.push(ComponentV2.parse({ id: "q".repeat(40), kind: "queue", props: { model: "queue" } }) as never);
  for (const p of ["aws", "gcp"] as const) {
    const names = [...(JSON.parse(objectStoreVars(s, T(p))) as Array<{ name: string }>), ...(JSON.parse(queueVars(s, T(p))) as Array<{ name: string }>)].map((x) => x.name);
    assert.equal(names.length, 6, p);
    for (const n of names) assert.match(n, /^app-/, `${p}: ${n}`);
    for (const n of names) assert.ok(!/^goog|google|^sthree-/.test(n), `${p}: 금지어 ${n}`);
  }
  const b = aws.appRoleBoundary("ap-northeast-2");
  const st = b.Statement.find((x) => x.Sid === "MigratedDataGrants")!;
  assert.deepEqual([...st.Resource].sort(), ["arn:aws:s3:::app-*", "arn:aws:s3:::app-*/*", "arn:aws:sqs:ap-northeast-2:*:app-*"].sort());
  // 지역은 인자를 따른다 (하드코딩 아님)
  assert.ok(aws.appRoleBoundary("us-east-1").Statement.find((x) => x.Sid === "MigratedDataGrants")!.Resource.includes("arn:aws:sqs:us-east-1:*:app-*"));
});

test("경계 ⇔ 계획: 경계가 허용하는 모든 동작은 안 = 경고 없음, 경계에 없는 동작은 밖 = 그 문장만 경고", () => {
  for (const a of BOUNDARY_GRANT_ACTIONS.s3) {
    const s = build([bucketLink([a])]);
    assert.equal(Object.values(awsGrantPlan(s).byIdentity).flat().every(insideBoundary), true, a);
    assert.deepEqual(boundaryWarn(s), [], a);
  }
  for (const a of BOUNDARY_GRANT_ACTIONS.sqs) assert.deepEqual(boundaryWarn(build([queueLink([a])])), [], a);
  const outside: Array<[string, (a: string) => ReturnType<typeof build>]> = [
    ["s3:GetObjectAcl", (a) => build([bucketLink([a])])], ["s3:PutBucketPolicy", (a) => build([bucketLink([a])])], ["s3:DeleteBucket", (a) => build([bucketLink([a])])],
    ["sqs:PurgeQueue", (a) => build([queueLink([a])])], ["sqs:SetQueueAttributes", (a) => build([queueLink([a])])], ["sqs:SendMessageBatch", (a) => build([queueLink([a])])],
  ];
  for (const [a, mk] of outside) {
    assert.ok(!(BOUNDARY_GRANT_ACTIONS.s3 as readonly string[]).includes(a) && !(BOUNDARY_GRANT_ACTIONS.sqs as readonly string[]).includes(a), `${a} 가 경계에 있음`);
    const w = boundaryWarn(mk(a));
    assert.equal(w.length, 1, a);
    assert.ok(w[0]!.includes(a), `${a}: 경고에 이름이 없음`);
  }
});

test("경고 조건: 안·밖 섞이면 밖 문장만 경고, Deny 만 있으면 경고 없음, 같은 문장이 안 → 밖으로 바뀌면(와일드카드 추가) 다시 경고", () => {
  const mixed = build([bucketLink(["s3:GetObject"]), queueLink(["sqs:PurgeQueue"])]);
  const w = boundaryWarn(mixed);
  assert.equal(w.length, 1);
  assert.match(w[0]!, /sqs:PurgeQueue → orders/);
  assert.doesNotMatch(w[0]!, /s3:GetObject/);
  const denyOnly = build([], [{ subject: "api", source: "iam:r", effect: "Deny", actions: ["s3:*"], resources: ["*"], mode: "mirror" }]);
  assert.deepEqual(boundaryWarn(denyOnly), []);
  assert.equal(boundaryWarn(build([bucketLink(["s3:GetObject", "s3:*"])])).length, 1);
  // 권한이 아예 없으면 경계 경고도 없음
  assert.deepEqual(grantWarnings("aws", build([])), []);
  // 같은 경고가 precheck 항목으로도 한 번만 나온다
  const items = v2PrecheckItems("aws", { specV2: mixed }).filter((i) => /권한 경계/.test(i.message));
  assert.equal(items.length, 1);
});

test("GCP 바인딩 종류: 버킷 권한만이면 버킷 종류만, 큐만이면 토픽·구독, 막힌 명세는 0", () => {
  assert.deepEqual(gcpGrantTypes(build([bucketLink(["s3:GetObject"])])), ["google_storage_bucket_iam_member"]);
  assert.deepEqual(gcpGrantTypes(build([queueLink(["sqs:SendMessage", "sqs:ReceiveMessage"])])), ["google_pubsub_subscription_iam_member", "google_pubsub_topic_iam_member"]);
  assert.deepEqual(gcpGrantTypes(build([bucketLink(["s3:GetObjectAcl"])])), [], "대응표 밖 → 막힘 → 종류 0");
  assert.deepEqual(gcpGrantTypes(build([])), []);
});

test("프로젝트 단위 setIamPolicy 0: 생성된 GCP 역할·조건 파일 어디에도 resourcemanager.projects/organizations setIamPolicy 가 없고, 자원 단위 setIamPolicy 는 조건부 역할에만 있다", () => {
  const dir = join(root, "infra/permissions");
  const gcpFiles = readdirSync(dir).filter((f) => f.startsWith("gcp-"));
  assert.ok(gcpFiles.length >= 3);
  for (const f of gcpFiles) assert.doesNotMatch(readFileSync(join(dir, f), "utf8"), /(resourcemanager\.(projects|organizations|folders)\.setIamPolicy|iam\.serviceAccounts\.setIamPolicy.*projects)/, f);
  const plain = readFileSync(join(dir, "gcp-operate-custom-role.yaml"), "utf8");
  assert.doesNotMatch(plain, /setIamPolicy/, "조건 없는 역할에 setIamPolicy 가 있음");
  const cond = readFileSync(join(dir, "gcp-operate-iam-custom-role.yaml"), "utf8");
  for (const p of ["storage.buckets.setIamPolicy", "pubsub.topics.setIamPolicy", "pubsub.subscriptions.setIamPolicy"]) assert.match(cond, new RegExp(p.replace(/\./g, "\\.")), p);
  const condition = JSON.stringify(JSON.parse(readFileSync(join(dir, "gcp-operate-iam-binding-condition.json"), "utf8")));
  for (const m of ["storage.googleapis.com/Bucket", "pubsub.googleapis.com/Topic", "pubsub.googleapis.com/Subscription"]) assert.ok(condition.includes(m), m);
  // 모든 조건 가지가 app- 로만 끝난다 (app- 없는 가지 = 전체 허용)
  const branches = condition.split("||");
  for (const b of branches) assert.match(b, /app-/, b);
});

test("생성 템플릿 재생성 일치: export-permissions 를 임시 폴더에 다시 돌리면 레포의 infra/permissions·onboarding 과 글자까지 같다", () => {
  const out = mkdtempSync(join(tmpdir(), "perm-")), on = mkdtempSync(join(tmpdir(), "onb-"));
  execFileSync(process.execPath, ["--import", "tsx", join(root, "packages/adapters/scripts/export-permissions.ts"), out, on], { cwd: root, stdio: "pipe" });
  for (const f of readdirSync(out)) assert.equal(readFileSync(join(out, f), "utf8"), readFileSync(join(root, "infra/permissions", f), "utf8"), `permissions/${f}`);
  for (const f of readdirSync(on)) assert.equal(readFileSync(join(on, f), "utf8"), readFileSync(join(root, "infra/onboarding", f), "utf8"), `onboarding/${f}`);
});
