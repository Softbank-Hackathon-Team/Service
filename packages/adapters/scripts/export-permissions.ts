import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { aws, gcp, onprem } from "../src/index.js";
import { actionsFor } from "../src/common/actions.js";
import { DATA_TYPES } from "../src/target/data.js";
import { GRANT_TYPES_GCP } from "../src/target/grants.js";
import { buildAwsConnectTemplate } from "./aws-connect-template.js";
import { sourceDbLinkOperatePolicy } from "../src/aws/source-db-link.js";
import { buildPermissionBundles, gcpBundlesTsv, GCP_BUNDLES_TSV, PERMISSION_BUNDLES_FILE, PERMISSIONS_VERSION } from "../src/permissions/bundles.js";
import { collectBundleInputs } from "./permission-bundles.js";

// 앱 모듈(infra/modules/*/app)을 plan/apply/destroy 하는 데 필요한 최소 권한을 파일로 뽑는다.
// 계정 세팅 때 "실행 역할" 정책·GCP 커스텀 역할의 출발점. 값은 권한표 추정 → 실계정 거부 로그로 보정
// 실행: npx tsx packages/adapters/scripts/export-permissions.ts infra/permissions [infra/onboarding]
const out = process.argv[2] ?? "infra/permissions";
// DRAFT(ai): 고객 연결 템플릿 출력 폴더 = 두 번째 인자, 없으면 권한 폴더 옆 onboarding (infra/permissions는 정책 파일 전용)
const onboardingOut = process.argv[3] ?? join(out, "..", "onboarding");
mkdirSync(out, { recursive: true });
mkdirSync(onboardingOut, { recursive: true });
// 권한표가 보는 기본 앱 모양 = 서비스 + 비밀 + DB (PermNeeds). 데이터 자원 권한은 아래에서 따로 더한다
const spec = (_p: "aws" | "gcp" | "onprem") => ({ secrets: true, database: true });
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
// ID-4 DRAFT(ai): "우리가 만든 것만" 고치고 지운다. 예전엔 Resource "*" + 리전 조건만이라, 같은 계정·리전의 고객 기존 RDS(출발 DB 포함)·
//   보안 그룹·시크릿도 Modify·Delete 할 수 있었다. 이제 기존 자원을 바꾸는 동작은 우리 표시(태그 managed-by=platform,
//   Terraform root 의 default_tags 가 모든 자원에 붙임)가 있는 자원에만 허용한다.
//   - 읽기·만들기: Resource "*" + 리전 (만들기는 남의 것을 망가뜨리지 않는다. 만들 때 태그 조건을 걸면 Terraform 이 태그를 나중에 붙이는 종류가 깨진다 【추정】)
//   - 태그 붙이기: Resource "*" + 리전. 이름으로 못 좁힌다 — 우리 RDS 이름은 <앱>-pg-<해시>, 시크릿은 platform/<회사>/<앱>/… 라 app- 접두어가 아니고,
//     만들 때 태그도 rds:AddTagsToResource·secretsmanager:TagResource 권한이 있어야 해서 좁히면 apply 가 깨진다
//   - 바꾸기·지우기: aws:ResourceTag/managed-by = platform 일 때만
// 남는 위험 TODO(human): 플랫폼 워커가 탈취되면 고객 자원에 managed-by=platform 태그를 붙인 뒤 지울 수 있다(두 단계). 실수·이름 겹침은 막는다.
//   막으려면 명시적 Deny(태그 키 managed-by 덮어쓰기 금지)를 쓰는데, RDS 는 만들 때 태그와 기존 자원 태그를 조건으로 못 가른다【사실, AWS RDS 문서 "Grant permission to tag resources during creation": 만들 때 태그도 rds:AddTagsToResource 권한이 필요】
// 첫 실측(REAL_STS)에서 확인할 것 【미확인】: aws_security_group 이 만들 때 태그를 같이 넣는지(아니면 RevokeSecurityGroupEgress 가 거부됨), ModifyDBInstance 가 연결된 파라미터 그룹 태그도 보는지
const OWNED_TAG = { "aws:ResourceTag/managed-by": "platform" };
const REGION = { "aws:RequestedRegion": "ap-northeast-2" };
const isReadAct = (a: string) => /:(Describe|Get|List)/.test(a);
const isCreateAct = (a: string) => /:Create(?!Tags)/.test(a);
const TAG_ACTS = ["rds:AddTagsToResource", "secretsmanager:TagResource", "ec2:CreateTags"];
const awsTag = awsRest.filter((a) => TAG_ACTS.includes(a));
const awsRead = awsRest.filter(isReadAct);
const awsCreate = awsRest.filter((a) => !isReadAct(a) && isCreateAct(a));
const awsOwned = awsRest.filter((a) => !isReadAct(a) && !isCreateAct(a) && !TAG_ACTS.includes(a));
const IAM_DELETE = ["iam:DeleteRole", "iam:DeleteRolePolicy"];
// 데이터 자원도 같은 규칙: 바꾸기·지우기는 이름(app-*) + 우리 태그. S3 버킷은 태그 조건을 믿지 못해(【미확인】 S3 버킷 동작의 aws:ResourceTag 지원) 이름만
const isDataOwned = (a: string) => /^(elasticache:(Delete|Modify)|sqs:(DeleteQueue|SetQueueAttributes)|sns:(DeleteTopic|SetTopicAttributes))/.test(a);
const awsDataOwned = awsDataScoped.filter(isDataOwned);
const awsDataNamed = awsDataScoped.filter((a) => !isDataOwned(a));
// APP-01·D: 이미지별 ECR 저장소 (이름 platform/<회사>/<이름>). 만들기·태그·설정·push(레이어 올리기)·digest 확인용 읽기
const ECR_REPOS = "arn:aws:ecr:*:*:repository/platform/*";
const ECR_REPO_ACTS = ["ecr:BatchCheckLayerAvailability", "ecr:BatchGetImage", "ecr:CompleteLayerUpload", "ecr:CreateRepository",
  "ecr:DescribeRepositories", "ecr:InitiateLayerUpload", "ecr:ListTagsForResource", "ecr:PutImage",
  "ecr:PutImageScanningConfiguration", "ecr:PutImageTagMutability", "ecr:TagResource", "ecr:UploadLayerPart"];
const ECR_REPO_REMOVE = ["ecr:BatchDeleteImage", "ecr:DeleteRepository"];
// 배포 이미지 복사(worker jobs/image-copy.ts)가 도착 실행 역할 apply 단계로 부르는 동작: 토큰, 저장소 만들기(태그 managed-by 포함), 레이어·매니페스트 올리기, 다이제스트 확인
const ECR_PUSH_ACTS = ["ecr:BatchCheckLayerAvailability", "ecr:BatchGetImage", "ecr:CompleteLayerUpload", "ecr:CreateRepository",
  "ecr:GetAuthorizationToken", "ecr:InitiateLayerUpload", "ecr:PutImage", "ecr:TagResource", "ecr:UploadLayerPart"];
const awsOperatePolicy = {
  Version: "2012-10-17",
  Statement: [
    { Sid: "AppRead", Effect: "Allow", Action: awsRead, Resource: "*", Condition: { StringEquals: REGION } },
    { Sid: "AppCreate", Effect: "Allow", Action: awsCreate, Resource: "*", Condition: { StringEquals: REGION } },
    { Sid: "AppTag", Effect: "Allow", Action: awsTag, Resource: "*", Condition: { StringEquals: REGION } },
    { Sid: "AppOwned", Effect: "Allow", Action: awsOwned, Resource: "*", Condition: { StringEquals: { ...REGION, ...OWNED_TAG } } },
    { Sid: "DataDescribe", Effect: "Allow", Action: awsDataDescribe, Resource: "*", Condition: { StringEquals: REGION } },
    { Sid: "DataScoped", Effect: "Allow", Action: awsDataNamed, Resource: DATA_ARNS, Condition: { StringEquals: REGION } },
    { Sid: "DataOwned", Effect: "Allow", Action: awsDataOwned, Resource: DATA_ARNS.filter((r) => !r.includes(":s3:::")),
      Condition: { StringEquals: { ...REGION, ...OWNED_TAG } } },
    // ID-2 DRAFT(ai): apply 끝에 워커가 새 도착 DB 의 관리형 비밀번호(RDS 가 만든 rds!db-… 시크릿)를 꺼낸다(real-runner fetchSecret).
    //   빌린 실행 자격엔 이 권한이 없어 복제 도착 접속이 비었다. 읽기는 "우리 DB 이름(<앱>-pg-<해시6>)을 주인으로 가진 RDS 시크릿"만.
    //   【추정】 RDS 는 관리형 시크릿에 태그 aws:rds:primaryDBInstanceArn·aws:secretsmanager:owningService=rds 를 붙인다 (첫 실측으로 확인)
    // 남는 위험 TODO(human): 고객 DB 이름이 우연히 *-pg-<6글자> 모양이면 그 비밀번호도 읽힌다. 이름에 플랫폼 표시를 넣을지 팀 결정
    { Sid: "AppDbSecretRead", Effect: "Allow", Action: ["secretsmanager:GetSecretValue"], Resource: "arn:aws:secretsmanager:*:*:secret:rds!db-*",
      Condition: { StringEquals: { ...REGION, "aws:ResourceTag/aws:secretsmanager:owningService": "rds" },
        StringLike: { "aws:ResourceTag/aws:rds:primaryDBInstanceArn": "arn:aws:rds:*:*:db:*-pg-??????" } } },
    // APP-01·D (그대로 이식): 사설 이미지를 도착 ECR 이미지별 저장소(platform/<회사>/<이름>)로 복사. 저장소는 배포 이미지 복사(worker jobs/image-copy.ts)가 만든다.
    //   저장소 만들기·올리기는 그 이름 아래만, 지우기는 우리 태그가 있는 것만. 토큰(GetAuthorizationToken)은 자원 단위가 없어 "*"
    { Sid: "AppImageRepos", Effect: "Allow", Action: ECR_REPO_ACTS, Resource: ECR_REPOS, Condition: { StringEquals: REGION } },
    { Sid: "AppImageReposOwned", Effect: "Allow", Action: ECR_REPO_REMOVE, Resource: ECR_REPOS, Condition: { StringEquals: { ...REGION, ...OWNED_TAG } } },
    { Sid: "AppImageAuth", Effect: "Allow", Action: ["ecr:GetAuthorizationToken"], Resource: "*", Condition: { StringEquals: REGION } },
    { Sid: "AppRolesWithBoundary", Effect: "Allow", Action: awsIamBound, Resource: "arn:aws:iam::*:role/app-*",
      Condition: { StringEquals: { "iam:PermissionsBoundary": BOUNDARY_ARN } } },
    { Sid: "AppRolesOnly", Effect: "Allow", Action: awsIamOther.filter((a) => !IAM_DELETE.includes(a)), Resource: "arn:aws:iam::*:role/app-*" },
    // ID-4: 역할 지우기도 우리 태그가 있는 app-* 역할만 (고객이 app- 로 시작하는 역할을 이미 쓰고 있을 수 있다)
    { Sid: "AppRolesOwnedDelete", Effect: "Allow", Action: awsIamOther.filter((a) => IAM_DELETE.includes(a)), Resource: "arn:aws:iam::*:role/app-*",
      Condition: { StringEquals: OWNED_TAG } },
    { Sid: "PassOnlyAppRoles", Effect: "Allow", Action: "iam:PassRole", Resource: "arn:aws:iam::*:role/app-*",
      Condition: { StringEquals: { "iam:PassedToService": "pods.eks.amazonaws.com" } } },
  ],
};
writeFileSync(join(out, "aws-operate-role-policy.json"), JSON.stringify(awsOperatePolicy, null, 2) + "\n");
// 경계 정책 본문 (infra/modules/aws/env 가 같은 내용으로 만든다. 테스트가 둘을 대조)
const awsBoundary = aws.appRoleBoundary("ap-northeast-2");
writeFileSync(join(out, "aws-app-role-boundary.json"), JSON.stringify(awsBoundary, null, 2) + "\n");
// APP-22 (가): 실행 역할 인라인 정책 source-db-link (기록용 파일. 템플릿이 같은 함수로 넣는다)
writeFileSync(join(out, "aws-operate-source-db-link-policy.json"), JSON.stringify(sourceDbLinkOperatePolicy(), null, 2) + "\n");
// 고객 연결 템플릿(CloudFormation): 위 두 정책을 그대로 넣는다 → 실행 정책과 어긋나지 않음
writeFileSync(join(onboardingOut, "aws-connect.json"), JSON.stringify(buildAwsConnectTemplate(awsOperatePolicy, awsBoundary), null, 2) + "\n");
for (const p of purposes) {
  // 세션 정책 = 기본 앱 동작 + 데이터 자원 동작 (한 문장에 합침: 2,048자 제한). 실제 효력은 천장(역할 정책)과의 교집합이라 자원 접두어 제한이 같이 걸림
  const doc = JSON.parse(aws.sessionPolicy(spec("aws"), p)) as { Statement: Array<{ Action: string[] }> };
  // ID-2: apply 만 DB 비밀번호 읽기 (실효 범위는 천장 AppDbSecretRead 조건과의 교집합)
  // 배포 이미지 복사도 apply 단계로 빌린다 (실효 범위는 천장 AppImageRepos = platform/* 저장소만)
  doc.Statement[0]!.Action = [...new Set([...doc.Statement[0]!.Action, ...awsDataFor(p), ...(p === "apply" ? ["secretsmanager:GetSecretValue", ...ECR_PUSH_ACTS] : [])])].sort();
  // 파일은 동작을 하나하나 적는다(장부·시험용). AWS 로 보낼 때는 발급기가 와일드카드로 줄인 판(security compactSessionPolicy)을 쓰고,
  //   2,048자 검사도 그 판으로 한다 (security 시험이 여유 300자를 확인). 파일 자체는 넉넉한 상한만 본다
  const compact = JSON.stringify(doc);
  if (compact.length > 6144) throw new Error(`세션 정책 ${p} ${compact.length}자 > 6144 (줄여도 2,048자를 못 맞춤)`);
  writeFileSync(join(out, `aws-session-policy-${p}.json`), JSON.stringify(doc, null, 2) + "\n");
}

// GCP: 테넌트 SA에 줄 커스텀 역할 2개 (GCP는 호출별 세션 정책이 없음).
// setIamPolicy 2개는 따로 떼어 "이름이 app-로 시작하는 SA·시크릿"에만 쓰이게 IAM 조건을 건다 (위협 모델 G-1, G-2)
const GCP_DATA = [...Object.values(DATA_TYPES.gcp).flat(), ...GRANT_TYPES_GCP, ...gcp.ROOT_TYPES];   // FM-CLD-23: gcp/root API 켜기   // A8fix: 옮긴 권한 바인딩(자원 단위 setIamPolicy)
// TA12b: 데이터 자원 권한도 천장에 포함. 【미확인】 GCP 커스텀 역할은 이름 접두어로 제한 못 함 (프로젝트 단위) — 필요하면 IAM 조건부 바인딩 추가 TODO(human)
// 배포 이미지 복사(worker jobs/image-copy.ts): 전용 프로젝트 AR 저장소 platform(gcp/env)에 올리기 + 다이제스트 확인(받기). 실행 역할은 전용 프로젝트에만 붙는다
const GCP_IMAGE_PUSH = ["artifactregistry.repositories.downloadArtifacts", "artifactregistry.repositories.uploadArtifacts"];
const gcpAll = [...new Set([...purposes.flatMap((p) => gcp.operateActions(spec("gcp"), p)), ...purposes.flatMap((p) => actionsFor(gcp.PERMS, GCP_DATA, p)), ...GCP_IMAGE_PUSH])].sort();
const gcpIam = gcpAll.filter((x) => x.endsWith(".setIamPolicy"));
const gcpRest = gcpAll.filter((x) => !x.endsWith(".setIamPolicy"));
// PERM-GATE: 설명 끝에 권한 판 번호 [perms vN] (관찰 SA 가 iam.roles.get 으로 고객 역할에 붙은 판을 읽는다). 새로 만드는 역할만 이 설명을 받는다
const role = (title: string, desc: string, perms: string[]) =>
  `title: ${title}\ndescription: ${desc} [perms v${PERMISSIONS_VERSION}]\nstage: GA\nincludedPermissions:\n` + perms.map((x) => `- ${x}`).join("\n") + "\n";
writeFileSync(join(out, "gcp-operate-custom-role.yaml"),
  role("platform-operate", "infra/modules/gcp/app plan/apply/destroy, IAM 정책 바꾸기 제외 (자동 생성)", gcpRest));
writeFileSync(join(out, "gcp-operate-iam-custom-role.yaml"),
  role("platform-operate-iam", "app- 접두어 SA·시크릿·버킷·토픽·구독의 IAM 정책만 (조건부 바인딩 필수, 자동 생성)", gcpIam));
// B-2: 환경 층(gcp/env)을 만드는 svc-env 역할 = 읽기 + 만들기 (지우기 없음: 환경 층은 사람이 지운다). worker 가 env 층 단계에서만 빌린다
writeFileSync(join(out, "gcp-env-custom-role.yaml"),
  role("platform-env", "infra/modules/gcp/env 만들기 (지우기·IAM 정책 바꾸기 없음, 자동 생성)", actionsFor(gcp.PERMS, [...gcp.ENV_LAYER_TYPES], "apply")));
// GCP ↔ 온프레 DB 복제 중계기 (worker relay/gcp-relay.ts): Cloud SQL 이 있는 VPC 에 GCE VM·방화벽 규칙, 출발 Cloud SQL 에 이전 전용 복제 계정.
//   연결 스크립트가 svc-operate 에 원래 프로젝트(gcp-onprem)와 전용 프로젝트(onprem-gcp) 둘 다 붙인다.
// DRAFT(ai): 목록 = gcp-relay.ts 가 부르는 gcloud 명령의 권한 (만들기·읽기·고치기·지우기). 감사 로그 실측으로 줄인다
const GCP_RELAY_PERMS = [
  "cloudsql.instances.get", "cloudsql.users.create", "cloudsql.users.delete", "cloudsql.users.list", "cloudsql.users.update",
  "compute.disks.create", "compute.firewalls.create", "compute.firewalls.delete", "compute.firewalls.get", "compute.firewalls.list", "compute.firewalls.update",
  "compute.globalAddresses.list", "compute.globalOperations.get", "compute.images.get", "compute.images.getFromFamily", "compute.images.useReadOnly",
  "compute.instances.create", "compute.instances.delete", "compute.instances.get", "compute.instances.list", "compute.instances.setLabels",
  "compute.instances.setMetadata", "compute.instances.setTags", "compute.machineTypes.get", "compute.networks.get", "compute.networks.updatePolicy",
  "compute.projects.get", "compute.subnetworks.get", "compute.subnetworks.list", "compute.subnetworks.use", "compute.subnetworks.useExternalIp",
  "compute.zoneOperations.get", "compute.zones.get",
].sort();
writeFileSync(join(out, "gcp-relay-custom-role.yaml"),
  role("platform-relay", "DB 복제 중계기 GCE VM·방화벽·복제 계정 (자동 생성)", GCP_RELAY_PERMS));
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
// PERM-GATE: 권한 묶음 (단계·클라우드·기능별 고객 주체·권한·API) = 위에서 쓴 파일 + 연결 스크립트 목록에서 뽑는다 (손으로 적은 두 번째 목록 없음).
//   worker 사전 점검·환경 권한 확인이 읽고(permission-bundles.json), 연결 스크립트 묶음 모드(ONLY_BUNDLES)가 읽는다(gcp-bundles.tsv)
const bundles = buildPermissionBundles(collectBundleInputs(out));
writeFileSync(join(out, PERMISSION_BUNDLES_FILE), JSON.stringify({ version: PERMISSIONS_VERSION, bundles }, null, 2) + "\n");
writeFileSync(join(out, GCP_BUNDLES_TSV), gcpBundlesTsv(PERMISSIONS_VERSION, bundles));
console.log(`AWS ${awsAll.length}개, GCP ${gcpRest.length}+${gcpIam.length}개(조건부), k8s 클러스터 ${clusterWide.length}·네임스페이스 ${perNs.length}규칙 → ${out}`);
