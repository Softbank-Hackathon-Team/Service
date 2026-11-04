import type { AppSpecV2, Capability, HelmValues, TfOutputs } from "@svc/contracts";
import { ChartValues, ChartWorkload, type ChartContainer, type ChartPostgres } from "@svc/contracts";
import { toK8sProbes } from "./k8s-probe.js";
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
  postgres: ChartPostgres[];                        // 클라우드: 접속·비밀 위치 / 온프레: CNPG 정의
  ingressClass?: string;
  link?: LinkCtx["local"];
}

const srcOf = (img: { repository: string; digest: string | null }) => `${img.repository}@${img.digest}`;
type Svc = Extract<WorkloadV2, { kind: "service" }>;
type PortV2 = NonNullable<Svc["props"]["ports"]>[number];
const containerPorts = (ps: PortV2[] | undefined) => ps?.map((p) => compact({ name: p.name, containerPort: p.port, protocol: p.protocol, hostPort: p.hostPort }));

// TP-1: 가져오기(LK-1)가 command·args 칸에 넣은 \${<id>.<출력>} 자리표시를 도착 값으로 푼다 (위치 번호가 적힌 칸만. 나머지 글자는 그대로)
const fill = (spec: AppSpecV2, list: string[] | undefined, at: number[] | undefined, lc: LinkCtx) =>
  list && at?.length ? list.map((v, i) => (at.includes(i) ? renderTemplate(spec, v, lc) : v)) : list;

// CV-1·CM-3: IR 파드 볼륨 원문 → k8s 볼륨. PVC 볼륨은 차트가 만드는 <워크로드>-<이름> PVC 를 가리킨다
type PodVolumeV2 = NonNullable<WorkloadV2["props"]["podVolumes"]>[number];
const k8sVolume = (v: PodVolumeV2) => ({ name: v.name, [v.type]: v.source });
// DRAFT(ai): IR 접근 방식 → k8s accessModes (RWO 가 기본: 안 적힌 볼륨은 단일 노드 쓰기로 본다)
const ACCESS = { RWO: "ReadWriteOnce", RWX: "ReadWriteMany", ROX: "ReadOnlyMany", RWOP: "ReadWriteOncePod" } as const;

function container(spec: AppSpecV2, owner: string, c: NonNullable<WorkloadV2["props"]["sidecars"]>[number], w: WorkloadCtx, lc: LinkCtx, warnings: string[]): ChartContainer {
  const extra = Object.keys(c.probes ?? {}).filter((k) => !["readiness", "liveness", "startup"].includes(k));
  if (extra.length) warnings.push(`${owner}/${c.name}: 프로브 이름 ${extra.sort().join(",")} 은 k8s 에 없는 칸이라 안 넣음`);
  const pr = toK8sProbes(c.probes);
  return compact({
    name: c.name,
    image: w.imageRef(srcOf(c.image)),
    command: fill(spec, c.command, c.commandTemplates, lc), args: fill(spec, c.args, c.argTemplates, lc), ports: containerPorts(c.ports),
    env: c.env.map((e) => k8sEnv(spec, e, lc)),
    resources: k8sResources(c.resources),
    readinessProbe: pr?.readiness, livenessProbe: pr?.liveness, startupProbe: pr?.startup,
    volumeMounts: c.volumeMounts?.length ? c.volumeMounts.map((m) => compact({ ...m })) : undefined,
    restartPolicy: c.restartPolicy, securityContext: c.securityContext,
  });
}

// IR endpoints 한 줄 = k8s Service 한 개. endpoints 가 없고 포트만 있으면 워크로드 이름 Service 하나 (serviceAddress 와 같은 이름 규칙)
function servicesOf(x: Svc): ChartWorkload["services"] {
  const named = <T extends { name?: string; port: number }>(ps: T[]) =>
    // DRAFT(ai): Service 포트가 2개 이상이면 k8s 가 이름을 요구 → 이름 없는 줄은 p-<포트>
    ps.map((p) => (p.name || ps.length === 1 ? p : { ...p, name: `p-${p.port}` }));
  if (x.props.endpoints?.length) {
    return [...x.props.endpoints].sort((a, b) => a.name.localeCompare(b.name)).map((e) => ({
      name: e.name, type: e.type,
      ports: named(e.ports.map((p) => compact({ name: p.name, port: p.port, targetPort: p.targetPort, protocol: p.protocol, appProtocol: p.appProtocol }))),
      ...(e.annotations && Object.keys(e.annotations).length ? { annotations: e.annotations } : {}),
    }));
  }
  if (!x.props.ports?.length) return undefined;
  return [{ name: x.id, type: "ClusterIP", ports: named(x.props.ports.map((p) => compact({ name: p.name, port: p.port, targetPort: p.port, protocol: p.protocol }))) }];
}

function workloadValues(spec: AppSpecV2, x: WorkloadV2, w: WorkloadCtx, lc: LinkCtx, warnings: string[]): ChartWorkload {
  const p = x.props;
  const ident = identityOf(spec, x.id);
  const injected = (p.sidecars ?? []).filter((s) => s.injected);
  if (injected.length) warnings.push(`${x.id}: 메시 주입 사이드카 ${injected.map((s) => s.name).sort().join(",")} 은 안 넣음 (도착 메시가 다시 넣음)`);
  if (p.volumes?.length) warnings.push(`${x.id}: 볼륨 ${p.volumes.map((v) => v.name).sort().join(",")} 은 빈 PVC 로 만듦 (데이터 안 따라옴)`);
  // CM-2·CM-3·CV-1: 출발 마운트 원문(podVolumes·volumeMounts, k8s 출발)이 있으면 그것을 그대로 그린다.
  //   이때 configs·pvcs 는 객체(ConfigMap·PVC)만 만들고 마운트는 안 한다 (같은 경로를 두 번 마운트하지 않게).
  //   원문이 없으면(ECS·Cloud Run·VM 출발) 예전처럼 configs·pvcs·secretMounts 의 mountPath 로 마운트
  const raw = !!(p.volumeMounts?.length || p.podVolumes?.length
    || [...(p.sidecars ?? []), ...(p.initContainers ?? [])].some((c) => c.volumeMounts?.length));
  const pvcs = p.volumes?.map((v) => {
    // DRAFT(ai): 크기를 못 읽은 볼륨은 1Gi 로 두고 경고 (PVC 는 크기가 필수). 사람이 명세에서 고친다
    if (v.sizeGb == null) warnings.push(`${x.id}: 볼륨 ${v.name} 크기를 못 읽어 1Gi 로 둠 (확인 필요)`);
    return compact({ name: v.name, size: `${v.sizeGb ?? 1}Gi`, mountPath: raw ? undefined : v.mountPath || undefined, accessModes: [ACCESS[v.access ?? "RWO"]],
      claimTemplate: v.claimTemplate || undefined });
  });
  const volumes = raw ? [
    ...(p.podVolumes ?? []).map(k8sVolume),
    // D6: claimTemplate 볼륨은 StatefulSet volumeClaimTemplates 가 같은 이름으로 붙인다 → 파드 볼륨에 안 넣음
    ...(p.volumes ?? []).filter((v) => !v.claimTemplate).map((v) => ({ name: v.name, persistentVolumeClaim: { claimName: `${x.id}-${v.name}` } })),
  ] : [];
  // TP-1: ConfigMap 값 중 templateKeys 키만 자리표시를 푼다
  const configs = p.configs?.map((c) => {
    const tk = new Set(c.templateKeys ?? []);
    const data = tk.size ? Object.fromEntries(Object.entries(c.data).map(([k, v]) => [k, tk.has(k) ? renderTemplate(spec, v, lc) : v])) : c.data;
    return compact({ name: c.name, data, mountPath: raw ? undefined : c.mountPath });
  });
  const sidecars = (p.sidecars ?? []).filter((s) => !s.injected).map((c) => container(spec, x.id, c, w, lc, warnings));
  const common = {
    name: x.id,
    kind: x.kind,
    image: w.imageRef(srcOf(p.image)),
    command: fill(spec, p.command, p.commandTemplates, lc), args: fill(spec, p.args, p.argTemplates, lc),
    env: p.env.map((e) => k8sEnv(spec, e, lc)),
    envFrom: p.envFrom?.map((f) => compact("config" in f ? { configMapRef: compact({ name: f.config, optional: f.optional }), prefix: f.prefix || undefined } : { secretRef: compact({ name: f.secret, optional: f.optional }), prefix: f.prefix || undefined })),
    resources: k8sResources(p.resources),
    configs,
    secretMounts: raw ? undefined : p.secretMounts?.map((m) => ({ name: m.secret, secretName: m.secret, mountPath: m.mountPath })),
    // IR securityContext = 출발 주 컨테이너의 securityContext (매퍼 k8s-deployment)
    securityContext: p.securityContext ? { container: p.securityContext } : undefined,
    initContainers: p.initContainers?.map((c) => container(spec, x.id, c, w, lc, warnings)),
    sidecars: sidecars.length ? sidecars : undefined,
    pvcs,
    volumes: volumes.length ? volumes : undefined,
    volumeMounts: raw && p.volumeMounts?.length ? p.volumeMounts.map((m) => compact({ ...m })) : undefined,
    // CV-1: 배치·노드 공유·파드 annotation 원문 그대로
    scheduling: p.scheduling, host: p.host, podAnnotations: p.podAnnotations,
    podLabels: p.podLabels && Object.keys(p.podLabels).length ? p.podLabels : undefined,   // PL-2
    // "default" SA 는 클러스터가 이미 가짐 → 차트가 만들지 않음 (create: false)
    serviceAccount: { name: p.serviceAccount, create: p.serviceAccount !== "default", annotations: w.saAnnotations(ident.id) },
  };
  if (x.kind === "service") {
    const r = x.props.replicas;
    // 출발에 HPA 가 있었으면(scale 또는 최소≠최대) HPA 로, 아니면 고정 복제 수
    const hpa = x.props.scale !== undefined || r.min !== r.max;
    // D6: StatefulSet·DaemonSet 은 같은 종류로. DaemonSet 은 개수 = 노드 수 → replicas·HPA 를 안 그림
    const wk = x.props.workloadKind === "statefulset" || x.props.workloadKind === "daemonset" ? x.props.workloadKind : undefined;
    if (wk === "daemonset") return ChartWorkload.parse(compact({ ...common, workloadKind: wk, ports: containerPorts(x.props.ports), services: servicesOf(x), probes: toK8sProbes(x.props.probes),
      disruption: x.props.disruption ? compact({ ...x.props.disruption }) : undefined }));
    return ChartWorkload.parse(compact({ ...common, workloadKind: wk, statefulSet: wk === "statefulset" && x.props.statefulSet ? compact({ ...x.props.statefulSet }) : undefined,
      ports: containerPorts(x.props.ports), services: servicesOf(x), probes: toK8sProbes(x.props.probes),
      replicas: hpa ? undefined : r.max,
      scale: hpa ? compact({ min: r.min, max: r.max, cpuPct: x.props.scale?.targetCpuPct, metrics: x.props.scale?.metrics, behavior: x.props.scale?.behavior }) : undefined,
      disruption: x.props.disruption ? compact({ ...x.props.disruption }) : undefined }));
  }
  return ChartWorkload.parse(compact({ ...common, job: compact({ schedule: x.props.schedule, timeZone: x.props.timeZone, concurrencyPolicy: x.props.concurrencyPolicy,
    suspend: x.props.suspend, backoffLimit: x.props.backoffLimit, activeDeadlineSeconds: x.props.activeDeadlineSec, restartPolicy: x.props.restartPolicy }) }));
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

// 차트 cloudflared 파드가 읽는 Secret 이름 (gitops/charts/app/templates/ingress.yaml, 키 token)
const TUNNEL_SECRET = "cloudflared-token";

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
  const ingress = ingressValues(spec, ns, warnings);
  // pf-d FM-TRF-23: 입구가 cloudflared 면 차트 cloudflared 파드가 Secret <TUNNEL_SECRET> 의 키 token 을 읽는다.
  //   예전엔 앱 네임스페이스에 그 Secret 을 만드는 곳이 없어 파드가 CreateContainerConfigError → Argo Degraded → deploy paused.
  //   이제 다른 비밀과 같은 길(ExternalSecret)로 만든다. 값은 플랫폼이 복사하지 않는다(ADR-072) → 저장소에 넣으라고 경고
  //   TODO(human): 도착 터널(토큰)을 누가 만들어 저장소에 넣나 (Cloudflare 계정 세팅). 지금은 사람이 넣는다
  if (ingress?.length && !keys.has(TUNNEL_SECRET)) {
    keys.set(TUNNEL_SECRET, new Set(["token"]));
    warnings.push(`입구: cloudflared 터널 토큰을 비밀 저장소 ${w.remoteKey(TUNNEL_SECRET)} (키 token) 에 넣어야 도착 입구 파드가 뜸`);
  }
  const secrets = [...keys.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, ks]) => ({
    name, remoteKey: w.remoteKey(name),
    // DRAFT(ai): 원격 값은 {키: 값} JSON 한 덩어리. 키 목록이 비면(envFrom·마운트) 전체를 그대로
    keys: [...ks].sort(),
  }));
  return ChartValues.parse(compact({
    app: { name: spec.app.name },
    namespace: ns,
    labels: { "managed-by": "platform", tenant: tenantOf(t) },
    workloads,
    identities: identitiesOf(spec).map((i) => ({ id: i.id, serviceAccount: i.serviceAccount, workloads: i.workloads })),
    externalSecrets: { store: w.secretStore, secrets },
    postgres: w.postgres,
    ingress: ingress ? {
      // DRAFT(ai): v1 과 같이 기본 cloudflared. Cloudflare 전환은 호스트 단위 → hosts 목록이 전환 단위
      mode: "cloudflared", className: w.ingressClass ?? "", tunnelTokenSecret: TUNNEL_SECRET, hosts: ingress,
    } : undefined,
    warnings: [...new Set(warnings)].sort(),
  })) as HelmValues;
}

// 클라우드(aws·gcp) postgres 값: 접속 주소는 link_outputs, 비밀 위치는 v1 평평한 출력(복제 대상 1개)
// DM-7 뒤(PG-PORT): 포트는 IR 출발 포트 그대로 (aws 모듈이 같은 포트로 만듦). fixedPort = 도착이 포트를 못 바꾸는 상품(Cloud SQL 5432)
export const cloudPostgresValues = (spec: AppSpecV2, out: TfOutputs, secretOutput: string, extra: { passwordProperty?: string } = {}, fixedPort?: number): ChartPostgres[] =>
  spec.components.filter((c) => c.kind === "postgres").sort((a, b) => a.id.localeCompare(b.id)).map((c) => ({
    id: c.id, mode: "external" as const,
    host: fromOut(out, `link.${c.id}.host`), port: fixedPort ?? c.props.port ?? 5432,
    passwordSecret: fromOut(out, secretOutput), ...extra,
    secretName: `${spec.app.name}-${c.id}-app`,
  }));

export const renderedCaps = (extra: Capability[]): Capability[] => [...new Set(extra)].sort();
export { renderTemplate };
