import type { ComponentV2, K8sProbe } from "@svc/contracts";

// PB-1: IR 프로브 {type, path, port, periodSec…} → k8s 프로브 (httpGet·tcpSocket·grpc·exec + …Seconds 칸).
//   IR 칸 이름(…Sec)과 k8s 칸 이름(…Seconds)이 달라서, 그대로 넘기면 차트가 httpGet 없는 프로브를 그렸다 (apply 때 k8s 가 거부).
//   없는 칸은 키를 안 둔다: path 가 없으면 k8s 기본("/")을 지어내지 않고 빼 둔다 (k8s 가 스스로 "/" 로 본다).
type Svc = Extract<ComponentV2, { kind: "service" }>;
export type ProbeV2 = NonNullable<NonNullable<Svc["props"]["probes"]>["readiness"]>;

// PR-1: 출발 프로브의 제한 시간·성공 횟수·종료 유예도 그대로 (IR 칸은 A 묶음 spec-v2 PR-1). 칸이 없는 IR 판에서도 돌게 넓은 타입으로 읽는다
type ProbeV2Full = ProbeV2 & { timeoutSec?: number; successThreshold?: number; terminationGracePeriodSec?: number };
export function toK8sProbe(p0: ProbeV2): K8sProbe {
  const p = p0 as ProbeV2Full;
  const timing = {
    ...(p.initialDelaySec !== undefined ? { initialDelaySeconds: p.initialDelaySec } : {}),
    ...(p.periodSec !== undefined ? { periodSeconds: p.periodSec } : {}),
    ...(p.timeoutSec !== undefined ? { timeoutSeconds: p.timeoutSec } : {}),
    ...(p.successThreshold !== undefined ? { successThreshold: p.successThreshold } : {}),
    ...(p.failureThreshold !== undefined ? { failureThreshold: p.failureThreshold } : {}),
    ...(p.terminationGracePeriodSec !== undefined ? { terminationGracePeriodSeconds: p.terminationGracePeriodSec } : {}),
  };
  switch (p.type) {
    case "http": return { httpGet: { ...(p.path !== undefined ? { path: p.path } : {}), port: p.port, ...(p.scheme ? { scheme: p.scheme } : {}) }, ...timing };
    case "tcp": return { tcpSocket: { port: p.port }, ...timing };
    case "grpc": return { grpc: { port: p.port }, ...timing };
    case "exec": return { exec: { command: [...p.command] }, ...timing };
  }
}

/** readiness·liveness·startup 만 옮긴다 (IR 사이드카 probes 는 record 라 다른 키가 올 수 있음 → 버리지 않게 호출부가 경고) */
export function toK8sProbes(probes: Partial<Record<string, ProbeV2>> | undefined): { readiness?: K8sProbe; liveness?: K8sProbe; startup?: K8sProbe } | undefined {
  if (!probes) return undefined;
  const out: Record<string, K8sProbe> = {};
  for (const k of ["readiness", "liveness", "startup"] as const) {
    const p = probes[k];
    if (p) out[k] = toK8sProbe(p);
  }
  return Object.keys(out).length ? out : undefined;
}

/** 거꾸로: k8s 프로브 → IR 모양 보기 (정확도 비교용). 모르는 모양이면 undefined */
export function fromK8sProbe(p: Record<string, any> | undefined): { type: string; path?: string; port?: string } | undefined {
  if (!p) return undefined;
  if (p.httpGet) return { type: "http", path: p.httpGet.path, port: p.httpGet.port == null ? undefined : String(p.httpGet.port) };
  if (p.tcpSocket) return { type: "tcp", port: String(p.tcpSocket.port) };
  if (p.grpc) return { type: "grpc", port: String(p.grpc.port) };
  if (p.exec) return { type: "exec" };
  return undefined;
}
