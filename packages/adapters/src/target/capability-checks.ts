import type { AppSpecV2, Provider, TfOutputs } from "@svc/contracts";
import { secretNamesOf, workloadsOf } from "./shared.js";

// CL-2·CL-3·CL-4 DRAFT(ai): 계획 전에 "도착이 IR 을 실제로 돌릴 수 있나"를 보는 검사 줄 (PC-V2-CAP-n). 막지 않고 warn 으로 알린다.
//   막을지(block)·승인 줄로 할지는 TODO(human) — 지금 막으면 EKS 도착 HPA 가 있는 명세 전부가 계획에서 멈춘다.
//   도착 사실은 아래 TARGET_FACTS (env 모듈 기본값에서 옮긴 값). 실제 도착 클러스터에서 읽어 오는 건 TODO(human) (도착 사실 읽기 단계가 아직 없음)

// CL-4: 도착별 ExternalSecret 이 가리킬 ClusterSecretStore 기본 이름. env 층이 store 를 만들면 출력 secret_store_name 으로 이름을 내고 Builder 가 그것을 쓴다.
//   레포에서 이 store 를 만드는 곳이 아직 없다 (37번 CL-4). 출력이 없으면 기본 이름 + 계획 warn 줄
export const SECRET_STORE_DEFAULT: Record<"aws" | "gcp" | "onprem" | "azure_mock", string> = {
  aws: "aws-secrets-manager", gcp: "gcp-secret-manager", onprem: "vault", azure_mock: "azure-key-vault",
};
export const SECRET_STORE_OUTPUT = "secret_store_name";
/** CL-4: Builder 가 쓸 store 이름 (env 출력이 있으면 그것, 없으면 기본) */
export const secretStoreName = (p: keyof typeof SECRET_STORE_DEFAULT, out: TfOutputs): string => {
  const v = out[SECRET_STORE_OUTPUT];
  return typeof v === "string" && v ? v : SECRET_STORE_DEFAULT[p];
};

// CL-2·CL-3: 도착 클러스터 사실. 값 출처 = infra/modules/<p>/env/main.tf 기본값과 그 인스턴스 종류의 대략 allocatable
// DRAFT(ai): allocatable 은 상품 문서 기억 기반 근삿값 (t3.medium: 파드 17개/노드(VPC CNI 기본), e2-standard-2: 110개/노드). 실측값으로 바꿀 것
interface TargetFacts { metricsServer: boolean; nodes: number | null; cpuMilliPerNode: number | null; memMiBPerNode: number | null; podsPerNode: number | null; autoscale: boolean; source: string }
export const TARGET_FACTS: Record<"aws" | "gcp" | "onprem", TargetFacts> = {
  aws: { metricsServer: false, nodes: 2, cpuMilliPerNode: 1930, memMiBPerNode: 3300, podsPerNode: 17, autoscale: false, source: "aws/env: t3.medium × 2, 애드온 eks-pod-identity-agent 하나" },
  gcp: { metricsServer: true, nodes: 2, cpuMilliPerNode: 1930, memMiBPerNode: 6000, podsPerNode: 110, autoscale: false, source: "gcp/env: e2-standard-2 × 2 (node_count 고정)" },
  // 온프레 노드 크기는 고객 장비마다 다름 → 모름
  onprem: { metricsServer: true, nodes: null, cpuMilliPerNode: null, memMiBPerNode: null, podsPerNode: null, autoscale: false, source: "k3s 기본(metrics-server 포함), 노드 크기 모름" },
};
// 도착 차트가 앱마다 더 띄우는 파드 (cloudflared 2개, gitops/charts/app/templates/ingress.yaml)
const PLATFORM_PODS = 2;

/** IR 이 도착에서 요구하는 양: 서비스는 최대 복제 수 × (주 + 보조 컨테이너 요청), 잡은 1회 몫 */
export function irDemand(spec: AppSpecV2): { pods: number; cpuMilli: number; memMiB: number; unknownRequests: string[] } {
  let pods = 0, cpu = 0, mem = 0;
  const unknown: string[] = [];
  for (const w of workloadsOf(spec)) {
    if (w.kind === "service" && w.props.runtime !== "k8s") continue;
    const n = w.kind === "service" ? w.props.replicas.max : 1;
    const conts = [w.props.resources, ...(w.props.sidecars ?? []).filter((s) => !s.injected).map((s) => s.resources)];
    const c = conts.reduce((a, r) => a + (r.request?.cpuMilli ?? 0), 0);
    const m = conts.reduce((a, r) => a + (r.request?.memMiB ?? 0), 0);
    if (conts.some((r) => r.request?.cpuMilli == null || r.request?.memMiB == null)) unknown.push(w.id);
    pods += n; cpu += n * c; mem += n * m;
  }
  if (spec.entry) pods += PLATFORM_PODS;
  return { pods, cpuMilli: cpu, memMiB: mem, unknownRequests: unknown.sort() };
}

const hasHpa = (spec: AppSpecV2) => workloadsOf(spec).filter((w) => w.kind === "service" && (w.props.scale !== undefined || w.props.replicas.min !== w.props.replicas.max)).map((w) => w.id).sort();

/** PC-V2-CAP-n 줄 (k8s 도착만) */
export function capabilityPlanLines(spec: AppSpecV2, provider: Provider): string[] {
  if (provider !== "aws" && provider !== "gcp" && provider !== "onprem" && provider !== "azure_mock") return [];
  const out: string[] = [];
  const ws = workloadsOf(spec).filter((w) => w.kind !== "service" || w.props.runtime === "k8s");
  if (!ws.length) return out;
  // CL-4
  if (ws.some((w) => secretNamesOf(w).length))
    out.push(`비밀 저장소: 도착 ExternalSecret 이 ClusterSecretStore "${SECRET_STORE_DEFAULT[provider]}" 를 가리키는데 이 store 를 만드는 곳이 아직 없음 → 만들기 전엔 비밀을 쓰는 파드가 안 뜸. env 층이 store 를 만들고 출력 ${SECRET_STORE_OUTPUT} 을 내면 그 이름을 씀`);
  if (provider === "azure_mock") return out;
  const f = TARGET_FACTS[provider];
  // CL-2
  const hpa = hasHpa(spec);
  if (hpa.length && !f.metricsServer)
    out.push(`자동 확장: ${hpa.join(",")} 는 출발에서 HPA 로 늘었다 줄었다 함 → 도착(${f.source})엔 metrics-server 가 없어 HPA 가 최소 개수에 멈춤`);
  // CL-3
  const d = irDemand(spec);
  if (f.nodes == null) out.push(`노드 용량: 도착 노드 크기를 모름(${f.source}) → IR 요구량(파드 ${d.pods}개, CPU ${d.cpuMilli}m, 메모리 ${d.memMiB}Mi)과 비교 못 함. 사람이 확인`);
  else {
    const cap = { pods: f.nodes * f.podsPerNode!, cpu: f.nodes * f.cpuMilliPerNode!, mem: f.nodes * f.memMiBPerNode! };
    const over = [d.pods > cap.pods && `파드 ${d.pods}/${cap.pods}개`, d.cpuMilli > cap.cpu && `CPU ${d.cpuMilli}/${cap.cpu}m`, d.memMiB > cap.mem && `메모리 ${d.memMiB}/${cap.mem}Mi`].filter(Boolean);
    if (over.length) out.push(`노드 용량: IR 요구량이 도착 노드풀(${f.source}${f.autoscale ? "" : ", 자동 확장 없음"})을 넘음 (${over.join(", ")}) → 일부 파드가 Pending. 시스템 파드 몫은 안 뺀 값`);
    if (d.unknownRequests.length) out.push(`노드 용량: ${d.unknownRequests.join(",")} 는 요청량(requests)이 없어 0 으로 셈 → 실제 요구량은 더 클 수 있음`);
  }
  return out;
}
