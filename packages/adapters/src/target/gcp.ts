import type { AppSpecV2, TargetBuilder, TfOutputs, TfRootCall } from "@svc/contracts";
import { actionsFor } from "../common/actions.js";
import { appNamespace, dbInstanceName } from "../common/base.js";
import { envRef, fromOut, regionOf, tenantOf, type Target } from "../common/target.js";
import { gcpAdapter, PERMS } from "../gcp/index.js";
import {
  asV1Name, assertRenderable, connectIdentities, identitiesOf, identityName, instancesOf, K8S_RENDER_CAPS, kindJson,
  postgresOf, postureOfComponent, refV2, secretNamesOf, workloadsOf,
} from "./shared.js";
import { assertGrants, gcpGrantTypes, grantsJsonFor } from "./grants.js";
import { buildWorkloadValues, cloudPostgresValues } from "./cloud.js";
import { cacheVars, cachesOf, dataTypesOf, objectStoreVars, objectStoresOf, queueVars, queuesOf } from "./data.js";

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
  const min = Math.max(3840, Math.ceil((cpu * 0.9 * 1024) / 256) * 256), max = maxMem(cpu);
  const mem = Math.min(max, Math.max(min, memWant));
  return `db-custom-${cpu}-${mem}`;
}

// TA12 DRAFT(ai): 데이터 자원 — Memorystore(redis·valkey, 클러스터 모드는 모듈이 아직 안 함 → capability 없음)·Cloud Storage·Pub/Sub
// A8: 출발 IAM 권한 → 도착 신원 권한 (target/grants.ts). 대응표 밖은 assertGrants·precheck 가 막음
// TA12c: link.* = 데이터 자원 링크의 의도 요약 (실제 권한은 grants 로 그림)
const CAPS = [...K8S_RENDER_CAPS, "kind.postgres.15", "kind.postgres.16", "kind.postgres.17", "kind.cache.redis", "kind.cache.valkey", "kind.objectStore", "kind.queue", "render.grants", "posture.permissions", "kind.queue.dlqMixedOrder", "kind.cache.auth", "link.read", "link.write", "link.readwrite", "link.admin"];

export function resourceTypesV2(spec: AppSpecV2): string[] {
  const t = new Set(["data.google_client_config", "data.google_container_cluster", "kubernetes_namespace_v1"]);
  if (identitiesOf(spec).length) ["google_service_account", "google_service_account_iam_member"].forEach((x) => t.add(x));
  if (workloadsOf(spec).some((w) => secretNamesOf(w).length)) ["google_secret_manager_secret", "google_secret_manager_secret_iam_member"].forEach((x) => t.add(x));
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
  toTerraformV2(spec: AppSpecV2, t: Target): TfRootCall {
    assertRenderable(spec, CAPS);
    assertGrants("gcp", spec);
    const ids = identitiesOf(spec);
    const byId = new Map(workloadsOf(spec).map((w) => [w.id, w]));
    const postgres = postgresOf(spec).map((c) => {
      const pos = postureOfComponent(spec, c.id);
      return {
        id: c.id,
        // Cloud SQL: 삭제 뒤 1주 같은 이름 재사용 불가 → 이전마다 다른 해시 (v1 이름 그대로)
        name: dbInstanceName(asV1Name(spec), t, 40),
        major_version: c.props.majorVersion!,
        storage_gb: Math.max(10, c.props.storageGb!),   // DRAFT(ai): Cloud SQL 최소 10GB (v1 과 같은 올림)
        // VTA1: 최소로 올린 저장 공간보다 작은 자동 확장 상한은 apply 가 실패한다 → 올린 값 이상으로
        storage_max_gb: c.props.storageMaxGb == null ? null : Math.max(c.props.storageMaxGb, Math.max(10, c.props.storageGb!)),
        instance_class: cloudSqlTierFor(c.props.compute),
        ha: c.props.ha ?? null,
        read_replicas: c.props.readReplicas ?? null,
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
    const instances = instancesOf("gcp", [
      ...postgres.map((p) => ({ kind: "postgres" as const, id: p.id })),
      ...identity.map((i) => ({ kind: "identity" as const, id: i.id })),
      ...cachesOf(spec).map((c) => ({ kind: "cache" as const, id: c.id })),
      ...objectStoresOf(spec).map((c) => ({ kind: "objectStore" as const, id: c.id })),
      ...queuesOf(spec).map((c) => ({ kind: "queue" as const, id: c.id })),
      { kind: "namespace" as const, id: ns },
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
        namespace_json: kindJson("namespace", [{ name: ns, quota_cpu_m: null, quota_memory_mi: null }]),
        identity_json: kindJson("identity", identity),
        cache_json: cacheVars(spec, t),
        object_store_json: objectStoreVars(spec, t),
        queue_json: queueVars(spec, t),
      },
      instances,
    };
  },
  toWorkloadValues(spec: AppSpecV2, out: TfOutputs, t: Target) {
    assertRenderable(spec, CAPS);
    assertGrants("gcp", spec);
    return buildWorkloadValues(spec, out, t, {
      imageRef: (src) => gcpAdapter.imageRef(src, t),
      secretStore: { kind: "ClusterSecretStore", name: "gcp-secret-manager" },
      // = kinds/identity 의 google_secret_manager_secret 규칙 (app- 접두어, v1 과 같음)
      remoteKey: (s) => `app-${spec.app.name}-${s.toLowerCase().replace(/_/g, "-")}`,
      // 신원별 GSA (루트 출력 identity_gsa_emails 를 펼친 키). 펼치기는 A3 배포 단계
      saAnnotations: (id) => ({ "iam.gke.io/gcp-service-account": fromOut(out, `identity.${id}.gsa_email`) }),
      postgres: cloudPostgresValues(spec, out, "db_password_secret_id"),
      ingressClass: "gce",
    });
  },
};
