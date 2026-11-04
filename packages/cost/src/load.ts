import type { AppSpecV2 } from "@svc/contracts";
import type { LoadParams, TrafficAssumption } from "./schema.js";

// MAU -> 피크 rps (설계 초안 3장). 계수는 어림값, 화면에서 바꿀 수 있다.
export function mauToRps(t: TrafficAssumption): number {
  return t.mau * t.dauRatio * t.reqPerUserDay / 86400 * t.peakFactor;
}

// 비용 계산이 보는 명세 요약: k8s 위에 도는 서비스의 (최소 복제 수 × 요청량) 합 + Postgres 디스크 합.
// DRAFT(ai): 요청량이 출발에 안 적혀 있으면(null) 0 으로 센다 (지어내지 않음). 그러면 부하로 구한 값(byLoad)이 노드 수를 정한다.
//   관리형 컨테이너·VM 서비스, 캐시·큐·버킷은 이 계산(노드·DB 네 덩어리) 밖이다 — 그 비용은 estimate-v2(계획서 고지)가 센다
export interface CostShape { vcpu: number; memGiB: number; database: { storageGb: number } | null }
export function costShapeOf(spec: AppSpecV2): CostShape {
  let vcpu = 0, memGiB = 0, storageGb = 0, pg = 0;
  for (const c of spec.components) {
    if (c.kind === "service" && c.props.runtime === "k8s") {
      const n = Math.max(1, c.props.replicas.min);
      vcpu += n * ((c.props.resources.request?.cpuMilli ?? 0) / 1000);
      memGiB += n * ((c.props.resources.request?.memMiB ?? 0) / 1024);
    }
    if (c.kind === "postgres") { pg++; storageGb += c.props.storageGb ?? 0; }
  }
  return { vcpu, memGiB, database: pg ? { storageGb } : null };
}

// DRAFT(ai): 필요 vCPU = max(부하로 구한 값, 명세의 복제 수 x 요청 CPU).
// PoC는 부하 값만 썼다. 명세가 더 크게 잡혀 있으면 그 이하로는 줄이지 않는다.
export function requiredVcpu(spec: AppSpecV2, rps: number, p: LoadParams): number {
  const byLoad = p.baseVcpu + p.vcpuPerRps * rps;
  return Math.max(byLoad, costShapeOf(spec).vcpu);
}

export function requiredMemGiB(spec: AppSpecV2): number {
  return costShapeOf(spec).memGiB;
}

// 노드 수 = 올림(필요 / (노드 크기 x 목표 사용률)), 최소 minNodes. CPU와 메모리 중 큰 쪽.
export function nodesFor(
  needVcpu: number, needMemGiB: number,
  node: { vcpu: number; memGiB: number }, p: LoadParams,
): number {
  const byCpu = Math.ceil(needVcpu / (node.vcpu * p.utilTarget));
  const byMem = Math.ceil(needMemGiB / (node.memGiB * p.utilTarget));
  return Math.max(p.minNodes, byCpu, byMem);
}
