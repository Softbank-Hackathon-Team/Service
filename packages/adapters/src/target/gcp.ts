import type { AppSpecV2, TargetBuilder, TfOutputs, TfRootCall } from "@svc/contracts";
import { actionsFor } from "../common/actions.js";
import { appNamespace, dbInstanceName } from "../common/base.js";
import { envRef, fromOut, regionOf, tenantOf, type Target } from "../common/target.js";
import { gcpAdapter, PERMS } from "../gcp/index.js";
import {
  asV1Name, assertRenderable, connectIdentities, identitiesOf, identityName, instancesOf, K8S_RENDER_CAPS, kindJson,
  managedJobsOf, managedServicesOf, postgresOf, postureOfComponent, refV2, secretNamesOf, UNSUPPORTED_V2, vmServicesOf, workloadsOf,
} from "./shared.js";
import { assertGrants, gcpGrantTypes, grantsJsonFor } from "./grants.js";
import { secretStoreName } from "./capability-checks.js";
import { buildWorkloadValues, cloudPostgresValues, INGRESS_SECRETS } from "./cloud.js";
import { cacheVars, cachesOf, dataTypesOf, objectStoreVars, objectStoresOf, queueVars, queuesOf } from "./data.js";
import { assertDataFit, dbIdentityFor } from "./data-fit.js";
import { cloudSubstitutes } from "./cloud-substitutes.js";
import { AdapterError } from "../common/errors.js";
import { managedJobJson, managedServiceJson, managedWorkloadValues } from "./managed.js";
import { vmServiceJson, vmWorkloadValues } from "./vm.js";

// DRAFT(ai): GCP 도착 Builder v2 (설계 27번 A1). 루트 = infra/modules/gcp/root, 종류 = kinds/{postgres,identity,namespace}

// DRAFT(ai): H-A6 기본 — Cloud SQL 맞춤 등급 db-custom-<vCPU>-<MiB>. vCPU 1 또는 짝수, 메모리 256MiB 배수,
//   vCPU 당 0.9~6.5GB 【추정: Cloud SQL 문서 기억, 실계정 확인 필요】. compute 없으면 null → 모듈 기본(db-f1-micro, v1 과 같음)
export function cloudSqlTierFor(c: { cpuMilli: number | null; memMiB: number | null } | undefined): string | null {
  if (!c || (c.cpuMilli == null && c.memMiB == null)) return null;
  let cpu = Math.max(1, Math.ceil((c.cpuMilli ?? 1000) / 1000));
  if (cpu > 1 && cpu % 2) cpu += 1;
  // VTA1: vCPU 당 메모리 상한(6.5GiB) 때문에 요청 메모리가 안 들어가면 vCPU 를 올린다 (메모리를 낮추지 않음, H-A6). 최대 96 vCPU
  const memWant = Math.ceil((c.memMiB ?? 0) / 256) * 256;
  const maxMem = (n: number) => Math.floor((n * 6.5 * 1024) / 256) * 256;
  while (cpu < 96 && maxMem(cpu) < memWant) cpu = cpu === 1 ? 2 : cpu + 2;
  // SZ-1: 96 vCPU 로도 안 들어가면 메모리를 줄이지 않고 막는다
  if (Math.ceil((c.cpuMilli ?? 0) / 1000) > 96 || memWant > maxMem(96))
    throw new AdapterError(UNSUPPORTED_V2, `출발 DB 크기(${c.cpuMilli ?? "?"}m·${c.memMiB ?? "?"}MiB)가 Cloud SQL 도착 최대(96vCPU·${maxMem(96)}MiB)보다 큼 → 낮춰 고르지 않음. 사람이 정함`);
  const min = Math.max(3840, Math.ceil((cpu * 0.9 * 1024) / 256) * 256), max = maxMem(cpu);
  const mem = Math.min(max, Math.max(min, memWant));
  return `db-custom-${cpu}-${mem}`;
}

// TA12 DRAFT(ai): 데이터 자원 — Memorystore(redis·valkey, 클러스터 모드는 모듈이 아직 안 함 → capability 없음)·Cloud Storage·Pub/Sub
// A8: 출발 IAM 권한 → 도착 신원 권한 (target/grants.ts). 대응표 밖은 assertGrants·precheck 가 막음
// TA12c: link.* = 데이터 자원 링크의 의도 요약 (실제 권한은 grants 로 그림)
const CAPS = [...K8S_RENDER_CAPS, "volume.pvc", "kind.postgres.15", "kind.postgres.16", "kind.postgres.17", "kind.cache.redis", "kind.cache.valkey", "kind.objectStore", "kind.queue", "render.grants", "posture.permissions", "pg.param.cloudsql", "kind.queue.dlqMixedOrder", "kind.queue.push", "kind.queue.filter", "kind.queue.retainAcked", "kind.queue.subscriptions", "kind.cache.auth", "link.read", "link.write", "link.readwrite", "link.admin",
  // TA13: 관리형 컨테이너 → Cloud Run (root service_json + kinds/service-cloudrun). 못 그리는 칸은 managedBlockers
  "runtime.managedContainer",
  // RUNTIMEMAP v2: VM 출발 → GCE (root vm_json + kinds/vm). 못 그리는 칸은 vmBlockers
  "runtime.vm"];

// B-2 (나): k8s 도착에 입구가 있으면(buildWorkloadValues 가 cloudflared 를 그리는 조건) 입구 파드 비밀 그릇을 루트가 값 없이 만든다.
//   ESO 는 그릇마다 받은 읽기만 있어서 사람이 손으로 만든 그릇은 못 읽는다
const ingressSecretsOf = (spec: AppSpecV2): string[] =>
  managedServicesOf(spec).length || vmServicesOf(spec).length || !spec.entry?.hosts.length ? [] : [...INGRESS_SECRETS];

// kinds/namespace 입력(namespace_json). 관리형·VM 도착엔 앱 구역이 없다. GCP 는 구역 한도를 안 건다(null → 모듈이 ResourceQuota 를 안 만듦).
//   toTerraformV2 와 resourceTypesV2 가 같은 값을 봐서, 한도를 켜면 권한(kubernetes_resource_quota_v1)도 같이 따라온다
type NamespaceCfg = { name: string; quota_cpu_m: number | null; quota_memory_mi: number | null };
const namespaceCfgOf = (spec: AppSpecV2): NamespaceCfg[] =>
  managedServicesOf(spec).length || vmServicesOf(spec).length ? [] : [{ name: appNamespace(asV1Name(spec)), quota_cpu_m: null, quota_memory_mi: null }];

export function resourceTypesV2(spec: AppSpecV2): string[] {
  const t = new Set(["data.google_client_config", "data.google_container_cluster", "kubernetes_namespace_v1"]);
  if (namespaceCfgOf(spec).some((n) => n.quota_cpu_m != null || n.quota_memory_mi != null)) t.add("kubernetes_resource_quota_v1");
  const managed = managedServicesOf(spec).length > 0;
  if (managed) {
    ["data.google_project", "google_service_account", "google_cloud_run_v2_service", "google_cloud_run_v2_service_iam_member"].forEach((x) => t.add(x));
    if (managedServicesOf(spec).some((w) => secretNamesOf(w).length)) ["google_secret_manager_secret", "google_secret_manager_secret_iam_member"].forEach((x) => t.add(x));
    // JOBBUILD: 관리형 예약 잡 = kinds/job (SA 2개 + Cloud Run job + 호출 권한 + Cloud Scheduler)
    if (managedJobsOf(spec).length) ["google_service_account", "google_cloud_run_v2_job", "google_cloud_run_v2_job_iam_member", "google_cloud_scheduler_job"].forEach((x) => t.add(x));
  }
  // RUNTIMEMAP v2: VM (= kinds/vm)
  const vms = vmServicesOf(spec);
  if (vms.length) {
    ["google_service_account", "google_compute_instance"].forEach((x) => t.add(x));
    if (vms.some((w) => secretNamesOf(w).length)) ["google_secret_manager_secret", "google_secret_manager_secret_iam_member"].forEach((x) => t.add(x));
  }
  if (!managed && !vms.length && identitiesOf(spec).length) ["google_service_account", "google_service_account_iam_member"].forEach((x) => t.add(x));
  if (!managed && !vms.length && (workloadsOf(spec).some((w) => secretNamesOf(w).length) || ingressSecretsOf(spec).length)) ["google_secret_manager_secret", "google_secret_manager_secret_iam_member"].forEach((x) => t.add(x));
  if (postgresOf(spec).length) ["google_sql_database_instance", "google_sql_database", "google_sql_user", "random_password",
    "google_secret_manager_secret", "google_secret_manager_secret_version", "google_secret_manager_secret_iam_member"].forEach((x) => t.add(x));
  dataTypesOf("gcp", spec).forEach((x) => t.add(x));
  gcpGrantTypes(spec).forEach((x) => t.add(x));   // A8fix: 옮긴 권한 바인딩 → 실행 역할에 그 자원의 setIamPolicy
  return [...t].sort();
}

export const gcpTarget: TargetBuilder = {
  provider: "gcp",
  version: "gcp-target@0.1.0",
  capabilities: () => [...CAPS].sort(),
  imageRef: (src, t) => gcpAdapter.imageRef(src, t),
  // GCP 는 세션 정책이 없다 → 이 목록 = 테넌트 SA 커스텀 역할 + testIamPermissions 사전 점검 (v1 과 같음)
  operateActionsV2: (spec, purpose) => actionsFor(PERMS, resourceTypesV2(spec), purpose),
  substitutionsV2: (spec, source) => cloudSubstitutes("gcp", spec, source),
  toTerraformV2(spec: AppSpecV2, t: Target): TfRootCall {
    assertRenderable(spec, CAPS);
    assertGrants("gcp", spec);
    assertDataFit("gcp", spec, { postgres: (c) => cloudSqlTierFor(c.props.compute) });   // SZ-1·CV-1: 표 밖이면 줄이지 않고 막음
    // TA13: 관리형 서비스가 있으면(섞임은 managedBlockers 가 막음) k8s 신원·네임스페이스 없이 service_json 만
    const managed = managedServicesOf(spec).length > 0;
    // RUNTIMEMAP v2: VM 도 같은 규칙 (k8s 신원·네임스페이스 없이 vm_json 만. 섞임은 vmBlockers 가 막음)
    const vm = vmServicesOf(spec).length > 0;
    const ids = managed || vm ? [] : identitiesOf(spec);
    const byId = new Map(workloadsOf(spec).map((w) => [w.id, w]));
    const postgres = postgresOf(spec).map((c) => {
      const pos = postureOfComponent(spec, c.id);
      return {
        id: c.id,
        // Cloud SQL: 삭제 뒤 1주 같은 이름 재사용 불가 → 이전마다 다른 해시 (v1 이름 그대로). seed 의 migrationId 는 워커 plan·apply·deploy 가 넣는다 (G8-1)
        // TODO(human): 같은 이전 안에서 apply 실패 → 자동 destroy → 다시 apply 하면 이름이 같아 1주 동안 막힘. apply 시도마다 바뀌는 접미어를 쓸지 정해야 함
        name: dbInstanceName(asV1Name(spec), t, 40),
        major_version: c.props.majorVersion!,
        storage_gb: Math.max(10, c.props.storageGb!),   // DRAFT(ai): Cloud SQL 최소 10GB (v1 과 같은 올림)
        // VTA1: 최소로 올린 저장 공간보다 작은 자동 확장 상한은 apply 가 실패한다 → 올린 값 이상으로
        storage_max_gb: c.props.storageMaxGb == null ? null : Math.max(c.props.storageMaxGb, Math.max(10, c.props.storageGb!)),
        instance_class: cloudSqlTierFor(c.props.compute),
        ha: c.props.ha ?? null,
        read_replicas: c.props.readReplicas ?? null,
        require_tls: c.props.tlsRequired !== false,
        port: c.props.port ?? null,   // DM-7
        // DBN-1·E10-2: 앱 DB·계정 이름 그대로 (못 읽으면 기본 + 사전 점검 경고, data-fit.ts)
        db_name: dbIdentityFor(spec, c).db,
        app_user: dbIdentityFor(spec, c).user,
        // BK-1: 출발 백업 보관·PITR·유지보수 창 그대로 (null = 상품 기본, 범위 밖은 data-fit 이 막음)
        backup_retention_days: c.props.backup?.retentionDays ?? null,
        pitr: c.props.backup?.pitr ?? null,
        maintenance_window: c.props.maintenanceWindow ?? null,
        parameters_json: JSON.stringify(Object.fromEntries(Object.entries(c.props.parameters ?? {}).sort(([a], [b]) => a.localeCompare(b)))),
        logical_replication: true as const,
        allow_from_json: JSON.stringify(connectIdentities(spec, c.id)),
        public: pos.public,
        peer_cidrs_json: JSON.stringify(pos.cidrs),
        public_subnet_ids_json: null,   // aws 만
        deletion_protection: true,      // DRAFT(ai): IR 에 없는 플랫폼 값. 데모 정리는 withDbNetworkV2(A3)
      };
    });
    const ns = appNamespace(asV1Name(spec));
    const identity = ids.map((i) => ({
      id: i.id,
      name: identityName(spec, i.id, t, 30),   // SA account_id 6~30자
      service_account: i.serviceAccount,
      secret_names_json: JSON.stringify([...new Set(i.workloads.flatMap((w) => secretNamesOf(byId.get(w)!)))].sort()),
      ...grantsJsonFor("gcp", spec, i.id),
    }));
    const ingressSecrets = ingressSecretsOf(spec);
    const instances = instancesOf("gcp", [
      ...postgres.map((p) => ({ kind: "postgres" as const, id: p.id })),
      ...identity.map((i) => ({ kind: "identity" as const, id: i.id })),
      ...cachesOf(spec).map((c) => ({ kind: "cache" as const, id: c.id })),
      ...objectStoresOf(spec).map((c) => ({ kind: "objectStore" as const, id: c.id })),
      ...queuesOf(spec).map((c) => ({ kind: "queue" as const, id: c.id })),
      ...managedServicesOf(spec).map((c) => ({ kind: "service" as const, id: c.id })),
      ...managedJobsOf(spec).map((c) => ({ kind: "job" as const, id: c.id })),   // JOBBUILD: 관리형 예약 잡
      ...vmServicesOf(spec).map((c) => ({ kind: "vm" as const, id: c.id })),
      ...(managed || vm ? [] : [{ kind: "namespace" as const, id: ns }]),
    ]);
    return {
      root: refV2("gcp/root", t),
      modules: [...new Set(instances.map((i) => i.module))].sort().map((m) => refV2(m, t)),
      vars: {
        project_id: t.projectId ?? envRef("projectId"),
        region: regionOf(t),
        app_name: spec.app.name,
        tenant_id: tenantOf(t),
        k8s_namespace: ns,
        network_id: t.networkId ?? envRef("networkId"),
        cluster_name: t.clusterName ?? envRef("clusterName"),
        cluster_location: t.clusterLocation ?? envRef("clusterLocation"),
        postgres_json: kindJson("postgres", postgres),
        namespace_json: kindJson("namespace", namespaceCfgOf(spec)),
        identity_json: kindJson("identity", identity),
        cache_json: cacheVars(spec, t, "gcp"),
        object_store_json: objectStoreVars(spec, t),
        queue_json: queueVars(spec, t),
        // 관리형이 없으면 키 자체를 안 둔다 (기존 계획 지문 그대로)
        ...(managed ? { service_json: managedServiceJson("gcp", spec, t, (src) => gcpAdapter.imageRef(src, t)) } : {}),
        // JOBBUILD: 관리형 앱의 예약 잡이 있을 때만 키를 둔다 (없으면 기존 계획 지문 그대로)
        ...(managedJobsOf(spec).length ? { job_json: managedJobJson("gcp", spec, t, (src) => gcpAdapter.imageRef(src, t)) } : {}),
        ...(vm ? { vm_json: vmServiceJson("gcp", spec, t, (src) => gcpAdapter.imageRef(src, t)) } : {}),
        ...(ingressSecrets.length ? { ingress_secret_names_json: JSON.stringify(ingressSecrets) } : {}),
      },
      instances,
    };
  },
  toWorkloadValues(spec: AppSpecV2, out: TfOutputs, t: Target) {
    assertRenderable(spec, CAPS);
    assertGrants("gcp", spec);
    if (vmServicesOf(spec).length) return vmWorkloadValues("gcp", spec, out, t, cloudPostgresValues(spec, out, "db_password_secret_id"));
    if (managedServicesOf(spec).length) return managedWorkloadValues("gcp", spec, out, t, cloudPostgresValues(spec, out, "db_password_secret_id"));
    return buildWorkloadValues(spec, out, t, {
      imageRef: (src) => gcpAdapter.imageRef(src, t),
      secretStore: { kind: "ClusterSecretStore", name: secretStoreName("gcp", out) },   // CL-4: env 출력 secret_store_name 이 있으면 그것
      // = kinds/identity 의 google_secret_manager_secret 규칙 (app- 접두어, v1 과 같음)
      remoteKey: (s) => `app-${spec.app.name}-${s.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`,   // TF4-3: . 도 - (모듈 kinds/identity 와 같은 규칙)
      // 신원별 GSA (루트 출력 identity_gsa_emails 를 펼친 키). 펼치기는 A3 배포 단계
      saAnnotations: (id) => ({ "iam.gke.io/gcp-service-account": fromOut(out, `identity.${id}.gsa_email`) }),
      postgres: cloudPostgresValues(spec, out, "db_password_secret_id", {}, 5432),   // Cloud SQL 은 5432 고정 (모듈 link port 도 "5432")
      ingressClass: "gce",
      ingressSecretsByApply: true,
    });
  },
};
