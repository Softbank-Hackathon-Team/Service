import type { AppSpec } from "@svc/contracts";
import type { LoadParams, TrafficAssumption } from "./schema.js";

// MAU -> 피크 rps (설계 초안 3장). 계수는 어림값, 화면에서 바꿀 수 있다.
export function mauToRps(t: TrafficAssumption): number {
  return t.mau * t.dauRatio * t.reqPerUserDay / 86400 * t.peakFactor;
}

export function cpuToVcpu(cpu: AppSpec["service"]["cpu"]): number {
  return cpu.endsWith("m") ? Number(cpu.slice(0, -1)) / 1000 : Number(cpu);
}

export function memToGiB(mem: AppSpec["service"]["memory"]): number {
  return mem.endsWith("Mi") ? Number(mem.slice(0, -2)) / 1024 : Number(mem.slice(0, -2));
}

// DRAFT(ai): 필요 vCPU = max(부하로 구한 값, 명세의 복제 수 x 요청 CPU).
// PoC는 부하 값만 썼다. 명세가 더 크게 잡혀 있으면 그 이하로는 줄이지 않는다.
export function requiredVcpu(spec: AppSpec, rps: number, p: LoadParams): number {
  const byLoad = p.baseVcpu + p.vcpuPerRps * rps;
  const bySpec = spec.service.replicas * cpuToVcpu(spec.service.cpu);
  return Math.max(byLoad, bySpec);
}

export function requiredMemGiB(spec: AppSpec): number {
  return spec.service.replicas * memToGiB(spec.service.memory);
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
