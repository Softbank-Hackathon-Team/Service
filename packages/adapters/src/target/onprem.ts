import type { AppSpecV2, ComponentV2, TargetBuilder, TfOutputs, TfRootCall } from "@svc/contracts";
import { actionsFor, type PermTable } from "../common/actions.js";
import { appNamespace } from "../common/base.js";
import { hash6 } from "../common/names.js";
import { envRef, regionOf, tenantOf, type Target } from "../common/target.js";
import { onpremAdapter, PERMS as V1_PERMS } from "../onprem/index.js";
import { asV1Name, assertRenderable, compact, k8sResources, instancesOf, K8S_RENDER_CAPS, kindJson, postgresOf, refV2, secretNamesOf, workloadsOf } from "./shared.js";
import { secretStoreName } from "./capability-checks.js";
import { buildWorkloadValues } from "./cloud.js";
import { dbIdentityFor } from "./data-fit.js";

// DRAFT(ai): 온프레(k3s) 도착 Builder v2 (설계 27번 A1·A2b). 클라우드 IAM 없음, DB = 차트 CNPG (Terraform 아님).
//   루트 = infra/modules/onprem/root, 종류 = kinds/{namespace,netpol}. netpol 은 posture allow-all 이면 안 만듦(= mirror)

// v1 RBAC 표 + v2 가 더 쓰는 것 (CronJob)
const PERMS: PermTable = {
  ...V1_PERMS,
  "batch/cronjobs": { read: ["batch/cronjobs:get"], write: ["batch/cronjobs:create", "batch/cronjobs:patch"], remove: ["batch/cronjobs:delete"] },
};
// TODO(human): 온프레(k3s)의 데이터 자원 대체물 선택 — cache(클러스터 안 Redis? Valkey?)·objectStore(MinIO?)·queue(NATS? RabbitMQ?)는 아직 안 정함.
//   정하기 전까지 capability 를 안 줘서 v2Blockers 가 "도착 렌더 미지원: kind.cache.redis" 등으로 막는다 (조용히 빼먹지 않음). kinds/ 에도 해당 모듈 없음
// A8 STUB: 온프레엔 클라우드 IAM 이 없다 → 권한은 안 그리고(k8s ServiceAccount 만) precheck warn 으로 검토 표시
const CAPS = [...K8S_RENDER_CAPS, "volume.pvc", "kind.postgres.15", "kind.postgres.16", "kind.postgres.17", "db.cnpg", "render.grants", "posture.permissions"];

export function resourceTypesV2(spec: AppSpecV2): string[] {
  const r = new Set(["core/namespaces", "core/resourcequotas", "networking.k8s.io/networkpolicies", "core/serviceaccounts"]);
  const ws = workloadsOf(spec);
  if (ws.some((w) => w.kind === "service")) ["apps/deployments", "core/services"].forEach((x) => r.add(x));
  if (ws.some((w) => w.kind === "job")) r.add("batch/cronjobs");
  if (ws.some((w) => secretNamesOf(w).length)) r.add("external-secrets.io/externalsecrets");
  if (postgresOf(spec).length) r.add("postgresql.cnpg.io/clusters");
  return [...r].sort();
}

// CNPG Cluster 이름 = <앱>-<id> (id 가 "db" 면 v1 <앱>-db 그대로). 접속 서비스 = <cluster>-rw, 비밀 = <cluster>-app
// VTA1: 50자 넘으면 앞 43자 + 해시6 (CNPG Pod 이름 접미어·접속 서비스 -rw 로 63자를 안 넘게). 짧으면 v1 이름 그대로
export const cnpgName = (spec: AppSpecV2, id: string) => {
  const base = `${spec.app.name}-${id}`;
  return base.length <= 50 ? base : `${base.slice(0, 43).replace(/-+$/, "")}-${hash6(spec.app.name, id)}`;
};
const cnpgLink = (spec: AppSpecV2) => (c: ComponentV2, output: string): string | undefined => {
  if (c.kind !== "postgres") return undefined;
  const host = `${cnpgName(spec, c.id)}-rw`;
  // DBN-1·E10-2: initdb 소유자·DB = IR 앱 계정·DB 이름 (클라우드 도착과 같은 규칙 dbIdentityFor). 못 읽으면 app·<앱>_ + 사전 점검 경고
  const { db, user } = dbIdentityFor(spec, c);
  // CNPG-RO: 읽기 전용 = CNPG 가 만드는 <cluster>-ro Service (대기·복제본이 없으면 주 서버로 감)
  return ({ host, reader: `${cnpgName(spec, c.id)}-ro`, port: "5432", user, url: `postgresql://${user}@${host}:5432/${db}` } as Record<string, string>)[output];
};

// 할당량 = Σ(요청량 × 최대 레플리카 × 2) + DB 몫. 요청량이 하나라도 없으면 null (지어내지 않음)
//   DB 몫 = DB 마다 인스턴스 수 × 2 × (CNPG 에 그리는 요청량). 요청량은 아래 workloadValues 의 CNPG resources 와 같은 값
//   (IR compute, 없으면 차트 기본 500m·1Gi). 예전 고정값(DB 하나 1000m·2048Mi)은 기본값일 때와 같고,
//   출발 DB 크기를 가져오면(예: 2000m) initdb 파드가 "exceeded quota" 로 못 떴다 (2026-11-04 VM 실측)
const CNPG_DEFAULT_CPU_MILLI = 500, CNPG_DEFAULT_MEM_MIB = 1024;   // gitops/charts/app/templates/cnpg.yaml 기본값과 같게
const cnpgInstances = (c: ReturnType<typeof postgresOf>[number]) => 1 + (c.props.ha ? 1 : 0) + (c.props.readReplicas ?? 0);
function quota(spec: AppSpecV2): { cpu: number | null; mem: number | null } {
  let cpu: number | null = 0, mem: number | null = 0;
  for (const w of workloadsOf(spec)) {
    const n = w.kind === "service" ? w.props.replicas.max : 1;
    const rq = w.props.resources.request;
    cpu = cpu === null || rq?.cpuMilli == null ? null : cpu + rq.cpuMilli * n * 2;
    mem = mem === null || rq?.memMiB == null ? null : mem + rq.memMiB * n * 2;
  }
  let dbCpu = 0, dbMem = 0;
  for (const c of postgresOf(spec)) {
    const n = cnpgInstances(c) * 2;
    dbCpu += (c.props.compute?.cpuMilli ?? CNPG_DEFAULT_CPU_MILLI) * n;
    dbMem += (c.props.compute?.memMiB ?? CNPG_DEFAULT_MEM_MIB) * n;
  }
  return { cpu: cpu === null ? null : cpu + dbCpu, mem: mem === null ? null : mem + dbMem };
}

// W3: 온프레 바닥(할당량)을 git 으로. 차트 floor.yaml 이 floor.enabled == "1" 일 때만 ResourceQuota(platform-quota, Terraform 과 같은 이름·값)를 그린다
//   켜기는 배포 때 워커 envFacts 의 onpremFloorViaGit (ONPREM_FLOOR_VIA_GIT=1). 켜면 apply 가 온프레 Terraform 을 건너뛴다 (워커가 클러스터에 안 들어감)
//   네임스페이스는 고객 Argo CD 가 CreateNamespace + managed-by=platform 라벨로 만든다 (deploy/helm/onprem-agent ApplicationSet)
//   NetworkPolicy 는 더하지 않는다: 지금 규칙은 "정책 0개 = 출발처럼 열림"(toTerraformV2 netpol_json) 이고, 기본 차단은 팀 결정이다
function floorValues(spec: AppSpecV2) {
  const q = quota(spec);
  return { enabled: envRef("onpremFloorViaGit"), quota: compact({ cpuMilli: q.cpu ?? undefined, memoryMi: q.mem ?? undefined }) };
}
// W3: 바닥을 git 으로 할 때 apply 가 Terraform 대신 내는 출력. onprem/root 모듈 출력과 같은 모양 (맵 출력은 JSON 글자, plan-v2 flattenTfOutputsV2)
export function onpremGitFloorOutputs(spec: AppSpecV2): TfOutputs {
  return { link_outputs: "{}", namespace: appNamespace(asV1Name(spec)) };
}

export const onpremTarget: TargetBuilder = {
  provider: "onprem",
  version: "onprem-target@0.1.0",
  capabilities: () => [...CAPS].sort(),
  imageRef: (src, t) => onpremAdapter.imageRef(src, t),
  operateActionsV2: (spec, purpose) => actionsFor(PERMS, resourceTypesV2(spec), purpose),
  toTerraformV2(spec: AppSpecV2, t: Target): TfRootCall {
    assertRenderable(spec, CAPS);
    const ns = appNamespace(asV1Name(spec));
    const q = quota(spec);
    const instances = instancesOf("onprem", [{ kind: "namespace", id: ns }]);
    return {
      root: refV2("onprem/root", t),
      modules: [refV2("onprem/kinds/namespace", t)],
      vars: {
        kube_context: regionOf(t) === "local" ? "k3s-onprem" : regionOf(t),
        app_name: spec.app.name,
        tenant_id: tenantOf(t),
        k8s_namespace: ns,
        namespace_json: kindJson("namespace", [{ name: ns, quota_cpu_m: q.cpu, quota_memory_mi: q.mem }]),
        // posture.networkPolicy(as-declared)는 capability 밖이라 여기 안 옴 → 정책 0개 = 출발처럼 다 열림
        netpol_json: kindJson("netpol", []),   // TF4-3: 계약(NetpolTfVars)을 거친다
      },
      instances,
    };
  },
  toWorkloadValues(spec: AppSpecV2, out: TfOutputs, t: Target) {
    assertRenderable(spec, CAPS);
    return { ...workloadValues(spec, out, t), floor: floorValues(spec) };
  },
};

function workloadValues(spec: AppSpecV2, out: TfOutputs, t: Target) {
    return buildWorkloadValues(spec, out, t, {
      imageRef: (src) => onpremAdapter.imageRef(src, t),
      secretStore: { kind: "ClusterSecretStore", name: secretStoreName("onprem", out) },   // CL-4: env 출력 secret_store_name 이 있으면 그것
      remoteKey: (s) => `${spec.app.name}-${s.toLowerCase().replace(/_/g, "-")}`,
      saAnnotations: () => ({}),
      postgres: postgresOf(spec).map((c) => compact({
        id: c.id, mode: "cnpg" as const, name: cnpgName(spec, c.id),
        // DRAFT(ai): instances = 주 1 + (ha 면 대기 1) + 읽기 복제본. 아무것도 없으면 1 (v1 과 같음)
        instances: cnpgInstances(c),
        majorVersion: c.props.majorVersion, storageGb: c.props.storageGb,
        ...(c.props.walStorageGb ? { walStorageGb: c.props.walStorageGb } : {}),   // DM-8 → 차트 cnpg.yaml walStorage (CNPG-V2)
        // CNPG-V2 DRAFT(ai): IR compute → CNPG resources (요청=한도, 출발 DB 크기 그대로). 없으면 차트 기본(500m·1Gi, 할당량 DB 몫 안)
        ...(c.props.compute && (c.props.compute.cpuMilli != null || c.props.compute.memMiB != null) ? { resources: {
          requests: { ...(c.props.compute.cpuMilli != null ? { cpu: `${c.props.compute.cpuMilli}m` } : {}), ...(c.props.compute.memMiB != null ? { memory: `${c.props.compute.memMiB}Mi` } : {}) },
          ...(c.props.compute.memMiB != null ? { limits: { memory: `${c.props.compute.memMiB}Mi` } } : {}) } } : {}),
        parameters: c.props.parameters,
        host: `${cnpgName(spec, c.id)}-rw`, port: 5432, passwordSecret: `${cnpgName(spec, c.id)}-app`,
        // DBN-1·E10-2: CNPG bootstrap.initdb 의 database·owner (차트 cnpg.yaml v2 갈래가 읽음, CNPG-V2)
        database: dbIdentityFor(spec, c).db, owner: dbIdentityFor(spec, c).user,
      })),
      link: cnpgLink(spec),
    });
}

