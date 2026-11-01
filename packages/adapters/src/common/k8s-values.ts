import type { AppSpec, HelmValues } from "@svc/contracts";

// k8s 층 공통: EKS·GKE·k3s 모두 같은 차트(gitops/charts/app), 같은 값 모양.
// 프로바이더마다 다른 건 ctx(이미지 주소, 시크릿 저장소, DB 위치, 앱 신원 표시)뿐.
export interface ValuesCtx {
  tenant: string;
  imageRef: string;
  saAnnotations?: Record<string, string>;
  secretStore: { kind: "ClusterSecretStore"; name: string };
  database: Record<string, unknown> | null;
  ingressMode?: "cloudflared" | "lb";
  ingressClass?: string;
  remoteKey?: (r: { name: string; key: string }) => string;   // 클라우드 시크릿 저장소의 이름. 없으면 차트 기본 규칙
}

export function buildValues(spec: AppSpec, ctx: ValuesCtx): HelmValues {
  const s = spec.service;
  const byName = <T extends { name: string }>(xs: T[]) => [...xs].sort((a, b) => a.name.localeCompare(b.name));
  return {
    app: { name: spec.app.name },
    image: { ref: ctx.imageRef },                 // repo@sha256:… (태그 없음)
    replicas: s.replicas,
    resources: {
      requests: { cpu: s.cpu, memory: s.memory },
      limits: { memory: s.memory },              // DRAFT(ai): CPU limit은 안 건다(스로틀링 방지)
    },
    port: s.port,
    probes: { readiness: s.healthPath, liveness: s.healthPath },
    env: byName(s.env),
    serviceAccount: { name: spec.app.name, annotations: ctx.saAnnotations ?? {} },
    externalSecrets: { store: ctx.secretStore,
      refs: byName(s.secretRefs).map((r) => (ctx.remoteKey ? { ...r, remoteKey: ctx.remoteKey(r) } : r)) },
    database: ctx.database,                       // 클라우드: 접속 정보 / 온프레: CNPG 정의
    ingress: {
      // DRAFT(ai): 기본 cloudflared(인바운드 0, Cloudflare LB 원본 = 터널). "lb"면 ALB/GCE Ingress
      // TODO(human): 데모에서 ALB·GCLB를 직접 보여 줄지, 터널만 쓸지
      mode: ctx.ingressMode ?? "cloudflared",
      className: ctx.ingressClass ?? "",
      hostname: spec.ingress.hostname,
      tunnelTokenSecret: "cloudflared-token",    // 값은 ESO로, 여기엔 이름만
    },
    labels: { "managed-by": "platform", tenant: ctx.tenant },
  };
}
