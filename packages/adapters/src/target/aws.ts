import type { AppSpecV2, TargetBuilder, TfOutputs, TfRootCall } from "@svc/contracts";
import { actionsFor } from "../common/actions.js";
import { appNamespace, dbInstanceName } from "../common/base.js";
import { envRef, regionOf, tenantOf, type Target } from "../common/target.js";
import { awsAdapter, BOUNDARY_NAME, PERMS } from "../aws/index.js";
import {
  asV1Name, assertRenderable, connectIdentities, identitiesOf, identityName, instancesOf, K8S_RENDER_CAPS, kindJson,
  managedJobsOf, managedServicesOf, postgresOf, postureOfComponent, refV2, secretNamesOf, UNSUPPORTED_V2, vmServicesOf, workloadsOf,
} from "./shared.js";
import { assertGrants, grantsJsonFor } from "./grants.js";
import { secretStoreName } from "./capability-checks.js";
import { buildWorkloadValues, cloudPostgresValues } from "./cloud.js";
import { cacheVars, cachesOf, dataTypesOf, objectStoreVars, objectStoresOf, queueVars, queuesOf } from "./data.js";
import { assertDataFit, dbIdentityFor } from "./data-fit.js";
import { AdapterError } from "../common/errors.js";
import { managedJobJson, managedServiceJson, managedWorkloadValues } from "./managed.js";
import { vmServiceJson, vmWorkloadValues } from "./vm.js";

// DRAFT(ai): AWS 도착 Builder v2 (설계 27번 A1). 루트 = infra/modules/aws/root, 종류 = kinds/{postgres,identity,namespace}.
// DECISION(team): 도착 컴퓨트는 출발과 같은 종류 — 출발이 쿠버네티스면 쿠버네티스(AWS=EKS, GKE·k3s와 같은 Helm 차트), 출발이 ECS(관리형 컨테이너)면 ECS(GCP 도착이면 Cloud Run) (2026-10-31 EKS 결정, 2026-11-02 ECS 추가)

// DRAFT(ai): H-A6 기본 — IR compute 에서 가장 가까운(이상) 등급. compute 가 없으면 null → 모듈 기본(db.t4g.micro, v1 과 같음)
// SZ-1 DRAFT(ai): 큰 급(m6g 8·12·16xlarge, 메모리 큰 r6g 8·12·16xlarge)을 더하고, 그래도 안 들어가면 낮춰 고르지 않고 UNSUPPORTED_V2.
//   【추정: RDS 급별 vCPU·메모리. 문서 대조 필요】 순서 = 고르는 순서 (앞에서부터 처음 맞는 급)
const RDS_CLASSES: Array<[string, number, number]> = [
  ["db.t4g.micro", 2000, 1024], ["db.t4g.small", 2000, 2048], ["db.t4g.medium", 2000, 4096], ["db.t4g.large", 2000, 8192],
  ["db.m6g.xlarge", 4000, 16384], ["db.m6g.2xlarge", 8000, 32768], ["db.m6g.4xlarge", 16000, 65536],
  ["db.m6g.8xlarge", 32000, 131072], ["db.m6g.12xlarge", 48000, 196608], ["db.m6g.16xlarge", 64000, 262144],
  ["db.r6g.8xlarge", 32000, 262144], ["db.r6g.12xlarge", 48000, 393216], ["db.r6g.16xlarge", 64000, 524288],
];
export function rdsClassFor(c: { cpuMilli: number | null; memMiB: number | null } | undefined): string | null {
  if (!c || (c.cpuMilli == null && c.memMiB == null)) return null;
  const hit = RDS_CLASSES.find(([, cpu, mem]) => cpu >= (c.cpuMilli ?? 0) && mem >= (c.memMiB ?? 0));
  if (!hit) throw new AdapterError(UNSUPPORTED_V2, `출발 DB 크기(${c.cpuMilli ?? "?"}m·${c.memMiB ?? "?"}MiB)가 RDS 도착 급 최대(db.r6g.16xlarge 64vCPU·512GiB)보다 큼 → 낮춰 고르지 않음. 사람이 정함`);
  return hit[0];
}

// TA12 DRAFT(ai): 데이터 자원 — ElastiCache(redis·valkey, 클러스터 모드 가능)·S3·SQS/SNS. memcached 는 모듈이 안 만듦 → capability 없음(거부)
// A8: 출발 IAM 권한 → 도착 신원 권한 (target/grants.ts). 대응표 밖은 assertGrants·precheck 가 막음
const CAPS = [...K8S_RENDER_CAPS, "kind.postgres.15", "kind.postgres.16", "kind.postgres.17", "kind.cache.redis", "kind.cache.valkey", "kind.cache.cluster", "kind.objectStore", "kind.queue", "render.grants", "posture.permissions", "pg.param.rds",
  // TA12c: 데이터 자원 링크의 의도 요약(read·write·readwrite·admin). 실제 권한은 grants → grants_json(A8)로 그림, 의도는 요약일 뿐
  "link.read", "link.write", "link.readwrite", "link.admin",
  // TA13: 관리형 컨테이너 → ECS Fargate (root service_json + kinds/service-ecs). 못 그리는 칸은 managedBlockers
  "runtime.managedContainer",
  // RUNTIMEMAP v2: VM 출발 → EC2 (root vm_json + kinds/vm). 못 그리는 칸은 vmBlockers
  "runtime.vm"];

export function resourceTypesV2(spec: AppSpecV2): string[] {
  const t = new Set(["data.aws_eks_cluster", "data.aws_eks_cluster_auth", "kubernetes_namespace_v1"]);
  // TA13: 관리형 (= root ECS 공용 자원 + kinds/service-ecs)
  const managed = managedServicesOf(spec);
  if (managed.length) {
    ["data.aws_caller_identity", "aws_ecs_cluster", "aws_service_discovery_http_namespace", "aws_security_group", "aws_cloudwatch_log_group",
      "aws_iam_role", "aws_iam_role_policy", "aws_ecs_task_definition", "aws_ecs_service"].forEach((x) => t.add(x));
    if (managed.some((m) => secretNamesOf(m).length)) t.add("aws_secretsmanager_secret");
    if (managed.some((m) => m.props.scale && m.props.replicas.max > m.props.replicas.min)) ["aws_appautoscaling_target", "aws_appautoscaling_policy"].forEach((x) => t.add(x));
    // JOBBUILD: 관리형 예약 잡 = kinds/job (작업 정의 + 역할 3개 + EventBridge Scheduler)
    if (managedJobsOf(spec).length) ["data.aws_caller_identity", "aws_iam_role", "aws_iam_role_policy", "aws_cloudwatch_log_group", "aws_ecs_task_definition", "aws_scheduler_schedule"].forEach((x) => t.add(x));
  }
  // RUNTIMEMAP v2: VM (= root 보안 그룹 + kinds/vm)
  const vms = vmServicesOf(spec);
  if (vms.length) {
    ["data.aws_caller_identity", "data.aws_ssm_parameter", "aws_security_group", "aws_iam_role", "aws_iam_role_policy", "aws_iam_instance_profile", "aws_instance"].forEach((x) => t.add(x));
    if (vms.some((m) => secretNamesOf(m).length)) t.add("aws_secretsmanager_secret");
  }
  const ids = managed.length || vms.length ? [] : identitiesOf(spec);
  if (ids.length) ["aws_iam_role", "aws_iam_role_policy", "aws_eks_pod_identity_association"].forEach((x) => t.add(x));
  if (!managed.length && !vms.length && workloadsOf(spec).some((w) => secretNamesOf(w).length)) t.add("aws_secretsmanager_secret");
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
    assertDataFit("aws", spec, { postgres: (c) => rdsClassFor(c.props.compute) });   // SZ-1·CV-1: 표 밖이면 줄이지 않고 막음
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
        name: dbInstanceName(asV1Name(spec), t, 63),   // 복제 대상 1개 (2개 이상은 capability 로 막힘) → v1 이름 그대로
        major_version: c.props.majorVersion!,
        // DRAFT(ai): RDS 최소 20GB (v1 과 같은 올림). 출발이 더 크면 그대로
        storage_gb: Math.max(20, c.props.storageGb!),
        // VTA1: 최소로 올린 저장 공간보다 작은 자동 확장 상한은 apply 가 실패한다 → 올린 값 이상으로
        storage_max_gb: c.props.storageMaxGb == null ? null : Math.max(c.props.storageMaxGb, Math.max(20, c.props.storageGb!)),
        instance_class: rdsClassFor(c.props.compute),
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
      ...managedJobsOf(spec).map((c) => ({ kind: "job" as const, id: c.id })),   // JOBBUILD: 관리형 예약 잡
      ...vmServicesOf(spec).map((c) => ({ kind: "vm" as const, id: c.id })),
      ...(managed || vm ? [] : [{ kind: "namespace" as const, id: ns }]),
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
        namespace_json: kindJson("namespace", managed || vm ? [] : [{ name: ns, quota_cpu_m: null, quota_memory_mi: null }]),
        identity_json: kindJson("identity", identity),
        cache_json: cacheVars(spec, t, "aws"),
        object_store_json: objectStoreVars(spec, t),
        queue_json: queueVars(spec, t),
        // 관리형이 없으면 키 자체를 안 둔다 (기존 계획 지문 그대로)
        ...(managed ? { service_json: managedServiceJson("aws", spec, t, (src) => awsAdapter.imageRef(src, t)) } : {}),
        // JOBBUILD: 관리형 앱의 예약 잡이 있을 때만 키를 둔다 (없으면 기존 계획 지문 그대로)
        ...(managedJobsOf(spec).length ? { job_json: managedJobJson("aws", spec, t, (src) => awsAdapter.imageRef(src, t)) } : {}),
        ...(vm ? { vm_json: vmServiceJson("aws", spec, t, (src) => awsAdapter.imageRef(src, t)) } : {}),
      },
      instances,
    };
  },
  toWorkloadValues(spec: AppSpecV2, out: TfOutputs, t: Target) {
    assertRenderable(spec, CAPS);
    assertGrants("aws", spec);
    if (vmServicesOf(spec).length)
      return vmWorkloadValues("aws", spec, out, t, cloudPostgresValues(spec, out, "db_master_secret_arn", { passwordProperty: "password" }));
    if (managedServicesOf(spec).length)
      return managedWorkloadValues("aws", spec, out, t, cloudPostgresValues(spec, out, "db_master_secret_arn", { passwordProperty: "password" }));
    return buildWorkloadValues(spec, out, t, {
      imageRef: (src) => awsAdapter.imageRef(src, t),
      secretStore: { kind: "ClusterSecretStore", name: secretStoreName("aws", out) },   // CL-4: env 출력 secret_store_name 이 있으면 그것
      // = kinds/identity 의 aws_secretsmanager_secret 이름 규칙 (v1 과 같은 접두어)
      remoteKey: (s) => `platform/${tenantOf(t)}/${spec.app.name}/${s}`,
      saAnnotations: () => ({}),   // Pod Identity 는 Terraform 연결로 끝
      // RDS 관리 비밀번호 시크릿은 {username,password} JSON
      postgres: cloudPostgresValues(spec, out, "db_master_secret_arn", { passwordProperty: "password" }),
      ingressClass: "alb",
    });
  },
};
