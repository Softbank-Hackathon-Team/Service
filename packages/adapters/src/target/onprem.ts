import type { AppSpecV2, ComponentV2, TargetBuilder, TfOutputs, TfRootCall } from "@svc/contracts";
import { actionsFor, type PermTable } from "../common/actions.js";
import { appNamespace } from "../common/base.js";
import { hash6 } from "../common/names.js";
import { regionOf, tenantOf, type Target } from "../common/target.js";
import { onpremAdapter, PERMS as V1_PERMS } from "../onprem/index.js";
import { asV1Name, assertRenderable, instancesOf, K8S_RENDER_CAPS, kindJson, postgresOf, refV2, secretNamesOf, workloadsOf } from "./shared.js";
import { buildWorkloadValues } from "./cloud.js";

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
const CAPS = [...K8S_RENDER_CAPS, "kind.postgres.15", "kind.postgres.16", "kind.postgres.17", "db.cnpg", "render.grants", "posture.permissions"];

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
const cnpgName = (spec: AppSpecV2, id: string) => {
  const base = `${spec.app.name}-${id}`;
  return base.length <= 50 ? base : `${base.slice(0, 43).replace(/-+$/, "")}-${hash6(spec.app.name, id)}`;
};
const cnpgLink = (spec: AppSpecV2) => (c: ComponentV2, output: string): string | undefined => {
  if (c.kind !== "postgres") return undefined;
  const host = `${cnpgName(spec, c.id)}-rw`;
  // CNPG 기본 소유자·DB = app 【사실: CNPG bootstrap initdb 기본값】
  return ({ host, port: "5432", user: "app", url: `postgresql://app@${host}:5432/app` } as Record<string, string>)[output];
};

// 할당량 = Σ(요청량 × 최대 레플리카 × 2) + DB 몫 (v1 과 같은 규칙). 요청량이 하나라도 없으면 null (지어내지 않음)
function quota(spec: AppSpecV2): { cpu: number | null; mem: number | null } {
  let cpu: number | null = 0, mem: number | null = 0;
  for (const w of workloadsOf(spec)) {
    const n = w.kind === "service" ? w.props.replicas.max : 1;
    const rq = w.props.resources.request;
    cpu = cpu === null || rq?.cpuMilli == null ? null : cpu + rq.cpuMilli * n * 2;
    mem = mem === null || rq?.memMiB == null ? null : mem + rq.memMiB * n * 2;
  }
  const db = postgresOf(spec).length;
  return { cpu: cpu === null ? null : cpu + db * 1000, mem: mem === null ? null : mem + db * 2048 };
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
        netpol_json: "[]",
      },
      instances,
    };
  },
  toWorkloadValues(spec: AppSpecV2, out: TfOutputs, t: Target) {
    assertRenderable(spec, CAPS);
    return buildWorkloadValues(spec, out, t, {
      imageRef: (src) => onpremAdapter.imageRef(src, t),
      secretStore: { kind: "ClusterSecretStore", name: "vault" },   // DRAFT(ai): v1 과 같음
      remoteKey: (s) => `${spec.app.name}-${s.toLowerCase().replace(/_/g, "-")}`,
      saAnnotations: () => ({}),
      postgres: postgresOf(spec).map((c) => ({
        id: c.id, mode: "cnpg", name: cnpgName(spec, c.id),
        // DRAFT(ai): instances = 주 1 + (ha 면 대기 1) + 읽기 복제본. 아무것도 없으면 1 (v1 과 같음)
        instances: 1 + (c.props.ha ? 1 : 0) + (c.props.readReplicas ?? 0),
        majorVersion: c.props.majorVersion, storageGb: c.props.storageGb,
        parameters: c.props.parameters,
        host: `${cnpgName(spec, c.id)}-rw`, port: 5432, passwordSecret: `${cnpgName(spec, c.id)}-app`,
      })),
      link: cnpgLink(spec),
    });
  },
};
