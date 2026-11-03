import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AppSpec } from "@svc/contracts";
import { adapterFor, aws, gcp, onprem, DEMO_INVENTORY } from "../src/index.js";
import { actionsFor } from "../src/common/actions.js";
import { DATA_TYPES } from "../src/target/data.js";
import { GRANT_TYPES_GCP } from "../src/target/grants.js";
import { buildAwsConnectTemplate } from "./aws-connect-template.js";

// 앱 모듈(infra/modules/*/app)을 plan/apply/destroy 하는 데 필요한 최소 권한을 파일로 뽑는다.
// 계정 세팅 때 "실행 역할" 정책·GCP 커스텀 역할의 출발점. 값은 권한표 추정 → 실계정 거부 로그로 보정
// 실행: npx tsx packages/adapters/scripts/export-permissions.ts infra/permissions [infra/onboarding]
const out = process.argv[2] ?? "infra/permissions";
// DRAFT(ai): 고객 연결 템플릿 출력 폴더 = 두 번째 인자, 없으면 권한 폴더 옆 onboarding (infra/permissions는 정책 파일 전용)
const onboardingOut = process.argv[3] ?? join(out, "..", "onboarding");
mkdirSync(out, { recursive: true });
mkdirSync(onboardingOut, { recursive: true });
const spec = (p: "aws" | "gcp" | "onprem") => AppSpec.parse(adapterFor(p).normalize(DEMO_INVENTORY[p]).spec);
const purposes = ["plan", "apply", "destroy"] as const;

// AWS: 실행 역할에 붙이는 정책 = plan ∪ apply ∪ destroy. 호출마다 세션 정책으로 다시 좁힌다
const awsAll = [...new Set(purposes.flatMap((p) => aws.operateActions(spec("aws"), p)))].sort();
// IAM 동작은 app-* 역할에만 (아무 역할이나 만들면 권한 상승). PassRole은 Pod Identity로만
// 역할을 만들거나 인라인 정책을 넣을 때는 권한 경계(platform-app-boundary)가 붙어 있어야만 허용 (위협 모델 A-4).
// 경계 = 앱 역할이 가질 수 있는 최대치(자기 시크릿 읽기). PutRolePolicy로 관리자 정책을 넣어도 경계 밖은 무효
const BOUNDARY_ARN = "arn:aws:iam::${aws:PrincipalAccount}:policy/platform-app-boundary";
const NEEDS_BOUNDARY = ["iam:CreateRole", "iam:PutRolePolicy"];
const awsIamBound = awsAll.filter((a) => NEEDS_BOUNDARY.includes(a));
const awsIamOther = awsAll.filter((a) => a.startsWith("iam:") && a !== "iam:PassRole" && !NEEDS_BOUNDARY.includes(a));
// TA12b: 데이터 자원(ElastiCache·S3·SQS·SNS / Memorystore·GCS·Pub/Sub) 권한. 모든 단계 합집합이 천장, 단계별로 세션 정책에 더함.
//   쓰기·태그·삭제는 이름이 "app-" 로 시작하는 자원에만 (target/data.ts 의 이름 규칙). 자원 단위 제한이 안 되는 ElastiCache Describe* 만 Resource "*".
const AWS_DATA = [...Object.values(DATA_TYPES.aws).flat()];
const awsDataFor = (p: (typeof purposes)[number]) => actionsFor(aws.PERMS, AWS_DATA, p);
const awsDataAll = [...new Set(purposes.flatMap(awsDataFor))].sort();
const awsDataDescribe = awsDataAll.filter((a) => a.startsWith("elasticache:Describe"));
const awsDataScoped = awsDataAll.filter((a) => !a.startsWith("elasticache:Describe"));
const DATA_ARNS = [
  "arn:aws:elasticache:*:*:replicationgroup:app-*", "arn:aws:elasticache:*:*:cluster:app-*", "arn:aws:elasticache:*:*:subnetgroup:app-*",
  "arn:aws:elasticache:*:*:parametergroup:*",   // 【미확인】 기본 파라미터 그룹(default.*)을 읽어야 만들어짐 — 첫 실측으로 확인
  "arn:aws:s3:::app-*", "arn:aws:s3:::app-*/*", "arn:aws:sqs:*:*:app-*", "arn:aws:sns:*:*:app-*",
];
const awsRest = awsAll.filter((a) => !a.startsWith("iam:"));
const awsOperatePolicy = {
  Version: "2012-10-17",
  Statement: [
    { Sid: "AppModule", Effect: "Allow", Action: awsRest, Resource: "*",
      Condition: { StringEquals: { "aws:RequestedRegion": "ap-northeast-2" } } },
    { Sid: "DataDescribe", Effect: "Allow", Action: awsDataDescribe, Resource: "*",
      Condition: { StringEquals: { "aws:RequestedRegion": "ap-northeast-2" } } },
    { Sid: "DataScoped", Effect: "Allow", Action: awsDataScoped, Resource: DATA_ARNS,
      Condition: { StringEquals: { "aws:RequestedRegion": "ap-northeast-2" } } },
    { Sid: "AppRolesWithBoundary", Effect: "Allow", Action: awsIamBound, Resource: "arn:aws:iam::*:role/app-*",
      Condition: { StringEquals: { "iam:PermissionsBoundary": BOUNDARY_ARN } } },
    { Sid: "AppRolesOnly", Effect: "Allow", Action: awsIamOther, Resource: "arn:aws:iam::*:role/app-*" },
    { Sid: "PassOnlyAppRoles", Effect: "Allow", Action: "iam:PassRole", Resource: "arn:aws:iam::*:role/app-*",
      Condition: { StringEquals: { "iam:PassedToService": "pods.eks.amazonaws.com" } } },
  ],
};
writeFileSync(join(out, "aws-operate-role-policy.json"), JSON.stringify(awsOperatePolicy, null, 2) + "\n");
// 경계 정책 본문 (infra/modules/aws/env 가 같은 내용으로 만든다. 테스트가 둘을 대조)
const awsBoundary = aws.appRoleBoundary("ap-northeast-2");
writeFileSync(join(out, "aws-app-role-boundary.json"), JSON.stringify(awsBoundary, null, 2) + "\n");
// 고객 연결 템플릿(CloudFormation): 위 두 정책을 그대로 넣는다 → 실행 정책과 어긋나지 않음
writeFileSync(join(onboardingOut, "aws-connect.json"), JSON.stringify(buildAwsConnectTemplate(awsOperatePolicy, awsBoundary), null, 2) + "\n");
for (const p of purposes) {
  // 세션 정책 = v1 데모 동작 + 데이터 자원 동작 (한 문장에 합침: 2,048자 제한). 실제 효력은 천장(역할 정책)과의 교집합이라 자원 접두어 제한이 같이 걸림
  const doc = JSON.parse(aws.sessionPolicy(spec("aws"), p)) as { Statement: Array<{ Action: string[] }> };
  doc.Statement[0]!.Action = [...new Set([...doc.Statement[0]!.Action, ...awsDataFor(p)])].sort();
  const compact = JSON.stringify(doc);
  if (compact.length > 2048) throw new Error(`세션 정책 ${p} ${compact.length}자 > 2048`);
  writeFileSync(join(out, `aws-session-policy-${p}.json`), JSON.stringify(doc, null, 2) + "\n");
}

// GCP: 테넌트 SA에 줄 커스텀 역할 2개 (GCP는 호출별 세션 정책이 없음).
// setIamPolicy 2개는 따로 떼어 "이름이 app-로 시작하는 SA·시크릿"에만 쓰이게 IAM 조건을 건다 (위협 모델 G-1, G-2)
const GCP_DATA = [...Object.values(DATA_TYPES.gcp).flat(), ...GRANT_TYPES_GCP];   // A8fix: 옮긴 권한 바인딩(자원 단위 setIamPolicy)
// TA12b: 데이터 자원 권한도 천장에 포함. 【미확인】 GCP 커스텀 역할은 이름 접두어로 제한 못 함 (프로젝트 단위) — 필요하면 IAM 조건부 바인딩 추가 TODO(human)
const gcpAll = [...new Set([...purposes.flatMap((p) => gcp.operateActions(spec("gcp"), p)), ...purposes.flatMap((p) => actionsFor(gcp.PERMS, GCP_DATA, p))])].sort();
const gcpIam = gcpAll.filter((x) => x.endsWith(".setIamPolicy"));
const gcpRest = gcpAll.filter((x) => !x.endsWith(".setIamPolicy"));
const role = (title: string, desc: string, perms: string[]) =>
  `title: ${title}\ndescription: ${desc}\nstage: GA\nincludedPermissions:\n` + perms.map((x) => `- ${x}`).join("\n") + "\n";
writeFileSync(join(out, "gcp-operate-custom-role.yaml"),
  role("platform-operate", "infra/modules/gcp/app plan/apply/destroy, IAM 정책 바꾸기 제외 (자동 생성)", gcpRest));
writeFileSync(join(out, "gcp-operate-iam-custom-role.yaml"),
  role("platform-operate-iam", "app- 접두어 SA·시크릿·버킷·토픽·구독의 IAM 정책만 (조건부 바인딩 필수, 자동 생성)", gcpIam));
writeFileSync(join(out, "gcp-operate-iam-binding-condition.json"), JSON.stringify({
  title: "only-app-prefixed",
  description: "플랫폼이 만든 app- 접두어 서비스 계정·시크릿·버킷·토픽·구독에만",
  expression: gcp.IAM_CONDITION,
}, null, 2) + "\n");

// 온프레: 클러스터 전체에 주는 건 네임스페이스 관리뿐. 앱 자원 권한은 ClusterRole로 정의만 하고
// 각 앱 네임스페이스의 RoleBinding으로만 묶는다 → kube-system 등 남의 네임스페이스엔 닿지 않음 (위협 모델 K-1).
// RoleBinding은 Kyverno가 네임스페이스 생성 때 만든다 (실행 신원에 RBAC 권한·bind 동사 불필요).
// 네임스페이스 삭제는 managed-by=platform 표시가 있을 때만 (Kyverno, K-2)
const rules = new Map<string, Set<string>>();
for (const p of purposes) for (const a of onprem.operateActions(spec("onprem"), p)) {
  const [res, verb] = a.split(":") as [string, string];
  (rules.get(res) ?? rules.set(res, new Set()).get(res)!).add(verb);
}
const fmt = (entries: Array<[string, Set<string>]>) => entries.sort().map(([res, verbs]) => {
  const [group, resource] = res.split("/") as [string, string];
  return `  - apiGroups: ["${group === "core" ? "" : group}"]\n    resources: ["${resource}"]\n    verbs: [${[...verbs].sort().map((v) => `"${v}"`).join(", ")}]`;
}).join("\n");
const clusterWide = [...rules].filter(([r]) => r === "core/namespaces");
const perNs = [...rules].filter(([r]) => r !== "core/namespaces");
writeFileSync(join(out, "onprem-operate-clusterrole.yaml"),
  `# 클러스터 전체: 네임스페이스 관리만 (그룹 platform:operate에 ClusterRoleBinding)\n` +
  `apiVersion: rbac.authorization.k8s.io/v1\nkind: ClusterRole\nmetadata:\n  name: platform-operate-namespaces\nrules:\n${fmt(clusterWide)}\n` +
  `---\n# 앱 자원: 정의만. 앱 네임스페이스의 RoleBinding(Kyverno가 생성)으로만 묶는다. ClusterRoleBinding 금지\n` +
  `apiVersion: rbac.authorization.k8s.io/v1\nkind: ClusterRole\nmetadata:\n  name: platform-operate-app\nrules:\n${fmt(perNs)}\n` +
  `---\napiVersion: rbac.authorization.k8s.io/v1\nkind: ClusterRoleBinding\nmetadata:\n  name: platform-operate-namespaces\n` +
  `roleRef:\n  apiGroup: rbac.authorization.k8s.io\n  kind: ClusterRole\n  name: platform-operate-namespaces\n` +
  `subjects:\n  - apiGroup: rbac.authorization.k8s.io\n    kind: Group\n    name: platform:operate\n`);
console.log(`AWS ${awsAll.length}개, GCP ${gcpRest.length}+${gcpIam.length}개(조건부), k8s 클러스터 ${clusterWide.length}·네임스페이스 ${perNs.length}규칙 → ${out}`);
