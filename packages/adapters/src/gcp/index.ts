import type { EnvironmentAdapter } from "@svc/contracts";
import { actionsFor, type PermTable, type Purpose } from "../common/actions.js";
import { sourceImport, platformImageRef, type PermNeeds } from "../common/base.js";
import { envRef, regionOf, type Target } from "../common/target.js";

// DRAFT(ai): 권한 목록은 문서 기준 추정. 실계정 PERMISSION_DENIED 로그로 확인 필요
export const PERMS: PermTable = {
  "data.google_client_config": { read: [], write: [], remove: [] },   // 현재 자격 증명의 토큰만 읽음
  "data.google_container_cluster": { read: ["container.clusters.get"], write: [], remove: [] },
  // GKE는 k8s API 호출도 IAM 권한으로 확인한다 (container.namespaces.*)
  kubernetes_namespace_v1: {
    read: ["container.namespaces.get"],
    write: ["container.namespaces.create", "container.namespaces.update"],
    remove: ["container.namespaces.delete"] },
  // Argo CD 허브의 앱 구역 권한 (kinds/namespace). GKE RBAC 은 내가 가진 것보다 큰 Role 을 막아서 escalate·bind 가 필요하다
  // DRAFT(ai): 프로젝트 전체에 걸리지만 도착은 전용 프로젝트이고 실행 역할은 이전 때만 빌린다. 첫 실측에서 권한 이름 확인
  kubernetes_role_v1: {
    read: ["container.roles.get"],
    write: ["container.roles.create", "container.roles.update", "container.roles.escalate"],
    remove: ["container.roles.delete"] },
  kubernetes_role_binding_v1: {
    read: ["container.roleBindings.get"],
    write: ["container.roleBindings.create", "container.roleBindings.update", "container.roles.bind"],
    remove: ["container.roleBindings.delete"] },
  google_sql_database_instance: {
    read: ["cloudsql.instances.get"],
    write: ["cloudsql.instances.create", "cloudsql.instances.update"],
    remove: ["cloudsql.instances.delete"] },
  google_sql_database: {
    read: ["cloudsql.databases.get"],
    write: ["cloudsql.databases.create", "cloudsql.databases.update"],
    remove: ["cloudsql.databases.delete"] },
  // TA12 DRAFT(ai): 데이터 자원 종류 권한. 【미확인】 gcp-operate-custom-role.yaml 에는 아직 없음(경계 밖 TODO)
  google_redis_instance: {
    read: ["redis.instances.get"], write: ["redis.instances.create", "redis.instances.update"], remove: ["redis.instances.delete"] },
  google_storage_bucket: {
    read: ["storage.buckets.get"], write: ["storage.buckets.create", "storage.buckets.update"], remove: ["storage.buckets.delete"] },
  google_pubsub_topic: {
    read: ["pubsub.topics.get"], write: ["pubsub.topics.create", "pubsub.topics.update"], remove: ["pubsub.topics.delete"] },
  // A8fix: 옮긴 권한(grants) 바인딩 = 그 자원 하나의 IAM 정책 (프로젝트 setIamPolicy 아님). 조건부 역할(IAM_CONDITION)로 app- 자원에만
  google_storage_bucket_iam_member: {
    read: ["storage.buckets.getIamPolicy"], write: ["storage.buckets.setIamPolicy"], remove: ["storage.buckets.setIamPolicy"] },
  google_pubsub_topic_iam_member: {
    read: ["pubsub.topics.getIamPolicy"], write: ["pubsub.topics.setIamPolicy"], remove: ["pubsub.topics.setIamPolicy"] },
  google_pubsub_subscription_iam_member: {
    read: ["pubsub.subscriptions.getIamPolicy"], write: ["pubsub.subscriptions.setIamPolicy"], remove: ["pubsub.subscriptions.setIamPolicy"] },
  google_pubsub_subscription: {
    read: ["pubsub.subscriptions.get"], write: ["pubsub.subscriptions.create", "pubsub.subscriptions.update", "pubsub.topics.attachSubscription"], remove: ["pubsub.subscriptions.delete"] },
  google_sql_user: {
    read: ["cloudsql.users.list"],
    write: ["cloudsql.users.create", "cloudsql.users.update"],
    remove: ["cloudsql.users.delete"] },
  google_secret_manager_secret: {
    read: ["secretmanager.secrets.get"],
    write: ["secretmanager.secrets.create", "secretmanager.secrets.update"],
    remove: ["secretmanager.secrets.delete"] },
  google_secret_manager_secret_version: {
    read: ["secretmanager.versions.get"],
    write: ["secretmanager.versions.add"],
    remove: ["secretmanager.versions.destroy"] },
  random_password: { read: [], write: [], remove: [] },   // 로컬 자원 (클라우드 권한 불필요)
  // FM-CLD-hunt-cloud-23: gcp/root 가 IR 종류에 맞춰 API 를 켠다(FM-CLD-14 google_project_service). provider 는 켜진 목록을 읽고(get·list) 없으면 enable.
  //   disable_on_destroy=false 라 지울 때는 아무것도 안 부른다. 결정 3번 A안: 전용 프로젝트 안에서만
  google_project_service: {
    read: ["serviceusage.services.get", "serviceusage.services.list"], write: ["serviceusage.services.enable"], remove: [] },
  google_secret_manager_secret_iam_member: {
    read: ["secretmanager.secrets.getIamPolicy"],
    write: ["secretmanager.secrets.setIamPolicy"],
    remove: ["secretmanager.secrets.setIamPolicy"] },
  google_service_account: {
    read: ["iam.serviceAccounts.get"],
    write: ["iam.serviceAccounts.create", "iam.serviceAccounts.update"],
    remove: ["iam.serviceAccounts.delete"] },
  google_service_account_iam_member: {
    read: ["iam.serviceAccounts.getIamPolicy"],
    write: ["iam.serviceAccounts.setIamPolicy"],
    remove: ["iam.serviceAccounts.setIamPolicy"] },
  // TA13 DRAFT(ai): 관리형 컨테이너(Cloud Run) 도착. TODO(human): 커스텀 역할 천장(gcp-operate-custom-role.yaml)엔 아직 안 넣음 —
  //   SA 를 서비스에 붙이는 iam.serviceAccounts.actAs 가 permissions-lint 금지 목록이라 보안 승인 몫
  "data.google_project": { read: ["resourcemanager.projects.get"], write: [], remove: [] },
  google_cloud_run_v2_service: {
    read: ["run.services.get"], write: ["run.services.create", "run.services.update", "run.operations.get", "iam.serviceAccounts.actAs"],
    remove: ["run.services.delete"] },
  // JOBMOD DRAFT(ai): 예약 잡(Cloud Scheduler → Cloud Run job). kinds/job 이 만드는 종류. 천장 파일엔 아직 안 넣음 (위와 같은 이유)
  google_cloud_run_v2_job: {
    read: ["run.jobs.get"], write: ["run.jobs.create", "run.jobs.update", "run.operations.get", "iam.serviceAccounts.actAs"], remove: ["run.jobs.delete"] },
  google_cloud_run_v2_job_iam_member: {
    read: ["run.jobs.getIamPolicy"], write: ["run.jobs.setIamPolicy"], remove: ["run.jobs.setIamPolicy"] },
  google_cloud_scheduler_job: {
    read: ["cloudscheduler.jobs.get"], write: ["cloudscheduler.jobs.create", "cloudscheduler.jobs.update"], remove: ["cloudscheduler.jobs.delete"] },
  google_cloud_run_v2_service_iam_member: {
    read: ["run.services.getIamPolicy"], write: ["run.services.setIamPolicy"], remove: ["run.services.setIamPolicy"] },
  // 이전 중 도착 GKE 업그레이드 멈춤 (gcp/upgrade-freeze.ts). terraform 자원이 아니라 워커가 gcloud 로 거는 maintenance exclusion
  // DRAFT(ai): container.clusters.update 는 필드 단위로 못 좁힌다 (IAM 조건이 요청 필드를 못 봄) → 실행 SA 가 전용 프로젝트에만 있는 것(A안)으로 범위를 막는다
  gke_upgrade_freeze: { read: ["container.clusters.get"], write: ["container.clusters.update"], remove: [] },
  // B-2 DRAFT(ai): 환경 층(infra/modules/gcp/env)을 만드는 고객 svc-env 권한. 문서 기준 추정 → 첫 실측 거부 로그로 보정.
  //   remove 는 비운다: 환경 층은 플랫폼이 지우지 않고 사람이 지운다
  google_compute_network: { read: ["compute.networks.get"], write: ["compute.networks.create", "compute.globalOperations.get"], remove: [] },
  google_compute_subnetwork: {
    read: ["compute.subnetworks.get"], write: ["compute.subnetworks.create", "compute.networks.updatePolicy", "compute.regionOperations.get"], remove: [] },
  google_compute_global_address: {
    read: ["compute.globalAddresses.get"], write: ["compute.globalAddresses.createInternal", "compute.globalAddresses.setLabels", "compute.networks.use", "compute.globalOperations.get"], remove: [] },
  // provider 가 연결을 읽을 때 프로젝트 번호를 찾는다 (resourcemanager.projects.get)
  google_service_networking_connection: {
    read: ["servicenetworking.services.get", "resourcemanager.projects.get"], write: ["servicenetworking.services.addPeering", "servicenetworking.operations.get"], remove: [] },
  google_compute_router: {
    read: ["compute.routers.get"], write: ["compute.routers.create", "compute.networks.updatePolicy", "compute.regionOperations.get"], remove: [] },
  // provider 는 라벨을 만들기 뒤 setLabels 로 따로 붙인다 (전역·지역 주소 둘 다, 11/06 실측 403)
  google_compute_address: { read: ["compute.addresses.get"], write: ["compute.addresses.create", "compute.addresses.setLabels", "compute.regionOperations.get"], remove: [] },
  google_compute_router_nat: {
    read: ["compute.routers.get"], write: ["compute.routers.update", "compute.addresses.use", "compute.regionOperations.get"], remove: [] },
  // 노드 풀 만들기·기본 풀 걷기 = container.clusters.update (GKE API 권한표). 노드 SA 를 붙이는 actAs 는 역할이 아니라 svc-gke-node 한 SA 에만 (gcp-connect.sh)
  google_container_cluster: {
    read: ["container.clusters.get", "container.operations.get"], write: ["container.clusters.create", "container.clusters.update"], remove: [] },
  // 노드 풀 읽기는 instance_group_urls 를 위해 관리형 인스턴스 그룹을 읽는다 (11/06 실측 403)
  google_container_node_pool: { read: ["container.clusters.get", "container.operations.get", "compute.instanceGroupManagers.get"], write: ["container.clusters.update"], remove: [] },
  google_artifact_registry_repository: { read: ["artifactregistry.repositories.get"], write: ["artifactregistry.repositories.create"], remove: [] },
  // ESO 차트 + cluster-secret-store 차트가 클러스터 안에 만드는 것 (CRD·ClusterRole·ClusterRoleBinding·웹훅·배포·CR). GKE 는 k8s 호출을 IAM 권한으로도 본다.
  //   helm 은 릴리스 기록을 Secret 에 둔다 (secrets get·list·create·update). 자기보다 큰 ClusterRole 을 만들고 묶으려면 escalate·bind
  helm_release: {
    read: ["container.namespaces.get", "container.customResourceDefinitions.get", "container.customResourceDefinitions.list", "container.clusterRoles.get",
      "container.clusterRoleBindings.get", "container.roles.get", "container.roleBindings.get", "container.serviceAccounts.get", "container.deployments.get",
      "container.deployments.list", "container.replicaSets.list", "container.pods.list", "container.services.get", "container.secrets.get", "container.secrets.list",
      "container.validatingWebhookConfigurations.get", "container.thirdPartyObjects.get", "container.thirdPartyObjects.list"],
    write: ["container.namespaces.create", "container.customResourceDefinitions.create", "container.customResourceDefinitions.update",
      "container.clusterRoles.create", "container.clusterRoles.update", "container.clusterRoles.bind", "container.clusterRoles.escalate",
      "container.clusterRoleBindings.create", "container.clusterRoleBindings.update", "container.roles.create", "container.roles.update",
      "container.roles.bind", "container.roles.escalate", "container.roleBindings.create", "container.roleBindings.update",
      "container.serviceAccounts.create", "container.serviceAccounts.update", "container.deployments.create", "container.deployments.update",
      "container.services.create", "container.services.update", "container.secrets.create", "container.secrets.update",
      "container.validatingWebhookConfigurations.create", "container.validatingWebhookConfigurations.update",
      "container.thirdPartyObjects.create", "container.thirdPartyObjects.update"],
    remove: [] },
  // 만들기 전 "도착 프로젝트에 고객 GKE 가 이미 있나" 확인 (worker env-layer.ts listGkeClusters)
  env_layer_cluster_check: { read: ["container.clusters.list"], write: [], remove: [] },
};

// B-2: svc-env 커스텀 역할(gcp-env-custom-role.yaml) = 이 종류들의 읽기 + 만들기. 모듈의 자원 종류는 전부 여기 있어야 한다 (시험이 대조).
//   IAM 자원은 없다: ESO 는 GSA 없이 자기 KSA 로 읽고, 비밀마다 읽기 권한은 앱 층(gcp/root)이 준다 (B-2 나)
export const ENV_LAYER_TYPES = ["data.google_client_config", "env_layer_cluster_check", "google_artifact_registry_repository",
  "google_compute_address", "google_compute_global_address", "google_compute_network", "google_compute_router", "google_compute_router_nat",
  "google_compute_subnetwork", "google_container_cluster", "google_container_node_pool", "google_project_service", "google_service_networking_connection",
  "helm_release"] as const;

// FM-CLD-hunt-cloud-23: 앱 모듈 밖에서 실행 역할이 늘 하는 일 (gcp/root API 켜기, 이전 중 GKE 업그레이드 멈춤). 권한 파일·plan 역할에는 들어가야 함
export const ROOT_TYPES = ["google_project_service", "gke_upgrade_freeze", "kubernetes_role_v1", "kubernetes_role_binding_v1"] as const;
export function resourceTypes(need: PermNeeds): string[] {
  const t = ["data.google_client_config", "data.google_container_cluster", "kubernetes_namespace_v1",
    "google_service_account", "google_service_account_iam_member"];
  if (need.secrets) t.push("google_secret_manager_secret", "google_secret_manager_secret_iam_member");
  if (need.database) t.push("google_sql_database_instance", "google_sql_database", "google_sql_user",
    "random_password", "google_secret_manager_secret", "google_secret_manager_secret_version",
    "google_secret_manager_secret_iam_member");
  return [...new Set(t)].sort();
}
// GCP엔 호출별로 좁히는 세션 정책이 없다 → 이 목록 = 테넌트 SA 커스텀 역할 + testIamPermissions 사전 점검
export const operateActions = (need: PermNeeds, purpose: Purpose) => actionsFor(PERMS, resourceTypes(need), purpose);

// setIamPolicy 2개는 이 조건이 붙은 바인딩으로만 준다 (위협 모델 G-1, G-2).
// 플랫폼이 만드는 SA·시크릿은 모두 app- 로 시작한다 (infra/modules/gcp/app). 【추정】 조건 문법은 실계정에서 확인 필요
export const IAM_CONDITION =
  `(resource.type == "iam.googleapis.com/ServiceAccount" && resource.name.extract("serviceAccounts/{name}@").startsWith("app-")) || ` +
  `(resource.type == "secretmanager.googleapis.com/Secret" && resource.name.extract("/secrets/{name}").startsWith("app-")) || ` +
  // A8fix DRAFT(ai): 옮긴 권한 바인딩용 — app- 접두어 버킷·토픽·구독에만 setIamPolicy. TODO(human): 첫 실측에서 조건 식 확인
  `(resource.type == "storage.googleapis.com/Bucket" && resource.name.startsWith("projects/_/buckets/app-")) || ` +
  `(resource.type == "pubsub.googleapis.com/Topic" && resource.name.extract("/topics/{name}").startsWith("app-")) || ` +
  `(resource.type == "pubsub.googleapis.com/Subscription" && resource.name.extract("/subscriptions/{name}").startsWith("app-"))`;

export const gcpAdapter: EnvironmentAdapter = {
  provider: "gcp",
  version: "gcp@0.5.0",
  capabilities: () => ["workload.container", "arch.amd64", "arch.arm64", "ingress.cloudflared", "ingress.gce",
    "secrets.external", "db.postgres.15", "db.postgres.16", "db.postgres.17"],
  // Z88: 진짜 읽기 = gcloud(ADC·GCP_PROJECT)로 GKE 앱·Cloud SQL·VPC·LB·Artifact Registry·Secret Manager. MOCK_SEED=1 이면 데모 원본
  ...sourceImport("gcp"),
  imageRef: (src: string, t: Target) =>
    platformImageRef(`${regionOf(t)}-docker.pkg.dev/${t.projectId ?? envRef("projectId")}`, t, src),
};
