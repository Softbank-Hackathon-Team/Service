import type { PostureV2 } from "@svc/contracts";
import type { RawK8sNetworkPolicy } from "./raw-k8s.js";
import type { MappedComponent } from "./types.js";

// DRAFT(ai): 보안 기준선 (설계 20번 4.3(다), PoC inferLinks 끝 부분). 기본은 mirror(같게).
//   ① 네임스페이스: NetworkPolicy 가 없으면 "다 열림(allow-all)" 그대로. 있으면 이름만(본문은 보안 명세 파트)
//   ② 데이터 리소스: 출발 방화벽(SG·허용 네트워크)과 공개 여부. 못 읽었으면 "unknown" → 모듈이 사람에게 묻는다
//   permissions(IAM 원문)는 IAM 매퍼 묶음(I4) 몫 → 지금은 빈 목록
export function buildPosture(components: MappedComponent[], policies: RawK8sNetworkPolicy[]): PostureV2 {
  const network: PostureV2["network"] = [];
  const workloads = components.filter((c) => c.kind === "service" || c.kind === "job");
  const namespaces = [...new Set(workloads.map((c) => c.native.namespace).filter((x): x is string => Boolean(x)))].sort();
  for (const ns of namespaces) {
    const own = policies.filter((p) => p.metadata.namespace === ns).sort((a, b) => a.metadata.name.localeCompare(b.metadata.name));
    const pol = own.map((p) => p.metadata.name);
    // N6 DRAFT(ai): 본문 원문도 담는다 (도착이 같은 이름·같은 규칙으로 그림). policyTypes 는 Ingress·Egress 만
    const rules = own.map((p) => ({
      name: p.metadata.name,
      podSelector: (p.spec.podSelector ?? {}) as Record<string, unknown>,
      ...(p.spec.policyTypes ? { policyTypes: p.spec.policyTypes.filter((t): t is "Ingress" | "Egress" => t === "Ingress" || t === "Egress") } : {}),
      ...(p.spec.ingress ? { ingress: p.spec.ingress as Array<Record<string, unknown>> } : {}),
      ...(p.spec.egress ? { egress: p.spec.egress as Array<Record<string, unknown>> } : {}),
    }));
    network.push({ scope: "namespace", namespace: ns, mode: "mirror", policies: pol, default: pol.length ? "as-declared" : "allow-all", ...(rules.length ? { rules } : {}) });
  }
  for (const t of [...components].filter((c) => c.network).sort((a, b) => (a.id! < b.id! ? -1 : 1)))
    network.push({ scope: "component", subject: t.id!, mode: "mirror", ingress: t.network!.ingress, public: t.network!.public });
  return { permissions: [], network };
}
