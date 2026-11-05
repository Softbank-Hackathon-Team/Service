import { parseAllDocuments } from "yaml";
import type { QuotaBasis } from "@svc/contracts";

// 리허설이 받는 매니페스트 모델. 종류 표 하나가 "무엇을 적용하고 무엇을 기다리나"를 정한다
// 표 = 앱 차트가 그리는 닫힌 목록(gitops/charts/app/templates) + 워커 치환이 만드는 Secret.
// 표에 없는 종류가 묶음에 있으면 REHEARSAL_UNSUPPORTED_KIND (닫힌 쪽으로 실패)
//   applies=false: 원본은 CRD 스키마로 서버 dry-run 만 하고 적용 묶음에는 오면 안 된다 (워커가 대체물로 바꾼다)
//   wait: rollout = 준비 수까지 기다림, job = Complete 까지 기다림, null = 적용만 (DaemonSet 은 가짜 노드라 롤아웃을 못 본다)
export interface KindInfo { plural: string; applies: boolean; wait: "rollout" | "job" | null }
export const REHEARSAL_KINDS: Readonly<Record<string, KindInfo>> = {
  "v1/ConfigMap": { plural: "configmaps", applies: true, wait: null },
  "v1/Secret": { plural: "secrets", applies: true, wait: null },
  "v1/Service": { plural: "services", applies: true, wait: null },
  "v1/ServiceAccount": { plural: "serviceaccounts", applies: true, wait: null },
  "v1/PersistentVolumeClaim": { plural: "persistentvolumeclaims", applies: true, wait: null },
  "apps/v1/Deployment": { plural: "deployments", applies: true, wait: "rollout" },
  "apps/v1/StatefulSet": { plural: "statefulsets", applies: true, wait: "rollout" },
  "apps/v1/DaemonSet": { plural: "daemonsets", applies: true, wait: null },
  "batch/v1/Job": { plural: "jobs", applies: true, wait: "job" },
  "batch/v1/CronJob": { plural: "cronjobs", applies: true, wait: null },
  "autoscaling/v2/HorizontalPodAutoscaler": { plural: "horizontalpodautoscalers", applies: true, wait: null },
  "policy/v1/PodDisruptionBudget": { plural: "poddisruptionbudgets", applies: true, wait: null },
  "networking.k8s.io/v1/Ingress": { plural: "ingresses", applies: true, wait: null },
  // 온프레 DB 이전 터널(db-tunnel.yaml)의 NetworkPolicy. 그대로 적용한다 (가상 API 서버가 모양을 판정, 샌드박스 기본 거부는 따로 있다)
  "networking.k8s.io/v1/NetworkPolicy": { plural: "networkpolicies", applies: true, wait: null },
  // 온프레 바닥 floor.yaml 의 platform-quota (ONPREM_FLOOR_VIA_GIT). 그대로 적용해 가상 API 서버가 도착과 같은 할당량 검사를 한다.
  //   다른 객체보다 먼저 적용하고 상태가 잡힌 뒤에 파드를 만든다 (run.ts applyQuotas)
  "v1/ResourceQuota": { plural: "resourcequotas", applies: true, wait: null },
  "external-secrets.io/v1/ExternalSecret": { plural: "externalsecrets", applies: false, wait: null },
  "postgresql.cnpg.io/v1/Cluster": { plural: "clusters", applies: false, wait: null },
  // 온프레 DB 이전 봉인 비밀 (sealedsecret.yaml). 샌드박스에는 컨트롤러·개인 키가 없다 → 원본은 CRD 로 dry-run 만, 적용은 워커가 같은 이름의 가짜 Secret 으로
  "bitnami.com/v1alpha1/SealedSecret": { plural: "sealedsecrets", applies: false, wait: null },
};

export interface K8sObject {
  apiVersion: string; kind: string;
  metadata: { name: string; namespace?: string; labels?: Record<string, string>; [k: string]: unknown };
  spec?: any; [k: string]: unknown;
}
export interface Manifest { path: string; key: string; info: KindInfo; obj: K8sObject }

export const subjectOf = (m: Manifest) => `${m.obj.kind}/${m.obj.metadata.name}`;

// 문서들을 객체로. 풀지 못한 YAML·이름 없는 객체·표 밖 종류는 problems 로 (판정은 부르는 쪽)
export function parseManifests(docs: ReadonlyArray<{ path: string; yaml: string }>, phase: "original" | "apply"): { manifests: Manifest[]; problems: string[] } {
  const manifests: Manifest[] = [];
  const problems: string[] = [];
  for (const d of docs) {
    for (const doc of parseAllDocuments(d.yaml)) {
      if (doc.errors.length) { problems.push(`${d.path}: YAML 해석 실패 (${doc.errors[0]!.message.slice(0, 120)})`); continue; }
      const obj = doc.toJS() as K8sObject | null;
      if (obj === null || obj === undefined) continue;
      const key = `${obj.apiVersion}/${obj.kind}`;
      const info = REHEARSAL_KINDS[key];
      if (typeof obj.metadata?.name !== "string") problems.push(`${d.path}: ${key} 이름 없음`);
      else if (!info) problems.push(`${d.path}: ${key} ${obj.metadata.name} (지원 목록 밖)`);
      else if (phase === "apply" && !info.applies) problems.push(`${d.path}: ${key} ${obj.metadata.name} (dry-run 전용 종류가 적용 묶음에 있음)`);
      else manifests.push({ path: d.path, key, info, obj });
    }
  }
  return { manifests, problems };
}

export function apiPath(m: Pick<Manifest, "obj" | "info">, ns: string, name?: string): string {
  const base = m.obj.apiVersion === "v1" ? "/api/v1" : `/apis/${m.obj.apiVersion}`;
  return `${base}/namespaces/${ns}/${m.info.plural}${name ? `/${name}` : ""}`;
}

// 파드 틀과 그 틀로 뜨는 파드 수. HPA 는 지표가 없어도 minReplicas 까지는 늘린다
export function podTemplates(ms: readonly Manifest[]): Array<{ owner: Manifest; template: { metadata?: any; spec: any }; count: number }> {
  const hpaMin = new Map<string, number>();
  for (const m of ms) if (m.obj.kind === "HorizontalPodAutoscaler") hpaMin.set(String(m.obj.spec?.scaleTargetRef?.name), Number(m.obj.spec?.minReplicas ?? 1));
  const out: Array<{ owner: Manifest; template: { metadata?: any; spec: any }; count: number }> = [];
  for (const m of ms) {
    const s = m.obj.spec ?? {};
    switch (m.obj.kind) {
      case "Deployment": case "StatefulSet":
        out.push({ owner: m, template: s.template, count: Math.max(Number(s.replicas ?? 1), hpaMin.get(m.obj.metadata.name) ?? 0) }); break;
      case "DaemonSet": out.push({ owner: m, template: s.template, count: 1 }); break;
      case "Job": out.push({ owner: m, template: s.template, count: Number(s.parallelism ?? 1) }); break;
      case "CronJob": out.push({ owner: m, template: s.jobTemplate?.spec?.template, count: 1 }); break;
    }
  }
  return out.filter((t) => t.template?.spec);
}

// ── 자원 수량 ──
export interface Resources { cpuM: number; memoryMi: number }
const BIN: Record<string, number> = { Ki: 2 ** 10, Mi: 2 ** 20, Gi: 2 ** 30, Ti: 2 ** 40, Pi: 2 ** 50, Ei: 2 ** 60 };
const DEC: Record<string, number> = { k: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, E: 1e18 };
export function cpuMilli(v: unknown): number | null {
  const m = /^(\d+(?:\.\d+)?)(m)?$/.exec(String(v ?? "").trim());
  return m ? Math.ceil(Number(m[1]) * (m[2] ? 1 : 1000)) : null;
}
export function memoryMi(v: unknown): number | null {
  const m = /^(\d+(?:\.\d+)?(?:[eE]\d+)?)(Ki|Mi|Gi|Ti|Pi|Ei|k|M|G|T|P|E)?$/.exec(String(v ?? "").trim());
  if (!m) return null;
  return Math.ceil((Number(m[1]) * (m[2] ? BIN[m[2]] ?? DEC[m[2]]! : 1)) / 2 ** 20);
}

// 샌드박스 호스트 네임스페이스의 LimitRange (vCluster 값 policies.limitRange). 요청·한도가 빈 컨테이너가 받는 값
// DRAFT(ai): vCluster 0.37.6 차트 기본값을 그대로 박아 둔다 (차트 기본이 바뀌어도 셈이 어긋나지 않게)
export const LIMIT_RANGE = { default: { cpu: "1", memory: "512Mi" }, defaultRequest: { cpu: "100m", memory: "128Mi" } } as const;

interface Need { requests: Resources; limitsMemoryMi: number; limitsCpuM: number }
const zero = (): Need => ({ requests: { cpuM: 0, memoryMi: 0 }, limitsMemoryMi: 0, limitsCpuM: 0 });
// 컨테이너 하나: 요청이 없으면 한도, 그것도 없으면 LimitRange 기본 (쿠버네티스 기본값 규칙과 같은 순서)
function containerNeed(c: any, withDefaults: boolean): Need {
  const r = c?.resources ?? {};
  const lim = { cpu: cpuMilli(r.limits?.cpu), mem: memoryMi(r.limits?.memory) };
  const d = withDefaults ? { reqCpu: cpuMilli(LIMIT_RANGE.defaultRequest.cpu)!, reqMem: memoryMi(LIMIT_RANGE.defaultRequest.memory)!,
    limMem: memoryMi(LIMIT_RANGE.default.memory)! } : { reqCpu: 0, reqMem: 0, limMem: 0 };
  return {
    requests: { cpuM: cpuMilli(r.requests?.cpu) ?? lim.cpu ?? d.reqCpu, memoryMi: memoryMi(r.requests?.memory) ?? lim.mem ?? d.reqMem },
    limitsMemoryMi: lim.mem ?? d.limMem, limitsCpuM: lim.cpu ?? 0,
  };
}
// 파드 하나: 컨테이너 합과 초기화 컨테이너 중 큰 것 (초기화는 하나씩 돈다)
function podNeed(spec: any, withDefaults: boolean): Need {
  const sum = zero();
  for (const c of spec?.containers ?? []) {
    const n = containerNeed(c, withDefaults);
    sum.requests.cpuM += n.requests.cpuM; sum.requests.memoryMi += n.requests.memoryMi;
    sum.limitsMemoryMi += n.limitsMemoryMi; sum.limitsCpuM += n.limitsCpuM;
  }
  for (const c of spec?.initContainers ?? []) {
    const n = containerNeed(c, withDefaults);
    sum.requests.cpuM = Math.max(sum.requests.cpuM, n.requests.cpuM); sum.requests.memoryMi = Math.max(sum.requests.memoryMi, n.requests.memoryMi);
    sum.limitsMemoryMi = Math.max(sum.limitsMemoryMi, n.limitsMemoryMi); sum.limitsCpuM = Math.max(sum.limitsCpuM, n.limitsCpuM);
  }
  return sum;
}
function totalNeed(ms: readonly Manifest[], withDefaults: boolean): Need & { pods: number } {
  const t = { ...zero(), pods: 0 };
  for (const p of podTemplates(ms)) {
    const n = podNeed(p.template.spec, withDefaults);
    t.requests.cpuM += n.requests.cpuM * p.count; t.requests.memoryMi += n.requests.memoryMi * p.count;
    t.limitsMemoryMi += n.limitsMemoryMi * p.count; t.limitsCpuM += n.limitsCpuM * p.count; t.pods += p.count;
  }
  return t;
}

// 원본이 도착 네임스페이스 할당량에 걸리나. 할당량이 세는 칸(basis)만 더한다
//   도착 네임스페이스에는 LimitRange 가 없다 (infra kinds/namespace, gitops floor.yaml) → 기본값을 넣지 않는다
//   requests: 요청량, 빈 칸이면 한도 (API 서버 기본값 규칙) / limits: 한도
//   그 칸이 빈 컨테이너는 missing 에 담는다. 그 자원 할당량이 있으면 도착 API 서버가 파드를 거부한다 ("must specify ...")
//   CNPG Cluster 는 operator 가 instances 개 파드를 spec.resources 로 띄운다 (원본에만 있는 종류라 여기서 같이 센다)
export interface QuotaUsage { cpuM: number; memoryMi: number; missing: { cpu: string[]; memory: string[] } }
export function originalUsage(original: readonly Manifest[], basis: QuotaBasis): QuotaUsage {
  const out: QuotaUsage = { cpuM: 0, memoryMi: 0, missing: { cpu: [], memory: [] } };
  const field = (c: any, r: "cpu" | "memory"): number | null => {
    const read = r === "cpu" ? cpuMilli : memoryMi;
    const res = c?.resources ?? {};
    return basis === "requests" ? read(res.requests?.[r]) ?? read(res.limits?.[r]) : read(res.limits?.[r]);
  };
  const pod = (owner: string, spec: any, count: number) => {
    for (const r of ["cpu", "memory"] as const) {
      let sum = 0, init = 0;
      for (const [list, isInit] of [[spec?.containers ?? [], false], [spec?.initContainers ?? [], true]] as const) {
        for (const c of list) {
          const v = field(c, r);
          if (v === null) out.missing[r].push(`${owner}/${String(c?.name ?? "?")}`);
          else if (isInit) init = Math.max(init, v);
          else sum += v;
        }
      }
      const n = Math.max(sum, init) * count;
      if (r === "cpu") out.cpuM += n; else out.memoryMi += n;
    }
  };
  for (const p of podTemplates(original)) pod(subjectOf(p.owner), p.template.spec, p.count);
  for (const m of original) if (m.key === "postgresql.cnpg.io/v1/Cluster")
    pod(subjectOf(m), { containers: [{ name: "postgres", resources: m.obj.spec?.resources }] }, Number(m.obj.spec?.instances ?? 1));
  return out;
}

// ── 실행마다 ResourceQuota ──
// 결정(리드): 리허설 자원 상한 = 적용 묶음 요청량 합 + 제어판 몫, sandbox 노드 할당량 안으로
export interface SandboxQuota { requests: Resources; limitsMemoryMi: number; pods: number; storageMi: number }
// 측정(kind 1.35, 차트 0.37.6): 제어판 200m/256Mi(한도 1Gi) + CoreDNS 20m/64Mi(한도 170Mi), 파드 2개
export const CONTROL_PLANE_OVERHEAD = { requests: { cpuM: 220, memoryMi: 320 }, limitsMemoryMi: 1194, pods: 2 } as const;
// 서비스 사이 연결을 보는 검사 파드 하나 (run.ts probePod 와 같은 값)
export const PROBE_RESOURCES = { requests: { cpu: "10m", memory: "16Mi" }, limits: { memory: "64Mi" } } as const;
// DRAFT(ai): sandbox 노드 할당량. agent-worker 는 nodes 를 읽을 권한이 없어(PR #194 sbx-provisioner) 표로 둔다.
//   t3.medium(EKS, 파드 17개) 근사: CPU 2000m - 70m 예약, 메모리 3943Mi - kube 예약 442Mi - 축출 100Mi
export const SANDBOX_NODE_ALLOCATABLE: Resources = { cpuM: 1930, memoryMi: 3400 };
// DRAFT(ai): 여유 20% (설계 4.4). 파드 수는 재시작·잡 재시도 몫 2개 더
const HEADROOM = 1.2;

export interface QuotaPlan { quota: SandboxQuota; need: Resources; cap: Resources; fits: boolean }
export function sandboxQuotaPlan(apply: readonly Manifest[], cap: Resources = SANDBOX_NODE_ALLOCATABLE): QuotaPlan {
  const t = totalNeed(apply, true);
  const probe = containerNeed({ resources: PROBE_RESOURCES }, true);
  const need: Resources = {
    cpuM: t.requests.cpuM + probe.requests.cpuM + CONTROL_PLANE_OVERHEAD.requests.cpuM,
    memoryMi: t.requests.memoryMi + probe.requests.memoryMi + CONTROL_PLANE_OVERHEAD.requests.memoryMi,
  };
  let storageMi = 0;
  for (const m of apply) if (m.obj.kind === "PersistentVolumeClaim") storageMi += memoryMi(m.obj.spec?.resources?.requests?.storage) ?? 0;
  return {
    need, cap, fits: need.cpuM <= cap.cpuM && need.memoryMi <= cap.memoryMi,
    quota: {
      requests: { cpuM: Math.min(cap.cpuM, Math.ceil(need.cpuM * HEADROOM)), memoryMi: Math.min(cap.memoryMi, Math.ceil(need.memoryMi * HEADROOM)) },
      // DRAFT(ai): 한도(limits)는 노드 할당량으로 자르지 않는다. 한도는 겹쳐 잡는 값이라 자르면 팀 3티어 예시도 들어가지 않는다.
      //   노드 보호는 컨테이너마다 한도(LimitRange)와 kubelet 축출이 맡는다
      limitsMemoryMi: Math.ceil((t.limitsMemoryMi + probe.limitsMemoryMi + CONTROL_PLANE_OVERHEAD.limitsMemoryMi) * HEADROOM),
      pods: t.pods + 1 + CONTROL_PLANE_OVERHEAD.pods + 2,
      storageMi: Math.max(1024, Math.ceil(storageMi * HEADROOM)),
    },
  };
}
