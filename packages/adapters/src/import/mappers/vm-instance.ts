import { VM_RAW_KIND, type RawVmGroup, type RawVmIngress } from "../raw-vm.js";
import type { KindMapper, MappedComponent, MetaTuple, RawItem } from "../types.js";

// DRAFT(ai) VMIMPORT: VM 묶음(EC2·GCE) → service 리소스 (회의 11/2 D4: EKS → ECS → VM, VM → 컨테이너 리플랫폼).
//   origin = { vm, ec2|gce }, 도착 실행 방식 runtime = k8s → checkV2 가 runtime_change 승인 줄을 낸다 (TODO(human): N8 와 같이 VM 출발의 기본 도착 정하기)
//   이미지가 없다 → image.source = "build" + BuildPlan 자리. 레포·커밋은 VM 에서 알 수 없다 → STUB 값 + 검토 표시, 사람이 채운다
//   크기 → resources.request (VM 크기를 요청량으로 옮김, 검토 표시). 포트·보안 그룹 → ports + posture.network. 환경변수는 읽지 않는다(user-data 비밀 가능)
//   운영 접속 포트(22·3389)는 앱 포트가 아니라 뺀다

const m = (source: string, confidence: 1 | 0.9 | 0.6 = 1, rationale?: string): MetaTuple =>
  rationale === undefined ? [source, confidence] : [source, confidence, rationale];

const ADMIN = new Set([22, 3389]);
const MAX_RANGE = 5;   // 이 폭을 넘는 포트 범위는 앱 포트로 안 본다 (전체 열림 등)

/** 보안 규칙 → 앱 포트(작은 범위만 펼침, 접속 포트 제외). 펼치지 못한 넓은 범위가 있으면 wide=true */
export function appPorts(rules: RawVmIngress[]): { ports: Array<{ port: number; protocol: "TCP" | "UDP" }>; wide: boolean; adminOnly: boolean } {
  const out = new Map<string, { port: number; protocol: "TCP" | "UDP" }>();
  let wide = false, sawAdmin = false;
  for (const r of rules) {
    if (r.toPort - r.fromPort + 1 > MAX_RANGE) { wide = true; continue; }
    for (let p = r.fromPort; p <= r.toPort; p++) {
      if (ADMIN.has(p)) { sawAdmin = true; continue; }
      if (p < 1 || p > 65535) continue;
      const protocol = r.protocol === "udp" ? "UDP" : "TCP";
      out.set(`${protocol}/${p}`, { port: p, protocol });
    }
  }
  return { ports: [...out.values()].sort((a, b) => a.port - b.port || a.protocol.localeCompare(b.protocol)), wide, adminOnly: out.size === 0 && sawAdmin };
}

export const vmInstanceMapper: KindMapper = {
  nativeTypes: [VM_RAW_KIND],
  kind: "service",
  map(item: RawItem): MappedComponent | { skip: string; grade?: "A" | "B" | "C" } {
    const g = item as unknown as RawVmGroup;
    if (!g.name || !(g.count >= 1)) return { skip: "VM 묶음 이름·수 없음 (깨진 원본)", grade: "C" };
    const src = `${g.product}:${g.scope ?? ""}/${g.name}`;
    const rules = g.ingress ?? null;
    const pp = rules ? appPorts(rules) : { ports: [], wide: false, adminOnly: false };
    const ports = pp.ports;
    const cpu = g.cpuMilli ?? null, mem = g.memMiB ?? null;
    const resources = cpu != null || mem != null ? { request: { cpuMilli: cpu, memMiB: mem } } : {};
    const publicRule = rules?.some((r) => r.sources.includes("0.0.0.0/0") && !(r.fromPort === r.toPort && ADMIN.has(r.fromPort)) && r.toPort - r.fromPort + 1 <= MAX_RANGE) ?? false;
    const props: Record<string, unknown> = {
      runtime: "k8s",
      origin: { runtime: "vm", product: g.product },
      // STUB: VM 에는 이미지가 없다. 도착에서 소스를 빌드해 이미지를 만든다 (BuildPlan). 레포·커밋은 사람이 채운다
      // TODO(human): 소스 레포·운영 커밋·빌드 방식(dockerfile|buildpacks)·시작 명령. 지금 값은 자리 표시
      image: { source: "build", repository: g.name, digest: null,
        build: { repo: "TODO(human):source-repo", commit: "TODO(human):deployed-commit", path: ".", method: "dockerfile", evidence: [`${g.product}:${g.name} (${g.count}대)`],
          ...(ports[0] ? { port: ports[0].port } : {}) } },
      resources,
      env: [],
      serviceAccount: g.identity ?? "default",
      ...(ports.length ? { ports: ports.map((p) => ({ port: p.port, protocol: p.protocol })) } : {}),
      ...(ports.length ? { endpoints: [{ name: g.name, type: "ClusterIP", ports: ports.map((p) => ({ port: p.port, targetPort: p.port, protocol: p.protocol })) }] } : {}),
      replicas: { min: g.count, max: g.count },
    };
    const mixed = g.instanceTypes.length > 1;
    return {
      name: g.name, kind: "service",
      native: { type: VM_RAW_KIND, name: g.name, uid: null, ...(g.scope ? { scope: `${g.product}/${g.scope}` } : {}) },
      props,
      network: { ingress: rules ? rules.filter((r) => !(r.fromPort === r.toPort && ADMIN.has(r.fromPort)) && r.toPort - r.fromPort + 1 <= MAX_RANGE)
        .flatMap((r) => r.sources.map((s) => ({ from: s, ...(r.fromPort === r.toPort ? { port: r.fromPort } : {}) }))) : "unknown",
        public: g.hasPublicIp === undefined ? null : !!g.hasPublicIp && publicRule },
      meta: {
        origin: m(src, 1, "VM 출발 → 도착은 컨테이너(k8s)로 리플랫폼. 기본 도착 실행 방식은 사람 결정(N8 와 같이)"),
        image: m(`${src}.image`, 0.6, "VM 에는 이미지가 없음 → 도착에서 빌드(BuildPlan 자리, 레포·커밋은 사람이 채움)"),
        resources: cpu != null || mem != null
          ? m(`${src}.instanceType`, 0.6, mixed ? `종류가 섞여 있음(${g.instanceTypes.join(", ")}) → 가장 큰 쪽 기준. VM 크기를 요청량으로 옮김, 사람 확인` : "VM 크기를 요청량으로 옮김. 컨테이너에 맞는 값인지 사람 확인")
          : m(`${src}.instanceType`, 0.6, "VM 크기를 못 읽음"),
        env: m(`${src}.env`, 0.6, "VM 환경변수·시작 스크립트는 읽지 않음(비밀이 있을 수 있음). 사람이 채움"),
        serviceAccount: g.identity ? m(`${src}.identity`) : m(`${src}.identity`, 0.9, "인스턴스 프로파일·서비스 계정 없음 → default"),
        ports: ports.length ? m(`${src}.securityGroup`, 0.9, pp.wide ? "넓은 포트 범위는 앱 포트로 안 봄" : "보안 규칙에서 읽음. 접속 포트(22·3389) 제외")
          : m(`${src}.securityGroup`, 0.6, rules ? (pp.adminOnly ? "접속 포트만 열려 있음 → 앱 포트 모름" : pp.wide ? "포트가 너무 넓게 열려 있음 → 앱 포트 모름" : "열린 포트 없음") : "보안 규칙을 못 읽음"),
        replicas: m(`${src}.count`, 0.9, `실행 중 VM ${g.count}대 → replicas. 오토스케일 그룹 여부는 안 읽음`),
      },
      projection: { name: g.name, env: [], plainSecretNames: [], secretRefs: [], specReplicas: g.count, port: ports[0]?.port ?? null, hostname: null, image: g.name, imageDigest: null, healthPath: null },
    };
  },
};
