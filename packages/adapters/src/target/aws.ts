import type { AppSpecV2, TargetBuilder, TfOutputs, TfRootCall } from "@svc/contracts";
import { actionsFor } from "../common/actions.js";
import { appNamespace, dbInstanceName } from "../common/base.js";
import { envRef, regionOf, tenantOf, type Target } from "../common/target.js";
import { awsAdapter, BOUNDARY_NAME, PERMS } from "../aws/index.js";
import {
  asV1Name, assertRenderable, connectIdentities, identitiesOf, identityName, instancesOf, K8S_RENDER_CAPS, kindJson,
  managedServicesOf, postgresOf, postureOfComponent, refV2, secretNamesOf, workloadsOf,
} from "./shared.js";
import { assertGrants, grantsJsonFor } from "./grants.js";
import { buildWorkloadValues, cloudPostgresValues } from "./cloud.js";
import { cacheVars, cachesOf, dataTypesOf, objectStoreVars, objectStoresOf, queueVars, queuesOf } from "./data.js";
import { managedServiceJson, managedWorkloadValues } from "./managed.js";

// DRAFT(ai): AWS 도착 Builder v2 (설계 27번 A1). 루트 = infra/modules/aws/root, 종류 = kinds/{postgres,identity,namespace}.
// DECISION(team): AWS 도착 컴퓨트 = EKS (GKE·k3s와 같은 Helm 차트 재사용) (Jeong 2026-10-31) — v1 주석 그대로 따름

// DRAFT(ai): H-A6 기본 — IR compute 에서 가장 가까운(이상) 등급. compute 가 없으면 null → 모듈 기본(db.t4g.micro, v1 과 같음)
const RDS_CLASSES: Array<[string, number, number]> = [
  ["db.t4g.micro", 2000, 1024], ["db.t4g.small", 2000, 2048], ["db.t4g.medium", 2000, 4096], ["db.t4g.large", 2000, 8192],
  ["db.m6g.xlarge", 4000, 16384], ["db.m6g.2xlarge", 8000, 32768], ["db.m6g.4xlarge", 16000, 65536],
];
export function rdsClassFor(c: { cpuMilli: number | null; memMiB: number | null } | undefined): string | null {
  if (!c || (c.cpuMilli == null && c.memMiB == null)) return null;
  const hit = RDS_CLASSES.find(([, cpu, mem]) => cpu >= (c.cpuMilli ?? 0) && mem >= (c.memMiB ?? 0));
  return (hit ?? RDS_CLASSES[RDS_CLASSES.length - 1]!)[0];
}

// TA12 DRAFT(ai): 데이터 자원 — ElastiCache(redis·valkey, 클러스터 모드 가능)·S3·SQS/SNS. memcached 는 모듈이 안 만듦 → capability 없음(거부)
// A8: 출발 IAM 권한 → 도착 신원 권한 (target/grants.ts). 대응표 밖은 assertGrants·precheck 가 막음
const CAPS = [...K8S_RENDER_CAPS, "kind.postgres.15", "kind.postgres.16", "kind.postgres.17", "kind.cache.redis", "kind.cache.valkey", "kind.cache.cluster", "kind.objectStore", "kind.queue", "render.grants", "posture.permissions",
  // TA12c: 데이터 자원 링크의 의도 요약(read·write·readwrite·admin). 실제 권한은 grants → grants_json(A8)로 그림, 의도는 요약일 뿐
  "link.read", "link.write", "link.readwrite", "link.admin",
  // TA13: 관리형 컨테이너 → ECS Fargate (root service_json + kinds/service-ecs). 못 그리는 칸은 managedBlockers
  "runtime.managedContainer"];

export function resourceTypesV2(spec: AppSpecV2): string[] {
  const t = new Set(["data.aws_eks_cluster", "data.aws_eks_cluster_auth", "kubernetes_namespace_v1"]);
  // TA13: 관리형 (= root ECS 공용 자원 + kinds/service-ecs)
  const managed = managedServicesOf(spec);
  if (managed.length) {
    ["data.aws_caller_identity", "aws_ecs_cluster", "aws_service_discovery_http_namespace", "aws_security_group", "aws_cloudwatch_log_group",
      "aws_iam_role", "aws_iam_role_policy", "aws_ecs_task_definition", "aws_ecs_service"].forEach((x) => t.add(x));
    if (managed.some((m) => secretNamesOf(m).length)) t.add("aws_secretsmanager_secret");
    if (managed.some((m) => m.props.scale && m.props.replicas.max > m.props.replicas.min)) ["aws_appautoscaling_target", "aws_appautoscaling_policy"].forEach((x) => t.add(x));
  }
  const ids = managed.length ? [] : identitiesOf(spec);
  if (ids.length) ["aws_iam_role", "aws_iam_role_policy", "aws_eks_pod_identity_association"].forEach((x) => t.add(x));
  if (!managed.length && workloadsOf(spec).some((w) => secretNamesOf(w).length)) t.add("aws_secretsmanager_secret");
  if (postgresOf(spec).length) ["aws_db_instance", "aws_db_parameter_group", "aws_db_subnet_group", "aws_security_group"].forEach((x) => t.add(x));
  dataTypesOf("aws", spec).forEach((x) => t.add(x));
  return [...t].sort();
}

export const awsTarget: TargetBuilder = {
  provider: "aws",
  version: "aws-target@0.1.0",
  capabilities: () => [...CAPS].sort(),
  imageRef: (src, t) => awsAdapter.imageRef(src, t),
  operateActionsV2: (spec, purpose) => actionsFor(PERMS, resourceTypesV2(spec), purpose),
  toTerraformV2(spec: AppSpecV2, t: Target): TfRootCall {
    assertRenderable(spec, CAPS);
    assertGrants("aws", spec);
    // TA13: 관리형 서비스가 있으면(섞임은 managedBlockers 가 막음) k8s 신원·네임스페이스 없이 service_json 만
    const managed = managedServicesOf(spec).length > 0;
    const ids = managed ? [] : identitiesOf(spec);
    const byId = new Map(workloadsOf(spec).map((w) => [w.id, w]));
    const postgres = postgresOf(spec).map((c) => {
      const pos = postureOfComponent(spec, c.id);
      return {
        id: c.id,
        name: dbInstanceName(asV1Name(spec), t, 63),   // 복제 대상 1개 (2개 이상은 capability 로 막힘) → v1 이름 그대로
        major_version: c.props.majorVersion!,
        // DRAFT(ai): RDS 최소 20GB (v1 과 같은 올림). 출발이 더 크면 그대로
        storage_gb: Math.max(20, c.props.storageGb!),
        // VTA1: 최소로 올린 저장 공간보다 작은 자동 확장 상한은 apply 가 실패한다 → 올린 값 이상으로
        storage_max_gb: c.props.storageMaxGb == null ? null : Math.max(c.props.storageMaxGb, Math.max(20, c.props.storageGb!)),
        instance_class: rdsClassFor(c.props.compute),
        ha: c.props.ha ?? null,
        read_replicas: c.props.readReplicas ?? null,
        parameters_json: JSON.stringify(Object.fromEntries(Object.entries(c.props.parameters ?? {}).sort(([a], [b]) => a.localeCompare(b)))),
        logical_replication: true as const,
        allow_from_json: JSON.stringify(connectIdentities(spec, c.id)),
        public: pos.public,
        peer_cidrs_json: JSON.stringify(pos.cidrs),
        public_subnet_ids_json: pos.public ? envRef("dbPublicSubnetIdsJson") : null,
        // DRAFT(ai): IR 에 없는 플랫폼 값. 기본 켬(v1 db_deletion_protection 기본 true). 데모 정리는 withDbNetworkV2(A3)
        deletion_protection: true,
      };
    });
    const ns = appNamespace(asV1Name(spec));
    const identity = ids.map((i) => ({
      id: i.id,
      name: identityName(spec, i.id, t, 64),
      service_account: i.serviceAccount,
      secret_names_json: JSON.stringify([...new Set(i.workloads.flatMap((w) => secretNamesOf(byId.get(w)!)))].sort()),
      ...grantsJsonFor("aws", spec, i.id),
    }));
    const instances = instancesOf("aws", [
      ...postgres.map((p) => ({ kind: "postgres" as const, id: p.id })),
      ...identity.map((i) => ({ kind: "identity" as const, id: i.id })),
      ...cachesOf(spec).map((c) => ({ kind: "cache" as const, id: c.id })),
      ...objectStoresOf(spec).map((c) => ({ kind: "objectStore" as const, id: c.id })),
      ...queuesOf(spec).map((c) => ({ kind: "queue" as const, id: c.id })),
      ...managedServicesOf(spec).map((c) => ({ kind: "service" as const, id: c.id })),
      ...(managed ? [] : [{ kind: "namespace" as const, id: ns }]),
    ]);
    const acct = t.accountId ?? envRef("accountId");
    return {
      root: refV2("aws/root", t),
      modules: [...new Set(instances.map((i) => i.module))].sort().map((m) => refV2(m, t)),
      vars: {
        expected_account_id: acct,
        region: regionOf(t),
        app_name: spec.app.name,
        tenant_id: tenantOf(t),
        cluster_name: t.clusterName ?? envRef("clusterName"),
        vpc_id: t.vpcId ?? envRef("vpcId"),
        db_subnet_ids_json: t.subnetIds ? JSON.stringify([...t.subnetIds].sort()) : envRef("dbSubnetIdsJson"),
        k8s_namespace: ns,
        app_role_boundary_arn: `arn:aws:iam::${acct}:policy/${BOUNDARY_NAME}`,
        postgres_json: kindJson("postgres", postgres),
        // DRAFT(ai): aws·gcp 는 v1 처럼 할당량 없음 (null = 안 만듦). 온프레만 계산
        namespace_json: kindJson("namespace", managed ? [] : [{ name: ns, quota_cpu_m: null, quota_memory_mi: null }]),
        identity_json: kindJson("identity", identity),
        cache_json: cacheVars(spec, t),
        object_store_json: objectStoreVars(spec, t),
        queue_json: queueVars(spec, t),
        // 관리형이 없으면 키 자체를 안 둔다 (기존 계획 지문 그대로)
        ...(managed ? { service_json: managedServiceJson("aws", spec, t, (src) => awsAdapter.imageRef(src, t)) } : {}),
      },
      instances,
    };
  },
  toWorkloadValues(spec: AppSpecV2, out: TfOutputs, t: Target) {
    assertRenderable(spec, CAPS);
    assertGrants("aws", spec);
    if (managedServicesOf(spec).length)
      return managedWorkloadValues("aws", spec, out, t, cloudPostgresValues(spec, out, "db_master_secret_arn", { passwordProperty: "password" }));
    return buildWorkloadValues(spec, out, t, {
      imageRef: (src) => awsAdapter.imageRef(src, t),
      secretStore: { kind: "ClusterSecretStore", name: "aws-secrets-manager" },
      // = kinds/identity 의 aws_secretsmanager_secret 이름 규칙 (v1 과 같은 접두어)
      remoteKey: (s) => `platform/${tenantOf(t)}/${spec.app.name}/${s}`,
      saAnnotations: () => ({}),   // Pod Identity 는 Terraform 연결로 끝
      // RDS 관리 비밀번호 시크릿은 {username,password} JSON
      postgres: cloudPostgresValues(spec, out, "db_master_secret_arn", { passwordProperty: "password" }),
      ingressClass: "alb",
    });
  },
};
