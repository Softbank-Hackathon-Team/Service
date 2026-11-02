import type { AppSpec, EnvironmentAdapter, TfOutputs } from "@svc/contracts";
import { actionsFor, type PermTable, type Purpose } from "../common/actions.js";
import { appNamespace, dbInstanceName, sourceImport, moduleRefOf, platformImageRef } from "../common/base.js";
import { buildValues } from "../common/k8s-values.js";
import { boundedName } from "../common/names.js";
import { envRef, fromOut, nameSeed, regionOf, tenantOf, type Target } from "../common/target.js";

// DRAFT(ai): 권한 목록은 문서 기준 추정. 실계정 PERMISSION_DENIED 로그로 확인 필요
export const PERMS: PermTable = {
  "data.google_client_config": { read: [], write: [], remove: [] },   // 현재 자격 증명의 토큰만 읽음
  "data.google_container_cluster": { read: ["container.clusters.get"], write: [], remove: [] },
  // GKE는 k8s API 호출도 IAM 권한으로 확인한다 (container.namespaces.*)
  kubernetes_namespace_v1: {
    read: ["container.namespaces.get"],
    write: ["container.namespaces.create", "container.namespaces.update"],
    remove: ["container.namespaces.delete"] },
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
  google_pubsub_subscription: {
    read: ["pubsub.subscriptions.get"], write: ["pubsub.subscriptions.create", "pubsub.subscriptions.update"], remove: ["pubsub.subscriptions.delete"] },
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
};

export function resourceTypes(spec: AppSpec): string[] {
  const t = ["data.google_client_config", "data.google_container_cluster", "kubernetes_namespace_v1",
    "google_service_account", "google_service_account_iam_member"];
  if (spec.service.secretRefs.length) t.push("google_secret_manager_secret", "google_secret_manager_secret_iam_member");
  if (spec.database) t.push("google_sql_database_instance", "google_sql_database", "google_sql_user",
    "random_password", "google_secret_manager_secret", "google_secret_manager_secret_version",
    "google_secret_manager_secret_iam_member");
  return [...new Set(t)].sort();
}
// GCP엔 호출별로 좁히는 세션 정책이 없다 → 이 목록 = 테넌트 SA 커스텀 역할 + testIamPermissions 사전 점검
export const operateActions = (spec: AppSpec, purpose: Purpose) => actionsFor(PERMS, resourceTypes(spec), purpose);

// setIamPolicy 2개는 이 조건이 붙은 바인딩으로만 준다 (위협 모델 G-1, G-2).
// 플랫폼이 만드는 SA·시크릿은 모두 app- 로 시작한다 (infra/modules/gcp/app). 【추정】 조건 문법은 실계정에서 확인 필요
export const IAM_CONDITION =
  `(resource.type == "iam.googleapis.com/ServiceAccount" && resource.name.extract("serviceAccounts/{name}@").startsWith("app-")) || ` +
  `(resource.type == "secretmanager.googleapis.com/Secret" && resource.name.extract("/secrets/{name}").startsWith("app-"))`;

export function names(spec: AppSpec, t: Target) {
  const seed = [nameSeed(t), spec.app.name];
  return {
    // Cloud SQL: 삭제 후 최대 1주 같은 이름 재사용 불가 → 이전(migration)마다 다른 해시
    db_instance: dbInstanceName(spec, t, 40),
    app_sa: boundedName({ prefix: "app-", app: spec.app.name, seed, max: 30 }),   // SA account_id 6~30자
  };
}

export const gcpAdapter: EnvironmentAdapter = {
  provider: "gcp",
  version: "gcp@0.5.0",
  capabilities: () => ["workload.container", "arch.amd64", "arch.arm64", "ingress.cloudflared", "ingress.gce",
    "secrets.external", "db.postgres.15", "db.postgres.16", "db.postgres.17"],
  // Z88: 진짜 읽기 = gcloud(ADC·GCP_PROJECT)로 GKE 앱·Cloud SQL·VPC·LB·Artifact Registry·Secret Manager. MOCK_SEED=1 이면 데모 원본
  ...sourceImport("gcp"),
  requiredOperateActions: (spec) => operateActions(spec, "apply"),
  imageRef: (src: string, t: Target) =>
    platformImageRef(`${regionOf(t)}-docker.pkg.dev/${t.projectId ?? envRef("projectId")}`, t, src),
  toTerraform(spec, t: Target) {
    const n = names(spec, t);
    return {
      moduleRef: moduleRefOf("gcp/app", t),
      vars: {
        project_id: t.projectId ?? envRef("projectId"),
        region: regionOf(t),
        app_name: spec.app.name,
        tenant_id: tenantOf(t),
        k8s_namespace: appNamespace(spec),
        network_id: t.networkId ?? envRef("networkId"),
        cluster_name: t.clusterName ?? envRef("clusterName"),
        cluster_location: t.clusterLocation ?? envRef("clusterLocation"),
        name_db_instance: n.db_instance,
        name_app_sa: n.app_sa,
        secret_ids_json: JSON.stringify(spec.service.secretRefs.map((r) => r.name).sort()),
        db_enabled: Boolean(spec.database),
        db_version: `POSTGRES_${spec.database?.majorVersion ?? "16"}`,
        // DRAFT(ai): 데모 최소 크기(공유 코어). 운영 크기는 TODO(human)
        db_tier: "db-f1-micro",
        db_disk_gb: Math.max(10, spec.database?.storageGb ?? 10),
      },
    };
  },
  toHelmValues(spec, out: TfOutputs, t: Target) {
    return buildValues(spec, {
      tenant: tenantOf(t),
      imageRef: gcpAdapter.imageRef(spec.service.image, t),
      saAnnotations: { "iam.gke.io/gcp-service-account": fromOut(out, "app_gsa_email") },
      secretStore: { kind: "ClusterSecretStore", name: "gcp-secret-manager" },
      // 시크릿 id = infra/modules/gcp/app 의 google_secret_manager_secret.s 규칙 (app- 접두어)
      remoteKey: (r) => `app-${spec.app.name}-${r.name.toLowerCase().replace(/_/g, "-")}`,
      database: spec.database ? {
        mode: "external", host: fromOut(out, "db_private_ip"), port: 5432,
        name: spec.app.name, passwordSecret: fromOut(out, "db_password_secret_id"),
      } : null,
      ingressClass: "gce",
    });
  },
};
