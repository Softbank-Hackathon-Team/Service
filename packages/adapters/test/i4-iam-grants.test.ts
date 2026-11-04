// I4: AWS IAM 근거 → 의존성 grants + 보안 기준선. 순수 함수(inferLinks·normalizeV2) + 가짜 aws CLI 로 IAM 읽기
//   PoC verify-20-ir-v2 의 IAM 시험(:195·205·214·317·329·361)을 옮겼다. S3·SQS·캐시 매퍼는 I6 몫이라
//   그 대상은 매퍼 결과 모양(MappedComponent)을 직접 만들어 넣는다 (native.type = I6 DATA_RAW_KINDS 이름)
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkV2, ImportResultV2, type RawInventory } from "@svc/contracts";
import { inferLinks } from "../src/import/links.js";
import { normalizeV2 } from "../src/import/pipeline.js";
import { parseArn, type RawAwsIamPolicy } from "../src/import/mappers/iam-grants.js";
import type { MappedComponent } from "../src/import/types.js";
import { discoverAws } from "../src/discover/index.js";
import { appIdentities, readAwsIam, readGcpIam } from "../src/discover/aws-iam.js";
import type { Exec } from "../src/terraform/real-runner.js";

type Raw = Record<string, any>;
const NS = "shop";
const wl = (id: string, sa = id, ns = NS): MappedComponent => ({
  id, name: id, kind: "service", props: { serviceAccount: sa, env: [] }, meta: {}, native: { type: "k8s.deployment", name: id, namespace: ns },
});
const withEnv = (c: MappedComponent, env: Raw[]) => ({ ...c, props: { ...c.props, env } });
const bucket = (id: string): MappedComponent => ({ id, name: id, kind: "objectStore", props: {}, meta: {}, native: { type: "s3.bucket", name: id, endpoint: id } });
const queue = (id: string): MappedComponent => ({ id, name: id, kind: "queue", props: {}, meta: {}, native: { type: "sqs.queue", name: id } });
const cache = (id: string): MappedComponent => ({ id, name: id, kind: "cache", props: {}, meta: {}, native: { type: "elasticache.replicationGroup", name: id } });
const pol = (sa: string, statements: unknown, ns: string | undefined = NS, roleName = `${sa}-role`): RawAwsIamPolicy =>
  ({ kind: "aws.iamPolicy", roleName, serviceAccount: sa, ...(ns ? { namespace: ns } : {}), statements });
const run = (cs: MappedComponent[], ps: RawAwsIamPolicy[]) => inferLinks(cs, [], ps);
const L = (out: ReturnType<typeof run>) => Object.fromEntries(out.links.map((l) => [String(l.to), l]));

test("PoC 3티어: 버킷 Get·Put = readwrite + grants 원문(경로까지), 큐 Send = write, 계정 단위 동작은 기준선만", () => {
  const out = run([wl("shop-api"), wl("shop-worker"), bucket("shop-uploads"), queue("shop-orders")], [
    pol("shop-api", [{ Action: ["s3:GetObject", "s3:PutObject"], Resource: ["arn:aws:s3:::shop-uploads/*"] },
      { Action: ["sqs:SendMessage"], Resource: ["arn:aws:sqs:ap-northeast-1:000000000000:shop-orders"] },
      { Action: ["s3:ListAllMyBuckets"], Resource: ["*"] }]),
    pol("shop-worker", [{ Action: ["sqs:*"], Resource: ["arn:aws:sqs:ap-northeast-1:000000000000:shop-orders"] }]),
  ]);
  assert.deepEqual(out.links.map((l) => `${l.from}->${String(l.to)}:${l.intent}`),
    ["shop-api->shop-orders:write", "shop-api->shop-uploads:readwrite", "shop-worker->shop-orders:admin"]);
  const up = out.links.find((l) => l.to === "shop-uploads")!;
  assert.deepEqual(up.grants, [{ effect: "Allow", actions: ["s3:GetObject", "s3:PutObject"], resources: ["arn:aws:s3:::shop-uploads/*"] }]);
  assert.equal(out.meta["links.shop-api->shop-uploads"]!.confidence, 1);
  assert.equal(out.meta["links.shop-api->shop-uploads"]!.source, "iam:shop-api-role");
  assert.match(out.meta["links.shop-worker->shop-orders"]!.rationale!, /와일드카드 동작/);
  assert.deepEqual(out.permissions.map((p) => [p.subject, p.actions, p.resources]), [["shop-api", ["s3:ListAllMyBuckets"], ["*"]]]);
});

test("Deny·NotAction 은 의존성으로 안 바꾸고 기준선에 원문, Action·Resource 문자열 하나도 받는다 (PoC :195)", () => {
  const out = run([wl("api"), bucket("media")], [pol("api", [
    { Effect: "Deny", Action: "s3:*", Resource: "arn:aws:s3:::media/*" },
    { Action: "s3:GetObject", Resource: "arn:aws:s3:::media/*" },
    { NotAction: "s3:DeleteObject", Resource: "arn:aws:s3:::media/*" }])]);
  assert.deepEqual(out.links.map((l) => [l.to, l.intent]), [["media", "read"]]);
  const deny = out.permissions.find((p) => p.effect === "Deny")!;
  assert.deepEqual(deny.actions, ["s3:*"]);
  assert.match(deny.note!, /Deny/);
  const notAct = out.permissions.find((p) => p.notActions)!;
  assert.deepEqual(notAct.notActions, ["s3:DeleteObject"]);
  assert.equal(notAct.mode, "mirror");
});

test("같은 ServiceAccount 를 쓰는 워크로드 둘 다 권한을 받는다 (PoC :205)", () => {
  const out = run([wl("api", "shared"), wl("worker", "shared"), queue("jobs")],
    [pol("shared", [{ Action: ["sqs:SendMessage"], Resource: ["arn:aws:sqs:x:0:jobs"] }])]);
  assert.deepEqual(out.links.map((l) => `${l.from}->${String(l.to)}:${l.intent}`), ["api->jobs:write", "worker->jobs:write"]);
});

test("ARN 은 서비스까지 맞아야 한다 (SQS ARN 이 같은 이름 캐시로 안 감), 와일드카드 이름은 덮는 대상 표시 (PoC :214)", () => {
  const out = run([wl("api"), bucket("shop-a"), cache("jobs")], [pol("api", [
    { Action: ["sqs:SendMessage"], Resource: ["arn:aws:sqs:us-east-1:999999999999:jobs"] },
    { Action: ["s3:GetObject"], Resource: ["arn:aws:s3:::shop-*"] }])]);
  assert.deepEqual(out.links.map((l) => `${String(l.to)}:${l.intent}`), ["shop-a:read"]);
  assert.deepEqual(out.permissions.find((p) => p.resources[0] === "arn:aws:s3:::shop-*")!.covers, ["shop-a"]);
  assert.match(out.permissions.find((p) => p.resources[0]!.startsWith("arn:aws:sqs"))!.note!, /IR 밖 자원/);
});

test("권한 크기: * 문장은 이미 이어진 의존성에만 원문으로 붙고, 섞인 문장은 대상 서비스 동작만 (PoC :317)", () => {
  const out = run([withEnv(wl("api"), [{ name: "B", value: "bk.s3.amazonaws.com" }]), { ...bucket("bk"), native: { type: "s3.bucket", name: "bk", endpoint: "bk.s3.amazonaws.com" } }, queue("q"), bucket("other")],
    [pol("api", [{ Action: ["s3:GetObject"], Resource: ["*"] }, { Action: ["s3:PutObject", "sqs:SendMessage"], Resource: ["arn:aws:s3:::bk/*", "arn:aws:sqs:x:0:q"] }])]);
  const m = L(out);
  assert.equal(m.bk!.intent, "readwrite");                       // Get(*) + Put → 둘 다 출발에 있음
  assert.deepEqual(m.bk!.grants!.map((g) => g.actions), [["s3:GetObject"], ["s3:PutObject"]]);
  assert.equal(m.q!.intent, "write");
  assert.deepEqual(m.q!.grants![0]!.actions, ["sqs:SendMessage"]);
  assert.equal(m.other?.grants, undefined, "* 하나로 다른 버킷에 의존성을 만들지 않는다");
  assert.deepEqual(out.permissions.find((p) => p.resources.includes("*"))!.covers, ["bk", "other"]);
});

test("네임스페이스 없는 정책·쓰는 워크로드 없는 정책은 아무 데도 안 붙고 unmapped(B), 와일드카드 covers 는 자원마다 (PoC :329)", () => {
  const r1 = run([wl("api", "api", "team1"), bucket("bk")], [pol("api", [{ Action: "s3:*", Resource: "arn:aws:s3:::bk" }], undefined, "r"),
    pol("api", [{ Action: "s3:*", Resource: "arn:aws:s3:::bk" }], "shop", "r2")]);
  assert.equal(r1.links.filter((l) => l.grants).length, 0);
  assert.deepEqual(r1.unmapped.map((u) => [u.resource, u.grade]), [["aws.iamPolicy:r", "B"], ["aws.iamPolicy:r2", "B"]]);
  const r2 = run([wl("api"), bucket("shop-uploads"), bucket("logs-a")],
    [pol("api", [{ Action: ["s3:GetObject"], Resource: ["arn:aws:s3:::shop-uploads/*", "arn:aws:s3:::logs-*/*"] }])]);
  assert.deepEqual(r2.permissions[0]!.covers, ["logs-a"]);
});

test("조건 붙은 Allow: 의존성 신뢰도 0.9 + 기준선에도 같은 조건 (PoC :361)", () => {
  const cond = { StringEquals: { "aws:SourceVpce": "vpce-1" } };
  const out = run([wl("api"), bucket("bk")], [pol("api", [{ Action: ["s3:GetObject"], Resource: ["arn:aws:s3:::bk/*"], Condition: cond }])]);
  assert.deepEqual(out.permissions[0]!.conditions, cond);
  assert.equal(out.meta["links.api->bk"]!.confidence, 0.9);
  assert.equal(out.meta["links.api->bk"]!.needs_review, true);
  assert.deepEqual(L(out).bk!.grants![0]!.conditions, cond);
});

test("같은 입력이면 순서와 무관하게 같은 결과", () => {
  const cs = [wl("api"), wl("worker", "api"), bucket("bk"), queue("q")];
  const ps = [pol("api", [{ Action: ["s3:GetObject", "sqs:SendMessage"], Resource: ["arn:aws:s3:::bk/*", "arn:aws:sqs:x:0:q", "*"] }]),
    pol("worker", [{ Effect: "Deny", Action: "s3:DeleteObject", Resource: "*" }])];
  const a = run(cs, ps), b = run([...cs].reverse(), [...ps].reverse());
  assert.deepEqual(a.links, b.links);
  assert.deepEqual(a.permissions, b.permissions);
});

// ── normalizeV2 끝까지 (지금 있는 매퍼: k8s + RDS) ─────────────
const D = "sha256:" + "ef".repeat(32);
const dep = (name: string, env: Raw[] = []): Raw => ({
  kind: "k8s.deployment", imageDigest: D, metadata: { name, namespace: NS, labels: { app: name } },
  spec: { replicas: 1, selector: { matchLabels: { app: name } }, template: { metadata: { labels: { app: name } }, spec: { serviceAccountName: name, containers: [{
    name, image: `ghcr.io/demo/${name}:1.0`, ports: [{ containerPort: 8080 }], env }] } } },
});
const rds = { kind: "rds.dbInstance", DBInstanceIdentifier: "shop-db", Engine: "postgres", EngineVersion: "16.3", AllocatedStorage: 20,
  Endpoint: "shop-db.abc.ap-northeast-2.rds.amazonaws.com", DBInstanceArn: "arn:aws:rds:ap-northeast-2:000000000000:db:shop-db" };
const inv = (items: Raw[]): RawInventory => ({ provider: "aws", coverage: {}, items });

test("normalizeV2: IAM 정책이 없으면 지금과 글자 하나까지 같다 (깃발 off = 그대로)", () => {
  const items = [dep("shop-api", [{ name: "DB_HOST", value: rds.Endpoint }]), rds];
  const a = normalizeV2(inv(items)).result;
  const b = normalizeV2(inv([...items, { kind: "import.note", text: "x" }])).result;
  assert.deepEqual(a.spec, b.spec);
  assert.ok(a.spec.links.every((l) => l.grants === undefined));
  assert.deepEqual(a.spec.posture.permissions, []);
});

test("normalizeV2: RDS 관리 권한은 connect 의존성에 grants 로, rds-db:connect·Deny 는 기준선, Zod·checkV2 통과", () => {
  const items = [dep("shop-api", [{ name: "DB_HOST", value: rds.Endpoint }]), rds,
    pol("shop-api", [{ Action: ["rds:DescribeDBInstances", "rds:RebootDBInstance"], Resource: [rds.DBInstanceArn] },
      { Action: "rds-db:connect", Resource: "arn:aws:rds-db:ap-northeast-2:000000000000:dbuser:db-ABC/app" },
      { Effect: "Deny", Action: "rds:DeleteDBInstance", Resource: "*" }]) as unknown as Raw];
  const { result } = normalizeV2(inv(items));
  assert.equal(ImportResultV2.safeParse(result).success, true);
  assert.deepEqual(checkV2(result.spec).errors, []);
  const link = result.spec.links.find((l) => l.to === "shop-db")!;
  assert.equal(link.intent, "connect");
  assert.deepEqual(link.grants, [{ effect: "Allow", actions: ["rds:RebootDBInstance"], resources: [rds.DBInstanceArn] }]);   // Describe 는 계정 단위
  assert.match(result.fieldMeta["links.shop-api->shop-db"]!.source, /env:DB_HOST \+ iam:shop-api-role/);
  const perms = result.spec.posture.permissions.map((p) => `${p.effect}:${p.actions.join(",")}`);
  assert.deepEqual(perms.sort(), ["Allow:rds-db:connect", "Deny:rds:DeleteDBInstance"]);
});

test("parseArn: 서비스마다 이름 칸", () => {
  assert.deepEqual(parseArn("arn:aws:s3:::bk/a/*"), { service: "s3", name: "bk", path: "/a/*" });
  assert.equal(parseArn("arn:aws:sqs:r:0:q").name, "q");
  assert.equal(parseArn("arn:aws:rds:r:0:db:shop-db").name, "shop-db");
  assert.equal(parseArn("*").service, "*");
});

// ── 읽기 (가짜 aws CLI) ─────────────────────────────
type Reply = { code?: number; out?: unknown; err?: string };
function fakeExec(table: Array<[RegExp, Reply]>) {
  const calls: string[] = [];
  const exec: Exec = async (cmd, args) => {
    const line = `${cmd} ${args.join(" ")}`;
    calls.push(line);
    const hit = table.find(([re]) => re.test(line));
    if (!hit) return { code: 1, stdout: "", stderr: `no fake for: ${line}`, ms: 1 };
    return { code: hit[1].code ?? 0, stdout: JSON.stringify(hit[1].out ?? null), stderr: hit[1].err ?? "", ms: 1 };
  };
  return { exec, calls };
}
const R = ["--region", "ap-northeast-2", "--output", "json"];
const DOC = { Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: ["s3:GetObject"], Resource: ["arn:aws:s3:::bk/*"] }] };
const IAM_FAKES: Array<[RegExp, Reply]> = [
  [/^aws eks list-pod-identity-associations .*--namespace shop/, { out: { associations: [{ associationId: "a-2", serviceAccount: "other" }, { associationId: "a-1", serviceAccount: "shop-api" }] } }],
  [/^aws eks describe-pod-identity-association .*--association-id a-1/, { out: { association: { roleArn: "arn:aws:iam::000000000000:role/app/shop-api-role" } } }],
  [/^aws iam list-attached-role-policies --role-name shop-api-role/, { out: { AttachedPolicies: [{ PolicyArn: "arn:aws:iam::000000000000:policy/shop-s3" }] } }],
  [/^aws iam get-policy --policy-arn arn:aws:iam::000000000000:policy\/shop-s3/, { out: { Policy: { DefaultVersionId: "v3" } } }],
  [/^aws iam get-policy-version .*--version-id v3/, { out: { PolicyVersion: { Document: encodeURIComponent(JSON.stringify(DOC)) } } }],
  [/^aws iam list-role-policies --role-name shop-api-role/, { out: { PolicyNames: ["inline-sqs"] } }],
  [/^aws iam get-role-policy --role-name shop-api-role --policy-name inline-sqs/, { out: { PolicyDocument: { Statement: { Effect: "Allow", Action: "sqs:SendMessage", Resource: "arn:aws:sqs:r:0:q" } } } }],
  [/^aws iam list-attached-role-policies --role-name worker-irsa/, { out: { AttachedPolicies: [] } }],
  [/^aws iam list-role-policies --role-name worker-irsa/, { out: { PolicyNames: [] } }],
  // IB-1: 권한 경계 없는 역할 (get-role 에 PermissionsBoundary 칸 없음)
  [/^aws iam get-role --role-name (shop-api-role|worker-irsa) /, { out: { Role: { RoleName: "x" } } }],
];

test("IAM 읽기: Pod Identity → 역할 → 관리형(기본 판, URL 인코딩 문서)·인라인 정책, IRSA 는 SA 주석, list·get 만", async () => {
  const { exec, calls } = fakeExec(IAM_FAKES);
  const notes: string[] = [];
  const ids = appIdentities([dep("shop-api"), dep("worker"),
    { kind: "k8s.serviceAccount", metadata: { name: "worker", namespace: NS }, irsaRoleArn: "arn:aws:iam::000000000000:role/worker-irsa" }]);
  assert.deepEqual(ids.map((i) => `${i.serviceAccount}:${i.irsaRoleArn ?? "-"}`), ["shop-api:-", "worker:arn:aws:iam::000000000000:role/worker-irsa"]);
  const out = await readAwsIam({ exec, env: {} }, R, "prod", ids, notes);
  assert.deepEqual(out.map((p) => [p.roleName, p.serviceAccount, p.source]), [["shop-api-role", "shop-api", "pod-identity"], ["worker-irsa", "worker", "irsa"]]);
  assert.deepEqual(out[0]!.policies, ["arn:aws:iam::000000000000:policy/shop-s3", "inline:inline-sqs"]);
  assert.equal((out[0]!.statements as unknown[]).length, 2);
  assert.deepEqual(notes, []);
  assert.ok(calls.every((c) => /^aws (eks (list|describe)-|iam (list|get)-)/.test(c)), calls.join("\n"));
  assert.ok(!calls.some((c) => c.includes("a-2")), "앱이 안 쓰는 신원은 안 읽는다");
});

test("IAM 읽기: 정책 하나라도 못 읽으면 그 신원은 통째로 빼고 이유를 남긴다 (일부만 옮기면 출발보다 좁아짐)", async () => {
  const { exec } = fakeExec([[/^aws iam get-policy /, { code: 254, err: "AccessDenied" }], ...IAM_FAKES]);
  const notes: string[] = [];
  const out = await readAwsIam({ exec, env: {} }, R, "prod", [{ namespace: NS, serviceAccount: "shop-api" }], notes);
  assert.deepEqual(out, []);
  assert.ok(notes.some((n) => /shop-api-role 정책 못 읽음/.test(n)));
});

const awsBase = (k8sItems: Raw): Array<[RegExp, Reply]> => [
  [/^aws sts get-caller-identity/, { out: { Account: "000000000000" } }],
  [/^aws eks list-clusters/, { out: { clusters: ["prod"] } }],
  [/^aws eks describe-cluster/, { out: { cluster: { version: "1.31", resourcesVpcConfig: { vpcId: "vpc-1" } } } }],
  [/^aws eks update-kubeconfig/, { out: "" }],
  [/^kubectl get deployments/, { out: { items: [k8sItems] } }],
  [/^kubectl get /, { out: { items: [] } }],
  [/^aws rds describe-db-instances/, { out: { DBInstances: [] } }],
  [/^aws (ec2|elbv2|ecr|secretsmanager) /, { out: {} }],
];
const k8sDep = { kind: "Deployment", metadata: { name: "shop-api", namespace: NS }, spec: { replicas: 1, selector: { matchLabels: { app: "a" } },
  template: { metadata: { labels: { app: "a" } }, spec: { serviceAccountName: "shop-api", containers: [{ name: "a", image: `x@${D}` }] } } } };

test("discoverAws: iam 옵션 off(기본)면 IAM 명령 0번, on 이면 aws.iamPolicy 항목", async () => {
  const off = fakeExec([...awsBase(k8sDep), ...IAM_FAKES]);
  const a = await discoverAws({ exec: off.exec, env: {} }, {});
  assert.ok(!off.calls.some((c) => / iam |pod-identity/.test(c)));
  assert.ok(!(a.items as Raw[]).some((i) => i.kind === "aws.iamPolicy"));
  const on = fakeExec([...awsBase(k8sDep), ...IAM_FAKES]);
  const b = await discoverAws({ exec: on.exec, env: {} }, { iam: true });
  const p = (b.items as Raw[]).filter((i) => i.kind === "aws.iamPolicy");
  assert.deepEqual(p.map((x) => x.roleName), ["shop-api-role"]);
});

// ID-5: 못 읽은 신원은 "권한 없음"이 아니라 "못 읽음" 검토 줄
test("ID-5: 역할 정책을 못 읽으면 unread 항목 → unread.IAM.<ns>/<sa> 검토 줄 (source aws:iam)", async () => {
  const { exec } = fakeExec([[/^aws iam get-policy /, { code: 254, err: "AccessDenied" }], ...IAM_FAKES]);
  const notes: string[] = [], unread: Raw[] = [];
  await readAwsIam({ exec, env: {} }, R, "prod", [{ namespace: NS, serviceAccount: "shop-api" }], notes, null, unread);
  assert.deepEqual(unread.map((u) => [u.kind, u.resource, u.source]), [["k8s.unread", `IAM.${NS}/shop-api`, "aws:iam"]]);
  const { result } = normalizeV2({ provider: "aws", coverage: {}, items: [dep("shop-api"), ...unread] } as never);
  const m = result.fieldMeta[`unread.IAM.${NS}/shop-api`]!;
  assert.equal(m.needs_review, true); assert.equal(m.source, "aws:iam"); assert.match(m.rationale ?? "", /403/);
});
test("ID-5 거부: 다 읽었으면 unread 없음", async () => {
  const { exec } = fakeExec(IAM_FAKES);
  const unread: Raw[] = [];
  await readAwsIam({ exec, env: {} }, R, "prod", [{ namespace: NS, serviceAccount: "shop-api" }], [], null, unread);
  assert.deepEqual(unread, []);
});

// WI-1: GKE Workload Identity — SA 주석 GSA → 프로젝트 IAM 바인딩 → grants (역할 → 공통 동작 이름, Resource "*" 라 이미 이어진 대상에만)
const GSA = "shop-api@p1.iam.gserviceaccount.com";
const gsaSa = { kind: "k8s.serviceAccount", metadata: { name: "shop-api", namespace: NS }, gcpServiceAccount: GSA };
const gcs = { kind: "gcs.bucket", name: "shop-assets", versioning: false, publicAccessPrevention: "enforced", allUsersBinding: false };
test("WI-1 정상: GSA 프로젝트 바인딩 objectViewer → 버킷 링크 grants s3:GetObject·ListBucket, 표 밖 역할은 기준선에만", async () => {
  const ids = appIdentities([dep("shop-api"), gsaSa]);
  assert.equal(ids[0]!.gsa, GSA);
  const { exec, calls } = fakeExec([[/^gcloud projects get-iam-policy p1/, { out: { bindings: [
    { role: "roles/storage.objectViewer", members: [`serviceAccount:${GSA}`] },
    { role: "roles/cloudsql.client", members: [`serviceAccount:${GSA}`] },
    { role: "roles/storage.admin", members: ["serviceAccount:other@p1.iam.gserviceaccount.com"] },
  ] } }]]);
  const notes: string[] = [];
  const b = await readGcpIam({ exec, env: {} }, "p1", ids, notes);
  assert.deepEqual(b.map((x) => x.roles), [["roles/cloudsql.client", "roles/storage.objectViewer"]]);
  assert.ok(calls.every((c) => /^gcloud projects get-iam-policy/.test(c)));
  const { result } = normalizeV2({ provider: "gcp", coverage: {}, items: [dep("shop-api", [{ name: "BUCKET", value: "gs://shop-assets/img" }]), gsaSa, gcs, ...b] } as never);
  const l = result.spec.links.find((x) => x.from === "shop-api" && x.to === "shop-assets")!;
  assert.deepEqual(l.grants?.[0]?.actions, ["s3:GetObject", "s3:ListBucket"]);
  assert.equal(l.intent, "read");
  assert.ok(JSON.stringify(result.spec.posture.permissions).includes("gcp:roles/cloudsql.client"), "표 밖 역할은 버리지 않고 기준선에");
  assert.equal(result.fieldMeta["links.shop-api->shop-assets"]?.rationale?.includes("권한 원문 없음") ?? false, false);
});
test("WI-1 거부: 프로젝트 정책을 못 읽으면 바인딩 없음 + unread.IAM 검토 줄 / GSA 주석 없으면 안 부름", async () => {
  const { exec } = fakeExec([[/^gcloud projects get-iam-policy/, { code: 1, err: "PERMISSION_DENIED" }]]);
  const unread: Raw[] = [];
  assert.deepEqual(await readGcpIam({ exec, env: {} }, "p1", appIdentities([dep("shop-api"), gsaSa]), [], unread), []);
  assert.deepEqual(unread.map((u) => [u.resource, u.source]), [[`IAM.${NS}/shop-api`, "gcp:iam"]]);
  const none = fakeExec([]);
  assert.deepEqual(await readGcpIam({ exec: none.exec, env: {} }, "p1", appIdentities([dep("shop-api")]), [], []), []);
  assert.equal(none.calls.length, 0);
});

// ── IB-1 권한 경계 ─────────────────────────────────────
test("IB-1: 권한 경계를 읽어 grants 를 경계 안 동작으로 좁히고, 뺀 동작·경계·SCP 못 읽음을 기준선·unmapped 에 남긴다", async () => {
  const BOUND = { Statement: [{ Effect: "Allow", Action: ["s3:Get*", "sqs:*"], Resource: "*" }] };
  const { exec } = fakeExec([
    [/^aws iam get-role --role-name shop-api-role /, { out: { Role: { PermissionsBoundary: { PermissionsBoundaryArn: "arn:aws:iam::000000000000:policy/app-boundary" } } } }],
    [/^aws iam get-policy --policy-arn arn:aws:iam::000000000000:policy\/app-boundary/, { out: { Policy: { DefaultVersionId: "v1" } } }],
    [/^aws iam get-policy-version --policy-arn arn:aws:iam::000000000000:policy\/app-boundary .*--version-id v1/, { out: { PolicyVersion: { Document: BOUND } } }],
    ...IAM_FAKES,
  ]);
  const notes: string[] = [];
  const out = await readAwsIam({ exec }, ["--output", "json"], "c", [{ namespace: "shop", serviceAccount: "shop-api" }], notes);
  assert.deepEqual(notes, []);
  assert.equal(out[0]!.boundary?.arn, "arn:aws:iam::000000000000:policy/app-boundary");
  assert.equal(out[0]!.scp, "unread");
});

test("IB-1 거부: 경계를 못 읽으면 정책은 그대로 두고 note + boundaryUnread", async () => {
  const { exec } = fakeExec([[/^aws iam get-role /, { code: 1, err: "AccessDenied" }], ...IAM_FAKES]);
  const notes: string[] = [];
  const out = await readAwsIam({ exec }, ["--output", "json"], "c", [{ namespace: "shop", serviceAccount: "shop-api" }], notes);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.boundaryUnread, true);
  assert.ok(notes.some((n) => n.includes("권한 경계 못 읽음")));
});

test("IB-1: 경계 밖 동작(s3:PutObject)은 grants 에서 빠지고, 경계는 기준선에 '같은 경계' 줄로", () => {
  const p = { ...pol("shop-api", [{ Action: ["s3:GetObject", "s3:PutObject"], Resource: ["arn:aws:s3:::shop-uploads/*"] }]),
    boundary: { arn: "arn:aws:iam::000000000000:policy/app-boundary", statements: [{ Effect: "Allow", Action: "s3:Get*", Resource: "*" }] } };
  const out = run([wl("shop-api"), bucket("shop-uploads")], [p]);
  const up = out.links.find((l) => l.to === "shop-uploads")!;
  assert.deepEqual(up.grants?.[0]?.actions, ["s3:GetObject"]);
  assert.equal(up.intent, "read");
  const b = out.permissions.find((x) => x.source.endsWith(":boundary"))!;
  assert.match(b.note!, /app-boundary/);
  assert.match(b.note!, /s3:PutObject/);
});

test("IB-1 거부: 경계가 없으면 grants 는 그대로 (좁히지 않음)", () => {
  const out = run([wl("shop-api"), bucket("shop-uploads")], [pol("shop-api", [{ Action: ["s3:GetObject", "s3:PutObject"], Resource: ["arn:aws:s3:::shop-uploads/*"] }])]);
  assert.deepEqual(out.links.find((l) => l.to === "shop-uploads")!.grants?.[0]?.actions, ["s3:GetObject", "s3:PutObject"]);
  assert.ok(!out.permissions.some((x) => x.source.endsWith(":boundary")));
});
