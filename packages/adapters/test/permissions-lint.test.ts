// 최소 권한 점검 시험. infra/permissions/ 아래 정책 파일을 읽어 와일드카드·과다 권한을 찾는다.
// 규칙을 어기면 실패. "알려진 과다 권한"은 목록으로 고정해, 새로 늘어나면 실패하게 한다 (톱니바퀴 방식)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const dir = new URL("../../../infra/permissions/", import.meta.url);
const read = (f: string) => readFileSync(new URL(f, dir), "utf8");

interface Stmt { Sid?: string; Effect: string; Action: string | string[]; Resource: string | string[];
  NotAction?: unknown; NotResource?: unknown; Condition?: Record<string, Record<string, string>> }
const arr = (x: string | string[]) => (Array.isArray(x) ? x : [x]);
const aws = (f: string) => (JSON.parse(read(f)) as { Statement: Stmt[] }).Statement;
const AWS_FILES = ["aws-operate-role-policy.json", "aws-session-policy-plan.json",
  "aws-session-policy-apply.json", "aws-session-policy-destroy.json"];
const actionsOf = (f: string) => new Set(aws(f).flatMap((s) => arr(s.Action)));

// 있으면 곧바로 권한 상승이나 비밀값 읽기로 이어지는 동작
const AWS_FORBIDDEN = [
  /^iam:(AttachRolePolicy|AttachUserPolicy|PutUserPolicy|CreatePolicyVersion|SetDefaultPolicyVersion|CreateAccessKey|CreateUser|UpdateAssumeRolePolicy|CreateLoginProfile|PutRolePermissionsBoundary|DeleteRolePermissionsBoundary)$/,
  /^sts:/, /^secretsmanager:(PutSecretValue|PutResourcePolicy)$/,
  /^kms:Decrypt$/, /^organizations:/, /^ssm:GetParameter/, /^eks:(AssociateAccessPolicy|CreateAccessEntry|UpdateClusterConfig)$/,
];
const isRead = (a: string) => /:(Describe|Get|List)/.test(a);

test("AWS: Action에 * 없음, NotAction·NotResource·Deny 없음", () => {
  for (const f of AWS_FILES) for (const s of aws(f)) {
    assert.equal(s.Effect, "Allow", `${f}: Allow만 쓴다`);
    assert.equal(s.NotAction, undefined, `${f}: NotAction`);
    assert.equal(s.NotResource, undefined, `${f}: NotResource`);
    for (const a of arr(s.Action)) assert.ok(!a.includes("*"), `${f}: 와일드카드 동작 ${a}`);
  }
});

test("AWS: 금지 동작(권한 상승·비밀값 읽기) 없음", () => {
  for (const f of AWS_FILES) for (const a of actionsOf(f))
    assert.ok(!AWS_FORBIDDEN.some((r) => r.test(a)), `${f}: 금지 동작 ${a}`);
});

// ID-2: 비밀값 읽기는 하나뿐 — 실행 역할의 AppDbSecretRead(RDS 관리형 rds!db-* + 주인 DB 태그 조건)와 apply 세션 정책. plan·destroy 에는 없다
test("AWS: GetSecretValue 는 RDS 관리형 시크릿 조건 문장과 apply 단계에만", () => {
  for (const s of aws("aws-operate-role-policy.json")) {
    if (!arr(s.Action).includes("secretsmanager:GetSecretValue")) continue;
    assert.equal(s.Sid, "AppDbSecretRead");
    assert.equal(s.Resource, "arn:aws:secretsmanager:*:*:secret:rds!db-*");
    assert.equal(s.Condition?.StringEquals?.["aws:ResourceTag/aws:secretsmanager:owningService"], "rds");
    assert.ok((s.Condition as any)?.StringLike?.["aws:ResourceTag/aws:rds:primaryDBInstanceArn"]);
  }
  assert.ok(actionsOf("aws-session-policy-apply.json").has("secretsmanager:GetSecretValue"));
  for (const f of ["aws-session-policy-plan.json", "aws-session-policy-destroy.json"]) assert.ok(!actionsOf(f).has("secretsmanager:GetSecretValue"), f);
});

test("AWS: 세션 정책(plan·apply·destroy)은 실행 역할 정책의 부분집합", () => {
  const role = actionsOf("aws-operate-role-policy.json");
  for (const p of ["plan", "apply", "destroy"]) {
    const extra = [...actionsOf(`aws-session-policy-${p}.json`)].filter((a) => !role.has(a));
    assert.deepEqual(extra, [], `${p}: 역할에 없는 동작`);
  }
});

test("AWS: plan 세션 정책은 읽기 동작만", () => {
  const w = [...actionsOf("aws-session-policy-plan.json")].filter((a) => !isRead(a));
  assert.deepEqual(w, []);
});

// A-4 고침(G3): 역할 만들기·인라인 정책 넣기는 권한 경계가 붙을 때만
test("AWS: CreateRole·PutRolePolicy는 권한 경계 조건이 있는 문장에만", () => {
  for (const s of aws("aws-operate-role-policy.json")) {
    const hit = arr(s.Action).filter((a) => a === "iam:CreateRole" || a === "iam:PutRolePolicy");
    if (hit.length) assert.match(String(s.Condition?.StringEquals?.["iam:PermissionsBoundary"] ?? ""), /:policy\/platform-app-boundary$/, s.Sid);
  }
});

test("AWS: IAM 동작은 app-* 역할에만, PassRole은 EKS Pod Identity로만, 나머지는 서울 리전만", () => {
  const st = aws("aws-operate-role-policy.json");
  for (const s of st) {
    const iam = arr(s.Action).filter((a) => a.startsWith("iam:"));
    if (iam.length) for (const r of arr(s.Resource)) assert.match(r, /:role\/app-\*$/, `${s.Sid}: IAM 범위 ${r}`);
    if (arr(s.Action).includes("iam:PassRole"))
      assert.equal(s.Condition?.StringEquals?.["iam:PassedToService"], "pods.eks.amazonaws.com");
    if (arr(s.Resource).includes("*"))
      assert.equal(s.Condition?.StringEquals?.["aws:RequestedRegion"], "ap-northeast-2", `${s.Sid}: 리전 조건`);
  }
});

// 알려진 과다 권한 (THREAT-MODEL.md 권한 점검 표 A-1~A-4). 고칠 때 이 목록에서 지운다. 늘어나면 실패
// ID-4: 바꾸기·지우기는 managed-by=platform 태그 조건 문장으로 옮겼다. 남은 것 = 만들기 + 태그 붙이기(만들 때 태그에도 필요, 이름으로 못 좁힘)
const AWS_KNOWN_BROAD_WRITES = [
  "ec2:CreateSecurityGroup", "ec2:CreateTags", "eks:CreatePodIdentityAssociation",
  "rds:AddTagsToResource", "rds:CreateDBInstance", "rds:CreateDBParameterGroup", "rds:CreateDBSubnetGroup", "secretsmanager:CreateSecret",
  "secretsmanager:TagResource",
].sort();
test("AWS: Resource \"*\" + 쓰기 동작 = 알려진 목록과 같다 (늘어나면 실패)", () => {
  const broad = aws("aws-operate-role-policy.json")
    .filter((s) => arr(s.Resource).includes("*") && !s.Condition?.StringEquals?.["aws:ResourceTag/managed-by"])
    .flatMap((s) => arr(s.Action)).filter((a) => !isRead(a)).sort();
  assert.deepEqual(broad, AWS_KNOWN_BROAD_WRITES);
});

// ID-4: 기존 자원을 바꾸거나 지우는 동작(Modify·Delete·Set·Authorize·Revoke)은 우리 태그(managed-by=platform) 조건 문장에만.
//   S3 는 버킷 태그 조건을 믿지 못해 이름(app-*)만 — 예외로 고정. 고객 기존 RDS·보안 그룹·시크릿·app-* 역할을 지울 수 없게
const MUTATES = /:(Modify|Delete|Set|Authorize|Revoke|Update|Put(?!Bucket|Encryption|Lifecycle))/;
test("AWS 실행 역할: 기존 자원 바꾸기·지우기는 managed-by=platform 태그 조건이 있을 때만 (S3 제외)", () => {
  const bad: string[] = [];
  for (const s of aws("aws-operate-role-policy.json")) {
    const tagged = s.Condition?.StringEquals?.["aws:ResourceTag/managed-by"] === "platform";
    const realArns = arr(s.Resource).filter((r) => r === "*" || r.startsWith("arn:aws:rds") || r.startsWith("arn:aws:iam") || r.startsWith("arn:aws:secretsmanager")
      || r.startsWith("arn:aws:elasticache") || r.startsWith("arn:aws:sqs") || r.startsWith("arn:aws:sns"));
    if (tagged || realArns.length === 0) continue;
    for (const a of arr(s.Action)) {
      if (!MUTATES.test(a) || a.startsWith("s3:") || a === "iam:PutRolePolicy") continue;   // PutRolePolicy 는 경계 조건(위 시험)
      // 데이터 문장의 ec2 동작은 elasticache·sqs 자원 ARN 에 걸려 실제 효력이 없다
      if (s.Sid === "DataScoped" && a.startsWith("ec2:")) continue;
      bad.push(`${s.Sid}:${a}`);
    }
  }
  assert.deepEqual(bad, []);
});

// GCP 커스텀 역할
const gcp = read("gcp-operate-custom-role.yaml").split("\n")
  .filter((l) => l.startsWith("- ")).map((l) => l.slice(2).trim());
const GCP_FORBIDDEN = [
  /^resourcemanager\.(projects|folders|organizations)\.setIamPolicy$/, /^iam\.serviceAccountKeys\./,
  /^iam\.serviceAccounts\.(actAs|getAccessToken|signBlob|signJwt|implicitDelegation|getOpenIdToken)$/,
  /^iam\.roles\.(create|update)$/, /^secretmanager\.versions\.access$/, /^container\.clusterRoleBindings\./,
];
test("GCP: 와일드카드 없음, 금지 권한(키 발급·가장·비밀값 읽기·프로젝트 IAM) 없음", () => {
  assert.ok(gcp.length > 0);
  for (const p of gcp) {
    assert.ok(!p.includes("*"), `와일드카드 ${p}`);
    assert.ok(!GCP_FORBIDDEN.some((r) => r.test(p)), `금지 권한 ${p}`);
  }
});
// G-1, G-2 고침(G3): setIamPolicy는 주 역할에서 빼고, app- 접두어 조건이 붙은 별도 역할로만
test("GCP: 주 역할엔 setIamPolicy 없음, 별도 역할은 setIamPolicy만 + app- 접두어 조건", () => {
  assert.deepEqual(gcp.filter((p) => p.endsWith(".setIamPolicy")), []);
  const iamRole = read("gcp-operate-iam-custom-role.yaml").split("\n").filter((l) => l.startsWith("- ")).map((l) => l.slice(2).trim());
  // A8fix: 옮긴 권한 바인딩용 버킷·토픽·구독 setIamPolicy 3개 추가 (자원 단위, 프로젝트 setIamPolicy 는 여전히 없음)
  assert.deepEqual(iamRole.sort(), ["iam.serviceAccounts.setIamPolicy", "pubsub.subscriptions.setIamPolicy", "pubsub.topics.setIamPolicy",
    "secretmanager.secrets.setIamPolicy", "storage.buckets.setIamPolicy"]);
  assert.ok(!iamRole.some((p) => p.startsWith("resourcemanager.")), "프로젝트 전체 setIamPolicy 금지");
  const cond = JSON.parse(read("gcp-operate-iam-binding-condition.json")) as { expression: string };
  // 자원 종류마다 app- 접두어 조건 하나씩 (SA·시크릿·토픽·구독 = 이름 startsWith("app-"), 버킷 = 전체 이름 projects/_/buckets/app-)
  assert.equal((cond.expression.match(/startsWith\("app-"\)/g) ?? []).length, 4);
  assert.match(cond.expression, /storage\.googleapis\.com\/Bucket" && resource\.name\.startsWith\("projects\/_\/buckets\/app-"\)/);
  assert.equal((cond.expression.match(/resource\.type == /g) ?? []).length, 5, "조건 없는 자원 종류가 섞이면 안 됨");
});

// ID-2: 비밀값 읽기는 주 역할 금지. 도착 DB 비밀번호만 따로 역할 + 이름 조건 (app-…-db-password 시크릿 버전만)
test("GCP: DB 비밀번호 역할은 versions.access 하나뿐 + app-…-db-password 시크릿 버전 조건", () => {
  const role = read("gcp-operate-db-secret-role.yaml").split("\n").filter((l) => l.startsWith("- ")).map((l) => l.slice(2).trim());
  assert.deepEqual(role, ["secretmanager.versions.access"]);
  const x = (JSON.parse(read("gcp-operate-db-secret-condition.json")) as { expression: string }).expression;
  assert.equal((x.match(/resource\.type == /g) ?? []).length, 1);
  assert.match(x, /resource\.type == "secretmanager\.googleapis\.com\/SecretVersion"/);
  assert.ok(!x.includes("||"), "다른 자원 종류로 새는 갈래 없음");
  assert.match(x, /startsWith\("app-"\)/); assert.match(x, /endsWith\("-db-password"\)/);
  // 이름 규칙 원본(Terraform)과 맞는지: 도착 DB 비밀번호 시크릿 이름은 app- 로 시작해 -db-password 로 끝난다
  for (const f of ["../../../infra/modules/gcp/kinds/postgres/main.tf", "../../../infra/modules/gcp/app/main.tf"]) {
    const tf = readFileSync(new URL(f, import.meta.url), "utf8");
    const m = tf.match(/resource "google_secret_manager_secret" "db_password" \{[^}]*?secret_id\s*=\s*"([^"]+)"/);
    assert.ok(m, f); assert.ok(m![1]!.startsWith("app-") && m![1]!.endsWith("-db-password"), m![1]);
  }
});

// 온프레 k8s ClusterRole
const k8s = read("onprem-operate-clusterrole.yaml");
const rules = [...k8s.matchAll(/apiGroups: \[(.*?)\]\n\s+resources: \[(.*?)\]\n\s+verbs: \[(.*?)\]/g)]
  .map((m) => ({ groups: m[1]!, resources: m[2]!, verbs: m[3]! }));
test("k8s: * 없음, secrets·RBAC·exec 없음, escalate·bind·impersonate 동사 없음", () => {
  assert.ok(rules.length > 0);
  for (const r of rules) {
    assert.ok(![r.groups, r.resources, r.verbs].some((x) => x.includes("*")), `와일드카드 ${JSON.stringify(r)}`);
    assert.ok(!/"secrets"|"pods\/exec"|"nodes"/.test(r.resources), `금지 자원 ${r.resources}`);
    assert.ok(!/rbac\.authorization\.k8s\.io/.test(r.groups), `RBAC 그룹 ${r.groups}`);
    assert.ok(!/"(escalate|bind|impersonate)"/.test(r.verbs), `금지 동사 ${r.verbs}`);
  }
});
// K-1 고침(G3): 클러스터 전체로 묶는 건 네임스페이스 관리 역할 하나뿐. 앱 자원 역할은 RoleBinding(Kyverno)으로만
test("k8s: ClusterRoleBinding은 platform-operate-namespaces 하나, 그 역할은 namespaces만", () => {
  const bindings = [...k8s.matchAll(/kind: ClusterRoleBinding[\s\S]*?roleRef:[\s\S]*?name: (\S+)/g)].map((m) => m[1]);
  assert.deepEqual(bindings, ["platform-operate-namespaces"]);
  const nsRole = k8s.split("---")[0]!;
  assert.deepEqual([...nsRole.matchAll(/resources: \[(.*?)\]/g)].map((m) => m[1]), ['"namespaces"']);
  // K-2: 네임스페이스 삭제는 Kyverno가 managed-by=platform만 허용
  assert.match(read("onprem-kyverno-platform.yaml"), /name: platform-namespace-delete-guard/);
});
