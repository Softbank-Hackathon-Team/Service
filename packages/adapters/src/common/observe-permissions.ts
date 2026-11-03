// OBSROLE2: 관찰 역할(고객 쪽 svc-observe)로 부르는 "모든" 클라우드 읽기 명령 → 필요한 권한 표.
//   부르는 곳: discover(index·aws-iam·data) · import/readers(ecs) · verify(aws·gcp) · precheck · security live(AWS_ALLOWED·GCLOUD_ALLOWED)
//   이 표가 단일 원본이다. AWS 관찰 인라인 정책(aws-connect-template.ts)·가져오기 장부 목록(worker import.ts)이 여기서 가져가고,
//   GCP 연결 스크립트(gcp-connect.sh)는 시험(obsrole2-all-commands.test.ts)이 소스의 모든 명령과 대조한다. 명령을 늘리면 이 표를 같이 늘려야 시험이 통과한다.
//   읽기만: 쓰기 동작·비밀값 읽기(secretsmanager:GetSecretValue·secretmanager.versions.access)·객체/메시지 내용 읽기는 표에 넣지 않는다 (시험이 금지 고정).
// null = 권한이 필요 없는 명령(로컬·토큰·자기 신원) 또는 프로젝트 역할 밖(아래 주석)

/** aws CLI "서비스 동사" → IAM 동작. */
export const AWS_COMMAND_ACTIONS: Record<string, string | null> = {
  "sts get-caller-identity": null,   // 자격이 있으면 항상 가능 (별도 권한 없음)
  "eks list-clusters": "eks:ListClusters",
  "eks describe-cluster": "eks:DescribeCluster",
  "eks update-kubeconfig": "eks:DescribeCluster",
  "eks list-pod-identity-associations": "eks:ListPodIdentityAssociations",
  "eks describe-pod-identity-association": "eks:DescribePodIdentityAssociation",
  "rds describe-db-instances": "rds:DescribeDBInstances",
  "rds describe-db-parameters": "rds:DescribeDBParameters",
  "rds describe-db-engine-versions": "rds:DescribeDBEngineVersions",
  "ec2 describe-vpcs": "ec2:DescribeVpcs",
  "ec2 describe-security-groups": "ec2:DescribeSecurityGroups",
  "ec2 describe-regions": "ec2:DescribeRegions",
  "ec2 describe-addresses": "ec2:DescribeAddresses",
  // VMIMPORT: VM 출발 읽기(import/readers/aws-ec2.ts). user-data(describe-instance-attribute)·콘솔 출력은 부르지 않는다
  "ec2 describe-instances": "ec2:DescribeInstances",
  "ec2 describe-instance-types": "ec2:DescribeInstanceTypes",
  "elbv2 describe-load-balancers": "elasticloadbalancing:DescribeLoadBalancers",
  // I9 ECS 출발 읽기(import/readers/aws-ecs.ts). ECS_OBSERVE_ACTIONS 와 같은 11개 (시험이 대조)
  "ecs list-clusters": "ecs:ListClusters",
  "ecs list-services": "ecs:ListServices",
  "ecs describe-services": "ecs:DescribeServices",
  "ecs describe-task-definition": "ecs:DescribeTaskDefinition",   // 작업 정의 본문. 환경변수 secrets 는 ARN 만 (값 아님)
  "ecs list-tasks": "ecs:ListTasks",
  "ecs describe-tasks": "ecs:DescribeTasks",
  "elbv2 describe-target-groups": "elasticloadbalancing:DescribeTargetGroups",
  "elbv2 describe-listeners": "elasticloadbalancing:DescribeListeners",
  "elbv2 describe-rules": "elasticloadbalancing:DescribeRules",
  "application-autoscaling describe-scalable-targets": "application-autoscaling:DescribeScalableTargets",
  "application-autoscaling describe-scaling-policies": "application-autoscaling:DescribeScalingPolicies",
  "ecr describe-repositories": "ecr:DescribeRepositories",
  "secretsmanager list-secrets": "secretsmanager:ListSecrets",   // 이름·메타데이터만. 값(GetSecretValue)은 금지
  "iam get-role": "iam:GetRole",
  "iam list-attached-role-policies": "iam:ListAttachedRolePolicies",
  "iam get-policy": "iam:GetPolicy",
  "iam get-policy-version": "iam:GetPolicyVersion",
  "iam list-role-policies": "iam:ListRolePolicies",
  "iam get-role-policy": "iam:GetRolePolicy",
  "guardduty list-detectors": "guardduty:ListDetectors",
  "service-quotas get-service-quota": "servicequotas:GetServiceQuota",
  "s3api list-buckets": "s3:ListAllMyBuckets",
  "s3api get-bucket-versioning": "s3:GetBucketVersioning",
  "s3api get-public-access-block": "s3:GetBucketPublicAccessBlock",   // CLI 이름과 IAM 이름이 다름
  "s3api get-bucket-policy-status": "s3:GetBucketPolicyStatus",
  "s3api get-bucket-acl": "s3:GetBucketAcl",
  "s3api get-bucket-lifecycle-configuration": "s3:GetLifecycleConfiguration",
  "s3api get-bucket-cors": "s3:GetBucketCORS",
  "cloudwatch get-metric-statistics": "cloudwatch:GetMetricStatistics",
  "sqs list-queues": "sqs:ListQueues",
  "sqs get-queue-attributes": "sqs:GetQueueAttributes",
  "elasticache describe-replication-groups": "elasticache:DescribeReplicationGroups",
  "elasticache describe-cache-clusters": "elasticache:DescribeCacheClusters",
};

/** gcloud "그룹 … 동사" → 프로젝트 권한(여러 개일 수 있음). */
export const GCP_COMMAND_PERMISSIONS: Record<string, string[] | null> = {
  "config get-value": null,                // 로컬 설정
  "auth print-access-token": null,         // 현재 자격의 토큰 (로컬)
  "billing projects describe": null,       // 프로젝트 역할 밖: 결제 계정 권한(roles/billing.viewer)은 고객이 따로. 없으면 precheck 가 WARN
  "projects describe": ["resourcemanager.projects.get"],
  "projects get-iam-policy": ["resourcemanager.projects.getIamPolicy"],
  "services list": ["serviceusage.services.list"],
  "container clusters list": ["container.clusters.list"],
  "container clusters describe": ["container.clusters.get"],
  "container clusters get-credentials": ["container.clusters.get"],
  "sql instances list": ["sql.instances.list"],
  "sql instances describe": ["sql.instances.get"],
  "compute networks list": ["compute.networks.list"],
  "compute forwarding-rules list": ["compute.forwardingRules.list", "compute.globalForwardingRules.list"],   // 지역·전역 둘 다 나열
  "compute firewall-rules list": ["compute.firewalls.list"],
  "compute instances list": ["compute.instances.list"],   // VMIMPORT: GCE 출발 읽기(import/readers/gcp-gce.ts). metadata(startup-script)는 못 읽는 목록 권한만
  "compute regions describe": ["compute.regions.get"],
  "artifacts repositories list": ["artifactregistry.repositories.list"],
  "secrets list": ["secretmanager.secrets.list"],   // 이름·메타데이터만. 값(versions.access)은 금지
  "iam service-accounts describe": ["iam.serviceAccounts.get"],
  "storage buckets list": ["storage.buckets.list"],
  "storage buckets get-iam-policy": ["storage.buckets.getIamPolicy"],
  "pubsub topics list": ["pubsub.topics.list"],
  "pubsub subscriptions list": ["pubsub.subscriptions.list"],
  "redis instances list": ["redis.instances.list"],
  // CRIMPORT: Cloud Run 출발 읽기(import/readers/gcp-cloudrun.ts). CLOUDRUN_OBSERVE_PERMISSIONS 와 같은 목록 (시험이 대조)
  //   DRAFT(ai): 모든 지역 목록은 지역 목록(run.locations.list)도 부른다
  "run services list": ["run.services.list", "run.locations.list"],
  "run revisions describe": ["run.revisions.get"],              // 판의 imageDigest. 환경변수 비밀은 이름·버전만 (값 아님)
  "run services get-iam-policy": ["run.services.getIamPolicy"], // 공개 여부(allUsers 호출 권한)만 본다
  "run domain-mappings list": ["run.domainmappings.list"],
  "run jobs list": ["run.jobs.list"],
  "scheduler jobs list": ["cloudscheduler.jobs.list"],           // 잡을 부르는 일정(cron). 대상 URI·일정만 읽음
};

/** 명령 키들에 필요한 권한(중복 없음, 입력 순서). 표에 없는 키면 던진다 — 장부 목록이 조용히 비지 않게 */
export function actionsOfCommands(table: "aws" | "gcp", keys: readonly string[]): string[] {
  const out: string[] = [];
  for (const k of keys) {
    const v = table === "aws" ? AWS_COMMAND_ACTIONS[k] : GCP_COMMAND_PERMISSIONS[k];
    if (v === undefined) throw new Error(`observe-permissions: 표에 없는 ${table} 명령 "${k}"`);
    for (const a of v === null ? [] : Array.isArray(v) ? v : [v]) if (!out.includes(a)) out.push(a);
  }
  return out;
}
