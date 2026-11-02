import type { AppSpecV2, Capability, HelmValues, TfOutputs } from "@svc/contracts";
import { appNamespace } from "../common/base.js";
import { fromOut, tenantOf, type Target } from "../common/target.js";
import {
  compact, identitiesOf, identityOf, k8sEnv, k8sResources, renderTemplate, secretNamesOf, serviceAddress, workloadsOf,
  type LinkCtx, type WorkloadV2,
} from "./shared.js";

// DRAFT(ai): k8s 도착(EKS·GKE·k3s) Helm 값 v2 = 차트 하나가 workloads[] 를 받는 모양 (설계 27번 3.3, H-A1 기본).
//   프로바이더마다 다른 건 ctx 뿐 (이미지 주소·시크릿 저장소·신원 표시·DB 위치·Ingress 클래스). 차트 쪽은 TA4.
//   없는 값은 키를 안 둔다(프로브·requests). 못 그리는 줄(가중치·헤더 매치·와일드카드)은 warnings 로 남긴다.

export interface WorkloadCtx {
  imageRef: (src: string) => string;
  secretStore: { kind: "ClusterSecretStore"; name: string };
  remoteKey: (secret: string) => string;            // 클라우드 시크릿 저장소 안 이름 (identity 모듈 규칙과 같음)
  saAnnotations: (identityId: string) => Record<string, string>;
  postgres: Array<Record<string, unknown>>;         // 클라우드: 접속·비밀 위치 / 온프레: CNPG 정의
  ingressClass?: string;
  link?: LinkCtx["local"];
}

const srcOf = (img: { repository: string; digest: string | null }) => `${img.repository}@${img.digest}`;

function container(spec: AppSpecV2, c: NonNullable<WorkloadV2["props"]["sidecars"]>[number], w: WorkloadCtx, lc: LinkCtx) {
  return compact({
    name: c.name,
    image: { ref: w.imageRef(srcOf(c.image)) },
    command: c.command, args: c.args, ports: c.ports,
    env: c.env.map((e) => k8sEnv(spec, e, lc)),
    resources: k8sResources(c.resources),
    probes: c.probes,
  });
}

function workloadValues(spec: AppSpecV2, x: WorkloadV2, w: WorkloadCtx, lc: LinkCtx, warnings: string[]) {
  const p = x.props;
  const ident = identityOf(spec, x.id);
  const injected = (p.sidecars ?? []).filter((s) => s.injected);
  if (injected.length) warnings.push(`${x.id}: 메시 주입 사이드카 ${injected.map((s) => s.name).sort().join(",")} 은 안 넣음 (도착 메시가 다시 넣음)`);
  if (p.volumes?.length) warnings.push(`${x.id}: 볼륨 ${p.volumes.map((v) => v.name).sort().join(",")} 은 빈 PVC 로 만듦 (데이터 안 따라옴)`);
  const common = {
    id: x.id,
    kind: x.kind,
    image: { ref: w.imageRef(srcOf(p.image)) },
    command: p.command, args: p.args,
    env: p.env.map((e) => k8sEnv(spec, e, lc)),
    envFrom: p.envFrom?.map((f) => ("config" in f ? { configMapRef: { name: f.config }, prefix: f.prefix } : { secretRef: { name: f.secret }, prefix: f.prefix })),
    resources: k8sResources(p.resources),
    configs: p.configs, secretMounts: p.secretMounts, securityContext: p.securityContext,
    initContainers: p.initContainers?.map((c) => container(spec, c, w, lc)),
    sidecars: (p.sidecars ?? []).filter((s) => !s.injected).map((c) => container(spec, c, w, lc)),
    volumes: p.volumes,
    // "default" SA 는 클러스터가 이미 가짐 → 차트가 만들지 않음 (create: false)
    serviceAccount: { name: p.serviceAccount, create: p.serviceAccount !== "default", annotations: w.saAnnotations(ident.id) },
  };
  if (!common.sidecars.length) (common as Record<string, unknown>).sidecars = undefined;
  if (x.kind === "service") {
    return compact({ ...common, ports: x.props.ports, endpoints: x.props.endpoints, probes: x.props.probes,
      replicas: x.props.replicas, scale: x.props.scale });
  }
  return compact({ ...common, schedule: x.props.schedule, timeZone: x.props.timeZone, concurrencyPolicy: x.props.concurrencyPolicy,
    suspend: x.props.suspend, backoffLimit: x.props.backoffLimit, activeDeadlineSec: x.props.activeDeadlineSec, restartPolicy: x.props.restartPolicy });
}

function ingressValues(spec: AppSpecV2, ns: string, warnings: string[]) {
  if (!spec.entry) return undefined;
  const hosts = spec.entry.hosts.map((h) => {
    for (const n of h.hostnames) if (n.startsWith("*.")) warnings.push(`라우팅: 와일드카드 호스트 ${n} 은 뜻이 넓어질 수 있음 (확인 필요)`);
    const paths = h.routes.flatMap((r) => {
      const live = r.backends.filter((b) => b.weight > 0);
      if (r.backends.length > 1) warnings.push(`라우팅: ${h.hostnames[0]} 가중치 나누기(${r.backends.map((b) => `${b.to}:${b.weight}`).join(",")})는 Ingress 로 못 그림 → 첫 대상만`);
      const b = live[0] ?? r.backends[0]!;
      const svc = spec.components.find((c) => c.id === b.to);
      const ep = svc?.kind === "service" ? (svc.props.endpoints ?? []).find((e) => e.ports.some((p) => p.port === b.port)) : undefined;
      const service = ep?.name ?? (svc?.kind === "service" ? serviceAddress(svc, ns).host.split(".")[0]! : b.to);
      return r.matches.map((m) => {
        if (m.headers?.length || m.method) warnings.push(`라우팅: ${h.hostnames[0]}${m.path.value} 헤더·메서드 매치는 Ingress 로 못 그림`);
        return { path: m.path.value, pathType: m.path.type === "Exact" ? "Exact" : "Prefix", service, port: b.port, workload: b.to };
      });
    });
    return compact({ hostnames: [...h.hostnames], tls: h.tls?.mode === "terminate" ? true : undefined, paths });
  });
  return hosts;
}

export function buildWorkloadValues(spec: AppSpecV2, out: TfOutputs, t: Target, w: WorkloadCtx): HelmValues {
  const ns = appNamespace({ app: spec.app } as never);
  const lc: LinkCtx = { namespace: ns, out, local: w.link };
  const warnings: string[] = [];
  const workloads = workloadsOf(spec).map((x) => workloadValues(spec, x, w, lc, warnings));
  // 시크릿: 출발 비밀 이름 그대로 k8s Secret 을 만든다 (앱이 보는 이름 수정 0). 키별로 원격 이름·속성
  // TODO(human): 출발 비밀 중 DB 비밀번호인 줄은 도착 DB 비밀로 바꿔 끼워야 함 (IR 에 비밀↔postgres 연결 칸 없음). 지금은 값 복사 단계 몫
  const keys = new Map<string, Set<string>>();
  for (const x of workloadsOf(spec)) {
    const add = (s: string, k: string) => keys.set(s, (keys.get(s) ?? new Set()).add(k));
    for (const e of [...x.props.env, ...(x.props.sidecars ?? []).flatMap((c) => c.env), ...(x.props.initContainers ?? []).flatMap((c) => c.env)])
      if ("fromSecret" in e) add(e.fromSecret.secret, e.fromSecret.key);
    for (const s of secretNamesOf(x)) if (!keys.has(s)) keys.set(s, new Set());
  }
  const secrets = [...keys.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, ks]) => ({
    name, remoteKey: w.remoteKey(name),
    // DRAFT(ai): 원격 값은 {키: 값} JSON 한 덩어리. 키 목록이 비면(envFrom·마운트) 전체를 그대로
    keys: [...ks].sort(),
  }));
  const ingress = ingressValues(spec, ns, warnings);
  return compact({
    irVersion: "2",
    app: { name: spec.app.name },
    namespace: ns,
    labels: { "managed-by": "platform", tenant: tenantOf(t) },
    workloads,
    identities: identitiesOf(spec).map((i) => ({ id: i.id, serviceAccount: i.serviceAccount, workloads: i.workloads })),
    externalSecrets: { store: w.secretStore, secrets },
    postgres: w.postgres,
    ingress: ingress ? {
      // DRAFT(ai): v1 과 같이 기본 cloudflared. Cloudflare 전환은 호스트 단위 → hosts 목록이 전환 단위
      mode: "cloudflared", className: w.ingressClass ?? "", tunnelTokenSecret: "cloudflared-token", hosts: ingress,
    } : undefined,
    warnings: [...new Set(warnings)].sort(),
  });
}

// 클라우드(aws·gcp) postgres 값: 접속 주소는 link_outputs, 비밀 위치는 v1 평평한 출력(복제 대상 1개)
export const cloudPostgresValues = (spec: AppSpecV2, out: TfOutputs, secretOutput: string, extra: Record<string, unknown> = {}) =>
  spec.components.filter((c) => c.kind === "postgres").sort((a, b) => a.id.localeCompare(b.id)).map((c) => ({
    id: c.id, mode: "external",
    host: fromOut(out, `link.${c.id}.host`), port: 5432,
    passwordSecret: fromOut(out, secretOutput), ...extra,
  }));

export const renderedCaps = (extra: Capability[]): Capability[] => [...new Set(extra)].sort();
export { renderTemplate };
