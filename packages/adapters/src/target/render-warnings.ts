// W-1: k8s 도착 Builder 가 렌더하면서 내던 경고를 계획 전에 볼 수 있게 순수 함수로 뽑는다 (사전 점검 PC-V2-K8S-*).
//   손실(가중치·헤더 매치 라우팅·hostPath·기본 사이드카 등)은 capability 막기(v2Blockers → PC-V2-UNSUP)가 맡고, 여기는 "옮기지만 달라지는 것" 알림만.
//   같은 명세 + 같은 도착이면 같은 목록 (정렬)
import type { AppSpecV2, Provider } from "@svc/contracts";
import { CLOUD_ONLY } from "../import/annotations.js";
import { workloadsOf } from "./shared.js";

const cloudOf = (p: Provider): "aws" | "gcp" | "onprem" | null => (p === "aws" || p === "gcp" || p === "onprem" ? p : null);

/** 도착 렌더에서 출발과 달라지는 것 (경고). provider = 도착 */
export function k8sRenderWarnings(spec: AppSpecV2, provider: Provider): string[] {
  const out: string[] = [];
  const target = cloudOf(provider);
  const foreign = (ann: Record<string, string> | undefined) =>
    Object.keys(ann ?? {}).filter((k) => CLOUD_ONLY.some((c) => c.re.test(k) && c.cloud !== target)).sort();
  // k8s 로 그리는 것만 (관리형 컨테이너·VM 서비스는 각자 경고가 있음. 잡은 k8s CronJob)
  for (const w of workloadsOf(spec).filter((x) => x.kind !== "service" || x.props.runtime === "k8s")) {
    const p = w.props;
    const injected = [...(p.sidecars ?? []), ...(p.initContainers ?? [])].filter((s) => s.injected).map((s) => s.name).sort();
    if (injected.length) out.push(`${w.id}: 메시 주입 사이드카 ${injected.join(",")} 는 안 넣음 (도착 메시가 다시 넣음. 도착에 같은 메시가 없으면 mTLS·재시도가 빠짐)`);
    const pvcs = (p.volumes ?? []).map((v) => v.name).sort();
    if (pvcs.length) out.push(`${w.id}: 볼륨 ${pvcs.join(",")} 는 같은 이름의 빈 PVC 로 만듦 (디스크 데이터는 안 따라옴)`);
    if (w.kind === "service") for (const e of w.props.endpoints ?? []) {
      if (e.type === "LoadBalancer") out.push(`${w.id}: L4 LoadBalancer ${e.name} 는 도착에서 새 주소를 받음 → 바깥 장비·DNS 는 사람이 바꿈 (가중치 전환은 HTTP 입구만)`);
      const f = foreign(e.annotations);
      if (f.length) out.push(`${w.id}: Service ${e.name} annotation ${f.join(",")} 은 다른 클라우드 전용 → 도착 컨트롤러가 무시함`);
    }
    const fp = foreign(p.podAnnotations);
    if (fp.length) out.push(`${w.id}: 파드 annotation ${fp.join(",")} 은 다른 클라우드 전용 → 도착에서 무시됨`);
  }
  for (const h of spec.entry?.hosts ?? []) {
    for (const n of h.hostnames) if (n.startsWith("*.")) out.push(`입구: 와일드카드 호스트 ${n} 은 뜻이 넓어질 수 있음 (확인 필요)`);
    const f = foreign(h.annotations);
    if (f.length) out.push(`입구: ${h.hostnames[0] ?? "?"} annotation ${f.join(",")} 은 다른 클라우드 전용 → 도착 입구 컨트롤러가 무시함`);
  }
  return [...new Set(out)].sort();
}
