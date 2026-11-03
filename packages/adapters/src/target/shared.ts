import type { AppSpecV2, Capability, ComponentV2, EnvVarV2, ModuleInstance, ModuleRef, Provider, TfOutputs } from "@svc/contracts";
import { LINK_OUTPUTS, LINK_TEMPLATE, TF_KIND_VARS } from "@svc/contracts";
import { AdapterError } from "../common/errors.js";
import { boundedName } from "../common/names.js";
import { fromOut, nameSeed, migrationSeed, type Target } from "../common/target.js";
import { MODULE_DIGEST } from "../module-digests.js";
import { ACCESS_ANNOTATION } from "../import/annotations.js";

// DRAFT(ai): 도착 Builder v2 공통 조각 (설계 27번 3.1·3.3·3.4·3.6, A1 = 24번 I5).
//   네 Builder(aws·gcp·onprem·azure-mock)가 같이 쓰는 순수 함수만. 네트워크·DB·환경변수 읽기 없음.
//   원칙: IR 에 있는 칸은 도착에 그대로 옮긴다. 못 옮기는 칸은 버리지 않고 v2Blockers 로 막는다. 없는 값은 안 만든다.

type Service = Extract<ComponentV2, { kind: "service" }>;
type Job = Extract<ComponentV2, { kind: "job" }>;
type Postgres = Extract<ComponentV2, { kind: "postgres" }>;
export type WorkloadV2 = Service | Job;

// ── 오류 코드 ──────────────────────────────────────────
// UNSUPPORTED_V2 = 도착이 이 명세를 못 그림 (capability 밖). NEEDS_HUMAN 은 precheck 가 내는 쪽(A3)이라 Builder 는 안 던진다
export const UNSUPPORTED_V2 = "UNSUPPORTED_V2";
export const LINK_OUTPUT_UNKNOWN = "LINK_OUTPUT_UNKNOWN";

// ── 칸 대응표 (3.3 표를 코드로) ─────────────────────────
// render  = 도착 값·변수에 그대로 들어감
// info    = 도착 변수엔 안 들어가지만 버리지 않음(precheck 대조·화면 표시·"출발과 달라짐" 줄)
// block:x = capability x 가 있어야 그림. 없으면 v2Blockers 가 막는다
// DRAFT(ai): 칸마다 분류는 A1 기준. A5(cache·…)·A8(grants·permissions)에서 늘어남. 시험이 Zod 모양 키 ⊂ 이 표를 확인한다
export type FieldRule = "render" | "info" | `block:${string}`;
const WORKLOAD_FIELDS: Record<string, FieldRule> = {
  podLabels: "render",          // PL-2: 출발 파드 라벨 그대로 (플랫폼 라벨 우선)
  namespace: "render",          // M-1(Jeong 11/3 18:39Z): 도착 네임스페이스 = 출발 이름 그대로 (targetNamespace). 도착은 app-<앱> 로 그림 — FM-IR-03 DECISION(team) (targetNamespace 위)
  image: "render", command: "render", args: "render", resources: "render", env: "render", envFrom: "render",
  configs: "render", secretMounts: "render", serviceAccount: "render", securityContext: "render",
  sidecars: "render", initContainers: "render", volumes: "render",
  // N4·N5·N10·LK-1: Helm 값으로 그대로 (차트 칸은 d8-pb1 ChartValues)
  podVolumes: "render", volumeMounts: "render", scheduling: "render", host: "render", podAnnotations: "render", commandTemplates: "render", argTemplates: "render",
  nodeArch: "info",             // A-1: 도착 노드풀 arch 대조만 (v2Blockers). 도착 값엔 안 들어감
  // SS-V: 비밀 출처(ESO·Vault Agent)는 기록. 도착은 ExternalSecret(CL-4 store)로 같은 이름 Secret 을 만든다. 값 복사·원격 키 매핑은 사람이 (v2Blockers needsHuman)
  secretSources: "info",
};
export const V2_FIELD_COVERAGE: Record<string, Record<string, FieldRule>> = {
  service: { ...WORKLOAD_FIELDS, runtime: "render", origin: "info", ports: "render", endpoints: "render",
    workloadKind: "render", statefulSet: "render",   // D6: 도착도 같은 종류
    probes: "render", replicas: "render", scale: "render", disruption: "render" },
  job: { ...WORKLOAD_FIELDS, schedule: "render", timeZone: "render", concurrencyPolicy: "render", suspend: "render",
    backoffLimit: "render", activeDeadlineSec: "render", restartPolicy: "render" },
  postgres: { majorVersion: "render", storageGb: "render", storageMaxGb: "render", compute: "render", ha: "render",
    readReplicas: "render", parameters: "render",
    logicalReplication: "info",  // 도착은 CDC 때문에 항상 켬 (플랫폼 요구)
    tlsRequired: "render",       // SSL-1: 도착 모듈 require_tls (false 면 checkV2 가 tls_relaxed 승인 줄)
    appDatabase: "render", appUser: "render",   // DBN-1·E10-2: 도착 DB 이름·앱 계정 그대로 (모듈 db_name·app_user, CNPG initdb)
    backup: "render", maintenanceWindow: "render",   // BK-1: 도착 모듈 백업 보관·PITR·유지보수 창 (온프레는 경고)
    walStorageGb: "render",      // DM-8: 온프레 CNPG walStorage. 클라우드는 볼륨 하나 (사전 점검 경고)
    port: "render",              // DM-7: RDS 는 같은 포트, Cloud SQL·CNPG 는 5432 고정(사전 점검 경고)
    databases: "info", extensions: "info", inCluster: "info" },   // precheck 대조만 (도착 지원 여부, 3.1)
  cache: { engine: "block:kind.cache", version: "block:kind.cache", memoryMiB: "block:kind.cache", clusterMode: "block:kind.cache",
    shards: "block:kind.cache", tls: "block:kind.cache", auth: "block:kind.cache", ha: "block:kind.cache", port: "block:kind.cache", inCluster: "info" },
  objectStore: { versioning: "block:kind.objectStore", public: "block:kind.objectStore", sizeGb: "block:kind.objectStore",
    lifecycle: "block:kind.objectStore", cors: "block:kind.objectStore",
    notifications: "block:objectStore.notifications", inCluster: "info" },   // B-1b: 도착 렌더 아직 없음 → 있으면 막음
  queue: { model: "block:kind.queue", ordered: "block:kind.queue", retentionSec: "block:kind.queue",
    ackTimeoutSec: "block:kind.queue", deadLetter: "block:kind.queue",
    // PS-1·DM-6·B-1: idleExpirySec 는 SQS 에 같은 칸이 없음(늘 안 지움) — 막지 않음
    idleExpirySec: "block:kind.queue", retainAcked: "block:kind.queue.retainAcked", filter: "block:kind.queue.filter",
    push: "block:kind.queue.push", subscriptions: "block:kind.queue.subscriptions",
    topicSubscriptions: "block:queue.topicSubscriptions", inCluster: "info" },   // INCL: 렌더 전에 renderViewV2 가 뺌          // B-2: 도착 렌더 아직 없음 → 있으면 막음
  // 최상위
  spec: { schemaVersion: "info", app: "render", availability: "info", components: "render", links: "render",
    entry: "render", posture: "render", security: "info", rbac: "render",
    secrets: "render",            // T1·SC-1: 비밀 이름·type·키 → ExternalSecret (값은 N2 복사 Job)
    privateDns: "info",         // E-2: 도착에 사설 영역을 만들지 않음 → 계획 줄(PC-V2-DNS)
    namespaces: "render",        // NS-1: 허용 목록 라벨·annotation → 도착 네임스페이스 (메시 주입은 capability mesh.* 가 있어야)
    serviceAliases: "render" },  // V-1: ExternalName Service
};

// k8s 출발 서비스·잡이 쓰는 렌더 capability. Builder 가 이걸 capabilities() 에 넣는다
export const K8S_RENDER_CAPS: Capability[] = [
  "runtime.k8s", "kind.service", "kind.job",
  "link.connect", "link.call", "link.external", "link.unmapped",
  "entry.ingress", "posture.allowAll", "posture.component", "image.registry",
  // NSC-1 DRAFT(ai): k8s 기본 사이드카(init + restartPolicy: Always)는 1.29+ 에서 기본으로 켜짐. 세 도착(EKS·GKE·k3s)이 1.29+ 라고 두었다
  // TODO(human): 실제 도착 클러스터 버전이 1.29 미만이면 이 capability 를 그 도착에서 빼야 함 (빼면 계획에서 막힘)
  "pod.nativeSidecar",
  // A-1 DRAFT(ai): 지금 도착 노드풀은 전부 x86_64 (aws platform AL2023_x86_64, gcp 기본 머신, 온프레 amd64 고정). arm64 노드풀은 TODO(human)
  "arch.amd64",
  // D6·PB-1: 차트(workloads.yaml)가 StatefulSet·DaemonSet·headless Service 를 그린다
  "workload.statefulset", "workload.daemonset", "endpoint.headless",
];

// CL-1 DRAFT(ai): 도착별 PVC StorageClass. GKE = standard-rwo(CSI 내장 기본), k3s = local-path(기본), EKS = 없음.
//   EKS 1.30+ 새 클러스터는 기본 StorageClass 가 없고 env 모듈에 aws-ebs-csi-driver 애드온도 없다(infra/modules/aws/env) →
//   AWS 도착은 volume.pvc capability 를 안 가져 계획 전에 막는다. 애드온·gp3 기본 클래스를 넣으면 "gp3" 와 capability 를 같이 더한다 (범위 밖, TODO(human))
export const PVC_STORAGE_CLASS: Partial<Record<Provider, string>> = { gcp: "standard-rwo", onprem: "local-path" };
// G-1 DRAFT(ai): CPU·메모리 말고 도착이 그냥 그릴 수 있는 자원 이름. 나머지(nvidia.com/gpu·hugepages-*·장치 플러그인 자원)는
//   도착 노드풀에 그 자원이 있어야 함 → capability resource.<이름>(GPU 는 resource.gpu). 지금 도착은 아무것도 안 가짐 = 계획 단계에서 막힘
const PLAIN_EXTENDED = new Set(["ephemeral-storage"]);
export const extendedCap = (name: string): Capability | null =>
  PLAIN_EXTENDED.has(name) ? null : /gpu|(^|\/)mig-/i.test(name) ? "resource.gpu" : `resource.${name}`;
// ── 도착 네임스페이스 (M-1) ─────────────────────────────
// M-1 (Jeong 11/3 18:39Z): 도착 네임스페이스 = 출발 이름 그대로. 같은 이름이라 서비스 주소(<svc>.<ns>.svc)·설정 파일 안 FQDN 이 그대로 맞는다.
// DRAFT(ai): k8s 밖 출발(ECS·Cloud Run·VM)은 출발 네임스페이스가 없음 → 예전 규칙 app-<앱>. 여러 개면 이름순 첫째(막기는 v2Blockers namespace.multi)
export const LEGACY_NS_PREFIX = "app-";
export function sourceNamespacesOf(spec: AppSpecV2): string[] {
  const s = new Set<string>();
  for (const c of spec.components) if ((c.kind === "service" || c.kind === "job") && c.props.namespace) s.add(c.props.namespace);
  for (const n of spec.namespaces ?? []) s.add(n.name);
  return [...s].sort();
}
// DECISION(team): 도착 네임스페이스는 app-<앱>(appNamespace) 유지. M-1·Z66 울타리·gitops 검사는 안 바꾼다 (FM-IR-03, Jeong 2026-11-04 01:39Z).
//   그래서 도착 Builder·gitops 는 이 함수를 안 쓴다. 이름은 달라도 동작은 같다: 출발 네임스페이스를 가리키는 서비스 주소(<svc>.<ns>[.svc[.cluster.local]])는
//   env·ConfigMap 다시 쓰기가 도착 이름으로 바꾼다 (시험 pf-c-eks-rds FM-IR-03). 바꾸려면 Z66 울타리(구역 app-* 만)와 별도 gitops 레포 tools/validate.mjs 도 같이
export function targetNamespace(spec: AppSpecV2): string {
  return sourceNamespacesOf(spec)[0] ?? `${LEGACY_NS_PREFIX}${spec.app.name}`;
}
// 도착에서 플랫폼이 만들 수 없는(이미 있거나 플랫폼 구역인) 이름. Kyverno 가드는 managed-by=platform 표시가 있어야 고치고 지우게 함
// DRAFT(ai): 목록은 k8s 기본 + 플랫폼이 까는 구역 (bootstrap·env 층). 처리 = 막기 (아래 DECISION(team))
export const RESERVED_NAMESPACES = /^(default|kube-.*|argocd|external-secrets|cnpg-system|cert-manager|kyverno|cloudflared|ingress-nginx|monitoring|gmp-.*|gke-.*|platform.*)$/;

// NS-1: 메시 주입 표시 → 도착 capability (없으면 막음). 값이 "disabled"·"false" 면 주입 안 함 = 요구 없음
const MESH_KEYS: Array<{ where: "labels" | "annotations"; key: string; mesh: string; on: (v: string) => boolean }> = [
  { where: "labels", key: "istio-injection", mesh: "istio", on: (v) => v === "enabled" },
  { where: "labels", key: "istio.io/rev", mesh: "istio", on: (v) => v !== "" },
  { where: "labels", key: "istio.io/dataplane-mode", mesh: "istio", on: (v) => v === "ambient" },
  { where: "labels", key: "kuma.io/sidecar-injection", mesh: "kuma", on: (v) => v === "enabled" || v === "true" },
  { where: "annotations", key: "linkerd.io/inject", mesh: "linkerd", on: (v) => v === "enabled" || v === "ingress" },
];
export function meshesOf(spec: AppSpecV2): Array<{ namespace: string; mesh: string; key: string }> {
  const out: Array<{ namespace: string; mesh: string; key: string }> = [];
  for (const n of spec.namespaces ?? [])
    for (const m of MESH_KEYS) {
      const v = n[m.where]?.[m.key];
      if (v !== undefined && m.on(v)) out.push({ namespace: n.name, mesh: m.mesh, key: m.key });
    }
  return out;
}

// ── 이 명세가 도착에 요구하는 capability ────────────────
// INCL DRAFT(ai): 도착 Builder·계획 대조가 보는 명세. 클러스터 안 데이터 자원(props.inCluster)과 그리로 가는 의존성은 뺀다 →
//   도착은 지금처럼 그 워크로드를 그대로 그림 (워크로드 → 같은 워크로드). 화면·명세 검토는 뺀 것 없이 원래 명세를 본다
// TODO(human): 도착 매핑(같은 워크로드 / D7 대체물 / 관리형 / XC-1 호환 API)을 정하면 여기서 빼지 않고 Builder 가 그 종류로 그림
export const isInClusterData = (c: ComponentV2): boolean => c.kind !== "service" && c.kind !== "job" && !!(c.props as { inCluster?: unknown }).inCluster;
export function renderViewV2(spec: AppSpecV2): AppSpecV2 {
  const gone = new Set(spec.components.filter(isInClusterData).map((c) => c.id));
  if (!gone.size) return spec;
  return { ...spec, components: spec.components.filter((c) => !gone.has(c.id)),
    links: spec.links.filter((l) => !(typeof l.to === "string" && gone.has(l.to))),
    posture: { ...spec.posture, network: spec.posture.network.filter((n) => !(n.scope === "component" && gone.has(n.subject))) } };
}

export function requirementsV2(spec0: AppSpecV2): Capability[] {
  const spec = renderViewV2(spec0);
  const r = new Set<Capability>();
  const pg = spec.components.filter((c): c is Postgres => c.kind === "postgres");
  for (const c of spec.components) {
    switch (c.kind) {
      case "service": r.add(`runtime.${c.props.runtime}`); r.add("kind.service"); break;
      // DRAFT(ai): job 엔 runtime 칸이 없다 → k8s CronJob(Helm)으로 그림.
      //   JOBBUILD DRAFT(ai): 관리형 서비스가 있는 앱의 잡은 관리형 예약 잡(ECS 예약 작업·Cloud Run job, root job_json)으로 그림 → 관리형 capability
      case "job": r.add(managedServicesOf(spec).length ? "runtime.managedContainer" : "runtime.k8s"); r.add("kind.job"); break;
      case "postgres": r.add(c.props.majorVersion ? `kind.postgres.${c.props.majorVersion}` : "kind.postgres"); break;
      case "cache": r.add(`kind.cache.${c.props.engine}`); if (c.props.clusterMode) r.add("kind.cache.cluster"); break;   // TA12: 클러스터 모드는 별도 capability
      case "queue": {
        r.add("kind.queue");
        // VTA12 DRAFT(ai): 순서 보장(ordered) 큐와 DLQ 의 순서 보장이 다르면 별도 capability. SQS 는 FIFO 큐의 DLQ 도 FIFO(표준은 표준)여야 해서
        //   AWS 는 apply 에서야 실패한다 → AWS 는 이 capability 를 안 가져 계획 전에 막는다. Pub/Sub 은 DLQ 가 토픽이라 상관없음
        const dl = c.props.deadLetter?.to;
        const t = dl ? spec.components.find((x) => x.id === dl) : undefined;
        if (t?.kind === "queue" && (c.props.ordered === true) !== (t.props.ordered === true)) r.add("kind.queue.dlqMixedOrder");
        // PS-1·B-1·DM-6 DRAFT(ai): Pub/Sub 받는 쪽 기능. 지금 GCP 도착만 그림. AWS(SQS·SNS)는 같은 것이 없거나(필터·받은 메시지 보관)
        //   SNS→SQS·HTTPS 구독 렌더가 아직 없어 계획 전에 막는다 (조용히 버리지 않음)
        for (const p of [c.props, ...(c.props.subscriptions ?? [])]) {
          if (p.push) r.add("kind.queue.push");
          if (p.filter) r.add("kind.queue.filter");
          if (p.retainAcked) r.add("kind.queue.retainAcked");
        }
        if (c.props.subscriptions?.length) r.add("kind.queue.subscriptions");
        if (c.props.topicSubscriptions?.length) r.add("queue.topicSubscriptions");   // B-2 DRAFT(ai): 토픽 구독 렌더는 다음 단계
        break;
      }
      case "objectStore": r.add("kind.objectStore"); if (c.props.notifications?.length) r.add("objectStore.notifications"); break;   // B-1b DRAFT(ai)
      default: r.add(`kind.${(c as { kind: string }).kind}`);
    }
    if (c.kind === "service" || c.kind === "job") {
      for (const img of [c.props.image, ...(c.props.sidecars ?? []).filter((s) => !s.injected).map((s) => s.image), ...(c.props.initContainers ?? []).map((s) => s.image)])
        r.add(`image.${img.source}`);
    }
  }
  if (pg.length > 1) r.add("kind.postgres.multi");   // 지금 복제 코드는 DB 하나 (3.2)
  for (const l of spec.links) {
    r.add(typeof l.to === "string" ? `link.${l.intent}` : "unmapped" in l.to ? "link.unmapped" : "link.external");
    if (l.grants?.length) r.add("render.grants");    // A8: Builder 가 target/grants.ts 로 그림. 대응표 밖은 grantBlockers 가 막음
  }
  if (spec.entry) {
    r.add("entry.ingress");
    if (spec.entry.hosts.some((h) => h.tls?.mode === "passthrough")) r.add("entry.tlsPassthrough");
    // T2 DRAFT(ai): Ingress 로 못 그리는 라우팅은 경고가 아니라 막는다 (그대로 이식). HTTPRoute 렌더가 생기면 그 도착이 capability 를 가짐
    const svcOf = (to: string) => { const c = spec.components.find((x) => x.id === to); return c?.kind === "service" ? [...(c.props.endpoints ?? [])].map((e) => e.name).sort()[0] ?? to : to; };
    for (const h of spec.entry.hosts) for (const rt of h.routes) {
      // 같은 Service 를 여러 Deployment 가 받는 경우(셀렉터가 여럿을 고름)는 Service 째 옮기면 손실이 없다 → 대상 Service 가 둘 이상일 때만
      if (new Set(rt.backends.filter((b) => b.weight > 0).map((b) => svcOf(b.to))).size > 1) r.add("entry.weighted");
      if (rt.matches.some((m) => m.headers?.length || m.method)) r.add("entry.match");
    }
    // ENT-1: 사내망 전용 입구는 공개 Cloudflare 입구로 그리면 보안이 약해짐 → 내부 입구를 그리는 도착만 받음 (지금은 없음 = 막힘)
    if (spec.entry.hosts.some((h) => h.exposure === "internal")) r.add("entry.internal");
  }
  // N4: hostPath 볼륨은 도착 노드에 같은 경로가 있다는 보장이 없음 → capability 없으면 막음
  // N7: CPU·메모리(Resource) 밖 지표는 도착에 같은 지표 서버(Prometheus Adapter 등)가 있어야 함
  // N8: 클라우드 전용 파라미터(rds.*·cloudsql.*)는 그 클라우드 도착만 받음
  for (const w of workloadsOf(spec)) {
    if ((w.props.podVolumes ?? []).some((v) => v.type === "hostPath")) r.add("volume.hostPath");
    // CL-1: IR 볼륨 = 도착 PVC. 도착 클러스터에 볼륨을 만들 드라이버·기본 StorageClass 가 있어야 PVC 가 Bound (없으면 파드가 안 뜸)
    if (w.kind === "service" ? w.props.runtime === "k8s" && (w.props.volumes?.length ?? 0) > 0 : (w.props.volumes?.length ?? 0) > 0) r.add("volume.pvc");
    // NSC-1: init 컨테이너에 restartPolicy: Always = k8s 기본 사이드카. 못 받는 도착에선 끝나지 않는 init 이 돼 파드가 안 뜸 → 막음
    if ((w.props.initContainers ?? []).some((c) => c.restartPolicy === "Always")) r.add("pod.nativeSidecar");
    if (w.kind === "service" && (w.props.scale?.metrics ?? []).some((m) => m.type !== "Resource" && m.type !== "ContainerResource")) r.add("scale.customMetrics");
  }
  for (const p of pg) for (const k of Object.keys(p.props.parameters ?? {})) {
    const vendor = /^(rds|cloudsql|aurora|azure|alloydb)\./.exec(k)?.[1];
    if (vendor) r.add(`pg.param.${vendor}`);
  }
  // D6·V-1·NP-1·NS-1: k8s 모양 칸. 차트가 그리는 도착만 capability 를 가진다 (K8S_RENDER_CAPS)
  for (const w of workloadsOf(spec)) {
    if (w.kind !== "service") continue;
    if (w.props.workloadKind === "statefulset") r.add("workload.statefulset");
    if (w.props.workloadKind === "daemonset") r.add("workload.daemonset");
    for (const e of w.props.endpoints ?? []) {
      if (e.type === "Headless") r.add("endpoint.headless");
      if (e.ports.some((p) => p.nodePort !== undefined)) r.add("endpoint.nodePort");
      if (e.sessionAffinity || e.externalTrafficPolicy || e.internalTrafficPolicy || e.publishNotReadyAddresses || e.loadBalancerSourceRanges) r.add("endpoint.behaviour");
    }
  }
  if (spec.serviceAliases?.length) r.add("endpoint.externalName");
  for (const m of meshesOf(spec)) r.add(`mesh.${m.mesh}`);
  if (sourceNamespacesOf(spec).length > 1) r.add("namespace.multi");   // N9 가 여러 네임스페이스 렌더를 붙이면 그 도착이 가짐
  if (spec.posture.permissions.length) r.add("posture.permissions");   // A8: 위와 같음 (3.3)
  for (const n of spec.posture.network) {
    if (n.scope === "namespace") r.add(n.default === "allow-all" ? "posture.allowAll" : "posture.networkPolicy");
    else r.add("posture.component");
  }
  return [...r].sort();
}

// capability 밖(unsupported) + 사람이 봐야 하는 것(needsHuman). precheck(A3)가 그대로 쓴다
export function v2Blockers(spec0: AppSpecV2, caps: Capability[]): { unsupported: string[]; needsHuman: string[] } {
  const spec = renderViewV2(spec0);
  const have = new Set(caps);
  // I9: 관리형 컨테이너(ECS·Cloud Run) 렌더는 아직 없음 → 막고, 어느 서비스인지·어떻게 풀지 적는다 (모듈은 kinds/service-ecs·service-cloudrun 카탈로그만)
  // RUNTIMEMAP v2: VM 출발은 VM 도착이 기본 (재현성). VM 모듈이 없는 도착(온프레·Azure 가짜)은 막고, 컨테이너로 옮기려면 runtime 을 바꾸고 승인 (opt-in)
  const hint = (x: Capability) => x === "runtime.managedContainer"
    ? ` (서비스 ${spec.components.filter((c) => c.kind === "service" && c.props.runtime === "managedContainer").map((c) => c.id).sort().join(",")} — 명세 검토에서 runtime 을 k8s 로 바꾸면 EKS·GKE·k3s 로 옮김, 실행 방식 바뀜 승인)`
    : x === "volume.pvc"
      ? ` (서비스·잡 ${workloadsOf(spec).filter((w) => w.props.volumes?.length).map((w) => w.id).join(",")} 의 볼륨 — 도착 클러스터에 볼륨 드라이버·기본 StorageClass 가 없어 PVC 가 Pending 이 됨. EKS 는 aws-ebs-csi-driver 애드온이 env 모듈에 없음, TODO(human))`
    : x === "runtime.vm"
      ? ` (서비스 ${spec.components.filter((c) => c.kind === "service" && c.props.runtime === "vm").map((c) => c.id).sort().join(",")} — 이 도착엔 VM 모듈이 없음. 컨테이너로 옮기려면 명세 검토에서 runtime 을 k8s 로 바꿈 (실행 방식 바뀜 승인). 온프레 VM 은 TODO(human))`
      : "";
  const unsupported = requirementsV2(spec).filter((x) => !have.has(x)).map((x) => `도착 렌더 미지원: ${x}${hint(x)}`);
  if (have.has("runtime.managedContainer")) unsupported.push(...managedBlockers(spec));
  if (have.has("runtime.vm")) unsupported.push(...vmBlockers(spec));
  const needsHuman: string[] = [];
  // M-1: 도착 네임스페이스가 예약 이름이면 플랫폼이 만들·지울 수 없음
  // DECISION(team): 예약 이름(default·kube-*·플랫폼 구역) 출발은 계획에서 막고, 사람이 명세 검토에서 도착 네임스페이스 이름을 정한다 (11/3 19:19Z 결정)
  for (const ns of sourceNamespacesOf(spec))
    if (RESERVED_NAMESPACES.test(ns)) unsupported.push(`도착 렌더 미지원: 네임스페이스 ${ns} 는 도착 클러스터의 기본·플랫폼 구역 → 명세 검토에서 도착 네임스페이스 이름을 정함`);
  // NS-1: 출발은 pod-security 를 적었는데 도착 바닥(온프레 Kyverno baseline)이 다를 수 있음 → 알림
  for (const n of spec.namespaces ?? []) {
    const enf = n.labels?.["pod-security.kubernetes.io/enforce"];
    if (enf === "privileged") needsHuman.push(`네임스페이스 ${n.name}: 출발 파드 보안 수준 privileged → 도착 클러스터 바닥 정책(온프레 baseline)이 더 엄격하면 파드가 막힐 수 있음`);
  }
  for (const c of spec.components) {
    if (c.kind === "postgres") {
      if (c.props.majorVersion === null) unsupported.push(`도착 렌더 미지원: postgres ${c.id} majorVersion 모름`);
      if (c.props.storageGb === null) unsupported.push(`도착 렌더 미지원: postgres ${c.id} storageGb 모름`);
    }
    if (c.kind === "service" || c.kind === "job") {
      for (const img of [c.props.image, ...(c.props.sidecars ?? []).filter((s) => !s.injected).map((s) => s.image), ...(c.props.initContainers ?? []).map((s) => s.image)])
        if (img.source === "registry" && !img.digest) unsupported.push(`도착 렌더 미지원: ${c.id} 이미지 digest 없음 (${img.repository})`);
      // G-1: GPU·hugepages 같은 자원 요청 → 도착 노드풀에 그 자원이 있어야 함 (없이 그리면 파드가 안 뜨거나 GPU 없이 돎)
      const res = [c.props.resources, ...(c.props.sidecars ?? []).filter((s) => !s.injected).map((s) => s.resources), ...(c.props.initContainers ?? []).map((s) => s.resources)];
      const ext = [...new Set(res.flatMap((r) => [...Object.keys(r?.request?.extended ?? {}), ...Object.keys(r?.limit?.extended ?? {})]))].sort();
      for (const n of ext) {
        const cap = extendedCap(n);
        if (cap && !have.has(cap)) unsupported.push(`도착 렌더 미지원: ${c.id} 자원 ${n} 을 주는 노드풀이 이 도착에 없음 (${cap})`);
      }
      // A-1: 출발 노드 CPU 종류 중 하나라도 도착 노드풀에 있어야 함 (단일 arch 이미지가 다른 종류 노드에 뜨면 exec format error)
      const arch = c.props.nodeArch ?? [];
      if (arch.length && !arch.some((a) => have.has(`arch.${a}`)))
        unsupported.push(`도착 렌더 미지원: ${c.id} 출발 노드 CPU 종류 ${arch.join(",")} 가 도착 노드풀(${[...have].filter((x) => x.startsWith("arch.")).map((x) => x.slice(5)).sort().join(",") || "없음"})에 없음`);
    }
    // CA-1: 출발 캐시 AUTH 여부를 못 읽었으면 켬·끔 어느 쪽으로도 몰지 않는다 (켜면 AUTH 안 보내던 앱이, 끄면 보내던 앱이 깨짐)
    if (c.kind === "cache" && c.props.auth === null) needsHuman.push(`${c.id}: 출발 캐시 AUTH 사용 여부를 못 읽음 → 도착에서 켤지 사람이 정함 (명세 검토에서 auth 를 true·false 로)`);
  }
  // T1·SC-1: 비밀 표. 관리형·VM 도착은 앱이 비밀 저장소 값을 ESO 없이 바로 읽음 → base64 로 옮긴 바이너리 키를 그대로 받게 되고, 짝 키 바꿔 끼우기도 아직 없음
  if (have.has("runtime.managedContainer") || have.has("runtime.vm")) {
    const direct = new Set([...managedServicesOf(spec), ...managedJobsOf(spec), ...vmServicesOf(spec)].flatMap((w) => secretNamesOf(w)));
    for (const sec of spec.secrets ?? []) {
      if (!direct.has(sec.name)) continue;
      for (const k of sec.keys) {
        if (k.binary) unsupported.push(`도착 렌더 미지원: 비밀 ${sec.name}.${k.key} 은 바이너리 → 관리형·VM 도착은 앱이 base64 글자를 그대로 받음`);
      }
    }
  }
  // TA12: 데이터 자원. DLQ 는 같은 명세 안의 다른 queue(model=queue)여야 하고, 대상은 또 DLQ 를 갖지 않는다 (루트·모듈 검증과 같은 규칙 — 계획 전에 거부)
  for (const c of spec.components) {
    if (c.kind === "queue" && c.props.deadLetter) {
      const to = c.props.deadLetter.to;
      if (to === undefined) needsHuman.push(`${c.id}: 죽은 편지 큐(DLQ)를 출발에서 찾지 못함 → 도착에 DLQ 를 만들지 사람이 정함`);
      else {
        const t = spec.components.find((x) => x.id === to);
        if (!t || t.kind !== "queue" || t.id === c.id) unsupported.push(`도착 렌더 미지원: ${c.id} DLQ 대상 ${to} 이(가) 같은 명세의 다른 queue 가 아님`);
        else if (t.props.model !== "queue") unsupported.push(`도착 렌더 미지원: ${c.id} DLQ 대상 ${to} 은 topic 이라 DLQ 가 될 수 없음`);
        else if (t.props.deadLetter?.to !== undefined) unsupported.push(`도착 렌더 미지원: ${c.id} DLQ 대상 ${to} 이(가) 또 DLQ 를 가짐 (한 단계만)`);
      }
    }
    // PS-1: 구독 목록 안 DLQ 는 도착 대상 토픽을 잇는 길이 아직 없음 (루트 queue_dl 은 큐 단위)
    if (c.kind === "queue") for (const s of c.props.subscriptions ?? [])
      if (s.deadLetter) unsupported.push(`도착 렌더 미지원: ${c.id} 구독 ${s.name} 의 DLQ (구독이 여럿인 토픽의 DLQ 는 아직 못 그림)`);
    // B-1 DRAFT(ai): push 구독 주소가 이 앱 입구(entry 호스트)면 그대로 둔다 (입구 이름이 같아 컷오버 때 같이 넘어감, H-1 주인은 하나).
    //   입구가 아닌 주소(출발 Cloud Run URL·IP 등)면 도착에서도 출발로 보냄 → 사람이 도착 주소를 정함
    if (c.kind === "queue") {
      const hosts = new Set((spec.entry?.hosts ?? []).flatMap((h) => h.hostnames.map((n) => n.toLowerCase())));
      for (const [who, p] of [[c.id, c.props] as const, ...(c.props.subscriptions ?? []).map((s) => [`${c.id} 구독 ${s.name}`, s] as const)]) {
        if (!p.push) continue;
        let host = "";
        try { host = new URL(p.push.endpoint).hostname.toLowerCase(); } catch { /* 주소 아님 */ }
        if (!hosts.has(host)) needsHuman.push(`${who}: push 주소 ${p.push.endpoint} 는 이 앱 입구가 아님 → 도착에서도 그 주소로 보냄. 도착 주소를 사람이 정함`);
      }
    }
    // DM-2: 출발 버전 관리 설정을 못 읽음 → 도착 모듈은 건드리지 않음(상품 기본 = 끔). 조용히 끈 채 만들지 않게 사람에게 묻는다
    if (c.kind === "objectStore" && c.props.versioning === null) needsHuman.push(`${c.id}: 출발 버킷 버전 관리 설정을 못 읽음 → 켤지 사람이 정함 (명세 검토에서 값을 넣으면 통과)`);
    // DM-4: Cloud SQL Auth Proxy 사이드카는 출발 연결 이름을 가리킨 채로 옮겨짐 → 도착 연결 방식을 사람이 정함
    if ((c.kind === "service" || c.kind === "job") && (c.props.sidecars ?? []).some((s) => /(^|\/)(cloud-sql-proxy|cloudsql-proxy|gce-proxy)$/.test(s.image.repository)))
      needsHuman.push(`${c.id}: Cloud SQL Auth Proxy 사이드카가 출발 인스턴스를 가리킴 → 도착 연결 방식(프록시 유지·사설 주소)을 사람이 정함`);
    if ((c.kind === "service" || c.kind === "job") && c.props.secretSources?.length)
      needsHuman.push(`${c.id}: 출발 비밀이 외부 저장소(${[...new Set(c.props.secretSources.map((x) => x.via === "eso" ? `ESO ${x.store ?? ""}${x.provider ? `(${x.provider})` : ""}` : `Vault Agent${x.role ? ` role ${x.role}` : ""}`))].sort().join(", ")})에서 옴 → 도착 저장소 연결·값 복사를 사람이 정함`);
    if (c.kind === "objectStore" && c.props.public === null) needsHuman.push(`${c.id}: 버킷 공개 여부를 못 읽음 → 도착은 비공개로 만들고 사람이 정함`);
    // B-2: 출발이 공개 버킷이면 도착 모듈도 공개로 연다 (막지 않음). 사람 확인은 checkV2 의 public_bucket 승인 줄
    // VTA12fix DRAFT(ai): 출발 캐시에 AUTH 가 켜져 있는데 도착이 AUTH 를 못 옮기면(capability kind.cache.auth 없음 = 지금 AWS) 조용히 AUTH 없이
    //   그리지 않고 사람에게 묻는다. 명세 검토에서 auth 를 false 로 바꾸면(= AUTH 없이 네트워크로만 막는 것에 동의) 통과.
    //   AWS 에 auth token 을 만들지(state 에 남는 비밀)는 infra/modules/aws/kinds/cache TODO(human) — Claude 가 정하지 않음
    if (c.kind === "cache" && c.props.auth === true && !have.has("kind.cache.auth"))
      needsHuman.push(`${c.id}: 출발 캐시는 AUTH 를 씀 → 이 도착은 AUTH 를 아직 못 옮겨 네트워크(보안 그룹)로만 막힘. 그대로 갈지(auth=false) 사람이 정함`);
  }
  // AN-1: 출발 입구의 인증·접근 제한 annotation 은 도착 입구(Cloudflare·차트 Ingress)가 아직 그 뜻을 못 그린다 → 조용히 열지 않고 사람이 정함
  for (const h of spec.entry?.hosts ?? []) {
    const keys = Object.keys(h.annotations ?? {}).filter((k) => ACCESS_ANNOTATION.test(k)).sort();
    if (keys.length) needsHuman.push(`입구 ${h.hostnames[0]}: 출발은 인증·접근 제한(${keys.join(",")})을 걸어 둠 → 도착 입구가 아직 못 그려 그대로 두면 열림. 도착 입구에서 같은 제한을 걸지 사람이 정함`);
  }
  // AN-1: 출발 입구의 인증·접근 제한 annotation 은 도착 입구(Cloudflare·차트 Ingress)가 아직 그 뜻을 못 그린다 → 조용히 열지 않고 사람이 정함
  for (const h of spec.entry?.hosts ?? []) {
    const keys = Object.keys(h.annotations ?? {}).filter((k) => ACCESS_ANNOTATION.test(k)).sort();
    if (keys.length) needsHuman.push(`입구 ${h.hostnames[0]}: 출발은 인증·접근 제한(${keys.join(",")})을 걸어 둠 → 도착 입구가 아직 못 그려 그대로 두면 열림. 도착 입구에서 같은 제한을 걸지 사람이 정함`);
  }
  // N3: binaryData 는 값을 안 읽어 도착에 못 만듦
  for (const w of workloadsOf(spec)) for (const c of w.props.configs ?? [])
    if (c.binaryKeys?.length) unsupported.push(`도착 렌더 미지원: ${w.id} ConfigMap ${c.name} 의 binaryData(${c.binaryKeys.join(",")}) 는 값을 안 옮김`);
  // T3: 클러스터 단위 권한·사용자 ClusterRole 은 도착 클러스터 관리자가 정함
  for (const b of spec.rbac?.clusterBindings ?? []) needsHuman.push(`ClusterRoleBinding ${b.name}(${b.roleRef.kind} ${b.roleRef.name}) → 도착 클러스터 단위 권한은 자동으로 안 만듦. 사람이 만들거나 명세에서 뺌`);
  for (const b of spec.rbac?.roleBindings ?? [])
    if (b.roleRef.kind === "ClusterRole" && !["view", "edit", "admin", "cluster-admin"].includes(b.roleRef.name))
      needsHuman.push(`RoleBinding ${b.name} 가 사용자 ClusterRole ${b.roleRef.name} 을 가리킴 → 도착 클러스터에 같은 ClusterRole 이 있어야 함`);
  for (const n of spec.posture.network) {
    if (n.scope !== "component") continue;
    if (n.ingress === "unknown") { needsHuman.push(`${n.subject}: 출발 방화벽을 못 읽음 → 의존성만 열지 사람이 정함`); continue; }
    const other = n.ingress.filter((i) => !isCidr(i.from)).map((i) => i.from);
    if (other.length) needsHuman.push(`${n.subject}: 출발 방화벽 원본 ${other.sort().join(",")} 은 도착에 그대로 못 옮김`);
    if (n.public === true && !n.ingress.some((i) => isCidr(i.from)))
      needsHuman.push(`${n.subject}: 출발은 공개였는데 허용 주소(CIDR)가 없음 → 도착은 비공개로 두고 사람이 정함`);
  }
  return { unsupported: [...new Set(unsupported)].sort(), needsHuman: needsHuman.sort() };
}

// T1 DRAFT(ai): 관리형·VM 도착은 짝 키(도착 DB·캐시 비밀번호로 바꿔 끼우기)를 아직 안 그림 → 막지 않고 경고 (ECS·VM 은 k8s 다음 순서, 팀 회의 11/3).
//   TODO(human): 관리형·VM Builder 가 짝 키를 도착 비밀번호 저장소 이름으로 바꿔 넣을지, 그 전까지 막을지
export function secretPairWarnings(spec: AppSpecV2): string[] {
  const direct = new Set([...managedServicesOf(spec), ...managedJobsOf(spec), ...vmServicesOf(spec)].flatMap((w) => secretNamesOf(w)));
  return (spec.secrets ?? []).filter((s) => direct.has(s.name)).flatMap((s) => s.keys.filter((k) => k.pairedWith)
    .map((k) => `비밀 ${s.name}.${k.key} 는 ${k.pairedWith!.component} 비밀번호인데 관리형·VM 도착은 아직 도착 비밀번호로 안 바꿔 끼움 → 출발 값이 옮겨짐`)).sort();
}

// TA13: 관리형 컨테이너(ECS·Cloud Run) 도착이 못 그리는 것. capability 가 있는 도착(aws·gcp)에서만 본다
//   DRAFT(ai): 한 명세 안에 k8s 워크로드와 섞으면 막는다 (신원·비밀·Helm 값이 두 갈래가 됨). 칸 대응은 kinds/service-* 가 받는 것만
export const managedServicesOf = (spec: AppSpecV2): Service[] =>
  workloadsOf(spec).filter((w): w is Service => w.kind === "service" && w.props.runtime === "managedContainer");
// JOBBUILD DRAFT(ai): 관리형 서비스가 있는 앱의 잡 = 관리형 예약 잡 (k8s CronJob 이 아니라 root job_json → kinds/job).
//   이유: IR job 엔 runtime 칸이 없고, 관리형 앱엔 k8s 클러스터·Helm 값이 없어 CronJob 으로 그릴 곳이 없다. 같은 앱의 서비스와 같은 실행 방식이 재현성 기본.
//   잡만 있는 앱(관리형 서비스 0)은 지금처럼 k8s CronJob — 관리형인지 알 근거가 없음 (TODO(human): IR job 에 runtime 칸을 둘지)
export const managedJobsOf = (spec: AppSpecV2): Job[] =>
  managedServicesOf(spec).length ? workloadsOf(spec).filter((w): w is Job => w.kind === "job") : [];
/** 루트 job_json 검사와 같은 cron 규칙 (계획 전에 막음): 5필드, 요일 칸 간격(/) 금지, 날짜·요일 칸 동시 지정 금지 */
export function managedCronProblem(schedule: string): string | null {
  const f = schedule.trim().split(/\s+/);
  if (f.length !== 5) return "schedule 은 cron 5필드여야 함";
  if (f[4]!.includes("/")) return "요일 칸의 간격(/) 은 아직 못 옮김";
  if (!["*", "?"].includes(f[2]!) && !["*", "?"].includes(f[4]!)) return "날짜 칸과 요일 칸을 둘 다 정한 schedule 은 못 옮김";
  return null;
}
/** 관리형 잡 env 한 줄이 job_json 으로 갈 수 있나: 값 · fromLink · 자리표시 하나뿐인 template (루트가 한 덩어리 자리표시만 풂) */
export const managedJobEnvOk = (e: EnvVarV2): boolean =>
  "value" in e || "fromLink" in e || ("template" in e && new RegExp(`^${TEMPLATE.source}$`).test(e.template));
export function managedBlockers(spec: AppSpecV2): string[] {
  const m = managedServicesOf(spec);
  if (!m.length) return [];
  const out: string[] = [];
  // JOBBUILD: 잡은 관리형 예약 잡으로 그리므로 "섞임"이 아니다 (아래에서 잡 칸만 따로 봄)
  const k8s = workloadsOf(spec).filter((w) => !(w.kind === "service" && w.props.runtime === "managedContainer") && w.kind !== "job").map((w) => w.id);
  if (k8s.length) out.push(`도착 렌더 미지원: 관리형 서비스(${m.map((x) => x.id).join(",")})와 k8s 워크로드(${k8s.join(",")})를 한 명세에 섞음 — 명세 검토에서 runtime 을 한쪽으로 맞춤`);
  for (const w of m) {
    const p = w.props;
    const bad: string[] = [];
    if ((p.sidecars ?? []).some((s) => !s.injected)) bad.push("sidecars");
    if (p.initContainers?.length) bad.push("initContainers");
    if (p.volumes?.length) bad.push("volumes");
    if (p.configs?.length) bad.push("configs");
    if (p.secretMounts?.length) bad.push("secretMounts");
    if (p.envFrom?.length) bad.push("envFrom");
    if (p.env.some((e) => "fromConfig" in e || "fromField" in e || "fromResource" in e)) bad.push("env(fromConfig·fromField·fromResource)");
    if ((p.ports?.length ?? 0) > 1) bad.push("ports 2개 이상");
    if (bad.length) out.push(`도착 렌더 미지원: ${w.id} 관리형 서비스에 ${bad.join("·")} 못 그림`);
  }
  // JOBBUILD: 관리형 예약 잡이 못 그리는 칸 (kinds/job 이 받는 것 = JobTfVars). 비밀 칸이 없음(모듈 TODO(human)) → fromSecret 은 막음
  for (const j of managedJobsOf(spec)) {
    const p = j.props;
    const bad: string[] = [];
    if (p.sidecars?.length) bad.push("sidecars");
    if (p.initContainers?.length) bad.push("initContainers");
    if (p.volumes?.length) bad.push("volumes");
    if (p.configs?.length) bad.push("configs");
    if (p.secretMounts?.length) bad.push("secretMounts");
    if (p.envFrom?.length) bad.push("envFrom");
    if (p.env.some((e) => "fromSecret" in e)) bad.push("env(fromSecret: 관리형 잡 모듈에 비밀 칸 없음)");
    if (p.env.some((e) => !("fromSecret" in e) && !managedJobEnvOk(e))) bad.push("env(fromConfig·fromField·fromResource·조각 여러 개 template)");
    const cron = managedCronProblem(p.schedule);
    if (cron) bad.push(`schedule(${cron})`);
    if (bad.length) out.push(`도착 렌더 미지원: ${j.id} 관리형 예약 잡에 ${bad.join("·")} 못 그림`);
  }
  // A8 권한 대응(grants.ts)은 k8s 신원 모듈에 붙는다 → 관리형 역할엔 아직 없음
  if (spec.links.some((l) => l.grants?.length && [...m, ...managedJobsOf(spec)].some((x) => x.id === l.from)) || spec.posture.permissions.length)
    out.push("도착 렌더 미지원: 관리형 서비스의 권한 대응(grants·posture.permissions)은 아직 없음");
  return out;
}

// RUNTIMEMAP v2: VM(EC2·GCE) 도착이 못 그리는 것. capability(runtime.vm)가 있는 도착(aws·gcp)에서만 본다
//   DRAFT(ai): 한 명세 안에서 VM 서비스는 다른 실행 방식(k8s·관리형·잡)과 섞지 않는다 (신원·비밀·Helm 값이 갈라짐). 칸 대응은 kinds/vm 이 받는 것만
//   VM 주소는 apply 뒤에야 알아서 다른 서비스를 가리키는 env·링크는 막는다 (TODO(human): 사설 DNS 이름 규칙)
export const vmServicesOf = (spec: AppSpecV2): Service[] =>
  workloadsOf(spec).filter((w): w is Service => w.kind === "service" && w.props.runtime === "vm");
export function vmBlockers(spec: AppSpecV2): string[] {
  const m = vmServicesOf(spec);
  if (!m.length) return [];
  const out: string[] = [];
  const other = workloadsOf(spec).filter((w) => !(w.kind === "service" && w.props.runtime === "vm")).map((w) => w.id);
  if (other.length) out.push(`도착 렌더 미지원: VM 서비스(${m.map((x) => x.id).join(",")})와 다른 실행 방식 워크로드(${other.join(",")})를 한 명세에 섞음 — 명세 검토에서 runtime 을 한쪽으로 맞춤`);
  const ids = new Set(spec.components.filter((c) => c.kind === "service" || c.kind === "job").map((c) => c.id));
  for (const w of m) {
    const p = w.props;
    const bad: string[] = [];
    if ((p.sidecars ?? []).some((s) => !s.injected)) bad.push("sidecars");
    if (p.initContainers?.length) bad.push("initContainers");
    if (p.volumes?.length) bad.push("volumes");
    if (p.configs?.length) bad.push("configs");
    if (p.secretMounts?.length) bad.push("secretMounts");
    if (p.envFrom?.length) bad.push("envFrom");
    if (p.env.some((e) => "fromConfig" in e || "fromField" in e || "fromResource" in e)) bad.push("env(fromConfig·fromField·fromResource)");
    if ((p.ports?.length ?? 0) > 1) bad.push("ports 2개 이상");
    const toService = p.env.some((e) => ("fromLink" in e && ids.has(e.fromLink.to)) || ("template" in e && [...e.template.matchAll(TEMPLATE)].some((x) => ids.has(x[1]!))));
    if (toService) bad.push("다른 서비스 주소를 가리키는 env");
    if (bad.length) out.push(`도착 렌더 미지원: ${w.id} VM 서비스에 ${bad.join("·")} 못 그림`);
  }
  if (spec.links.some((l) => typeof l.to === "string" && ids.has(l.to) && m.some((x) => x.id === l.from)))
    out.push("도착 렌더 미지원: VM 서비스 사이 링크는 아직 (VM 주소가 apply 뒤에 정해짐, TODO(human))");
  // A8 권한 대응(grants.ts)은 k8s 신원 모듈에 붙는다 → VM 역할엔 아직 없음
  if (spec.links.some((l) => l.grants?.length && m.some((x) => x.id === l.from)) || spec.posture.permissions.length)
    out.push("도착 렌더 미지원: VM 서비스의 권한 대응(grants·posture.permissions)은 아직 없음");
  return out;
}

export function assertRenderable(spec: AppSpecV2, caps: Capability[]): void {
  const { unsupported } = v2Blockers(spec, caps);
  if (unsupported.length) throw new AdapterError(UNSUPPORTED_V2, unsupported.join("; "));
}

const isCidr = (s: string) => /^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/.test(s);

// ── 이름 ───────────────────────────────────────────────
// 이름 함수(dbInstanceName 등)는 app.name 만 본다 → 같은 해시가 나오게 그대로 넘긴다
export const asV1Name = (spec: AppSpecV2) => ({ app: { name: spec.app.name } });

// 신원 = 출발 serviceAccount 하나. 같은 SA 를 쓰던 서비스·잡은 도착에서도 한 신원을 같이 쓴다 (재현성)
// id = 그 SA 를 쓰는 워크로드 id 중 가장 앞선 것 (for_each 키가 IR id 여야 해서)
export interface IdentityPlan { id: string; serviceAccount: string; workloads: string[] }
export function identitiesOf(spec: AppSpecV2): IdentityPlan[] {
  const by = new Map<string, string[]>();
  for (const w of workloadsOf(spec)) by.set(w.props.serviceAccount, [...(by.get(w.props.serviceAccount) ?? []), w.id]);
  return [...by.entries()].map(([sa, ids]) => ({ id: [...ids].sort()[0]!, serviceAccount: sa, workloads: [...ids].sort() }))
    .sort((a, b) => a.id.localeCompare(b.id));
}
export const identityOf = (spec: AppSpecV2, workloadId: string) =>
  identitiesOf(spec).find((i) => i.workloads.includes(workloadId))!;

// 실행 역할·SA 이름. IR id 를 그대로 쓰면 길이·접두어 규칙(app-, aws 64 / gcp 30)에 걸림 → boundedName
// DRAFT(ai): id 가 앱 이름과 같으면 v1 과 같은 seed → v1 이름 그대로 (upconvert 판이 v1 과 같은 역할 이름)
export function identityName(spec: AppSpecV2, id: string, t: Target, max: number): string {
  const seed = [...(id === spec.app.name ? [nameSeed(t), spec.app.name] : [nameSeed(t), spec.app.name, id]), ...migrationSeed(t)];
  return boundedName({ prefix: "app-", app: id, seed, max });
}

export const workloadsOf = (spec: AppSpecV2): WorkloadV2[] =>
  spec.components.filter((c): c is WorkloadV2 => c.kind === "service" || c.kind === "job").sort((a, b) => a.id.localeCompare(b.id));
export const postgresOf = (spec: AppSpecV2): Postgres[] =>
  spec.components.filter((c): c is Postgres => c.kind === "postgres").sort((a, b) => a.id.localeCompare(b.id));

// 워크로드가 쓰는 비밀 이름 (env fromSecret · envFrom secret · secretMounts). 정렬·중복 없음
export function secretNamesOf(w: WorkloadV2): string[] {
  const s = new Set<string>();
  const fromEnv = (env: EnvVarV2[]) => env.forEach((e) => { if ("fromSecret" in e) s.add(e.fromSecret.secret); });
  fromEnv(w.props.env);
  for (const c of [...(w.props.sidecars ?? []), ...(w.props.initContainers ?? [])]) fromEnv(c.env);
  for (const f of w.props.envFrom ?? []) if ("secret" in f) s.add(f.secret);
  for (const m of w.props.secretMounts ?? []) s.add(m.secret);
  return [...s].sort();
}

// connect 의존성으로 이 postgres 에 붙는 신원 id (루트가 이 신원에 DB 비밀 읽기를 준다)
export function connectIdentities(spec: AppSpecV2, toId: string): string[] {
  const ids = spec.links.filter((l) => l.to === toId && l.intent === "connect").map((l) => identityOf(spec, l.from)?.id).filter((x): x is string => !!x);
  return [...new Set(ids)].sort();
}

// 출발 DB 방화벽(mirror) 중 CIDR 만 도착 peer 로. 나머지(SG id 등)는 v2Blockers.needsHuman
export function postureOfComponent(spec: AppSpecV2, id: string): { public: boolean; cidrs: string[] } {
  const n = spec.posture.network.find((x) => x.scope === "component" && x.subject === id);
  if (!n || n.scope !== "component" || n.ingress === "unknown") return { public: false, cidrs: [] };
  const cidrs = [...new Set(n.ingress.map((i) => i.from).filter(isCidr))].sort();
  // 공개였어도 허용 주소가 없으면 공개로 열지 않는다 (사람이 정함)
  return { public: n.public === true && cidrs.length > 0, cidrs };
}

// ── 모듈 참조 ──────────────────────────────────────────
// STUB: root·kinds 지문은 TA2 가 module-digest MODULES 에 넣으면 생김. 그전엔 Target.moduleSha 또는 "content-pending"
export const refV2 = (key: string, t: Target): ModuleRef =>
  ({ path: `infra/modules/${key}`, gitSha: t.moduleSha ?? (MODULE_DIGEST as Record<string, string>)[key] ?? "content-pending" });

// 항목을 계약(tf-kinds.ts)으로 검사해서 *_json 문자열로. 정렬은 부르는 쪽이 id 순으로 넘긴다
export function kindJson<K extends keyof typeof TF_KIND_VARS>(kind: K, items: unknown[]): string {
  return JSON.stringify(items.map((x) => TF_KIND_VARS[kind].parse(x)));
}

export function instancesOf(provider: "aws" | "gcp" | "onprem", rows: Array<{ kind: ModuleInstance["kind"]; id: string }>): ModuleInstance[] {
  // TA13: service 는 프로바이더마다 모듈이 다름 (ECS · Cloud Run)
  const dir: Record<string, string> = { objectStore: "object-store", service: provider === "gcp" ? "service-cloudrun" : "service-ecs" };
  return rows.map((r) => ({ kind: r.kind, id: r.id, module: `${provider}/kinds/${dir[r.kind] ?? r.kind}` }))
    .sort((a, b) => a.module.localeCompare(b.module) || a.id.localeCompare(b.id));
}

// ── 의존성 출력 값 ─────────────────────────────────────
// 서비스끼리 주소 = 도착 k8s Service DNS (순수 계산). 데이터 리소스 = Terraform link_outputs 자리표시 또는 Builder 가 아는 값
export interface LinkCtx {
  namespace: string;
  out: TfOutputs;
  // 클라우드 Builder 는 비움 → <tf-output:link.<id>.<출력>>. 온프레는 CNPG 주소를 직접 계산
  local?: (c: ComponentV2, output: string) => string | undefined;
}
// G3-5: endpoint(부른 Service 이름)가 있으면 그 Service 의 이름·첫 포트. 없으면 예전처럼 이름순 첫 endpoint
export function serviceAddress(c: Service, ns: string, endpoint?: string): { host: string; port: number | null } {
  const eps = c.props.endpoints ?? [];
  const ep = (endpoint !== undefined ? eps.find((e) => e.name === endpoint) : undefined) ?? [...eps].sort((a, b) => a.name.localeCompare(b.name))[0];
  if (endpoint !== undefined && ep?.name !== endpoint) throw new AdapterError(LINK_OUTPUT_UNKNOWN, `${c.id} 에 Service ${endpoint} 없음`);
  const port = ep?.ports[0]?.port ?? c.props.ports?.[0]?.port ?? null;
  return { host: `${ep?.name ?? c.id}.${ns}.svc`, port };
}
export function linkTarget(spec: AppSpecV2, to: string, output: string): ComponentV2 {
  const c = spec.components.find((x) => x.id === to);
  if (!c) throw new AdapterError(LINK_OUTPUT_UNKNOWN, `의존성 대상 없음: ${to}`);
  const allowed = (LINK_OUTPUTS as Record<string, readonly string[]>)[c.kind] ?? [];
  if (!allowed.includes(output)) throw new AdapterError(LINK_OUTPUT_UNKNOWN, `${c.kind} 에 없는 출력: ${to}.${output}`);
  return c;
}
// SUB-1: fromLink.subscription 이 있으면 그 출발 구독의 도착 이름 = 루트 출력 link.<id>.sub.<출발 구독 이름> (gcp queue 모듈 link 출력)
export const subOutput = (output: string, subscription?: string) => (subscription ? `sub.${subscription}` : output);
export function linkValue(spec: AppSpecV2, to: string, output: string, ctx: LinkCtx, endpoint?: string, subscription?: string): string {
  const c = linkTarget(spec, to, output);
  if (subscription) return fromOut(ctx.out, `link.${to}.${subOutput(output, subscription)}`);
  if (c.kind === "service") {
    const a = serviceAddress(c, ctx.namespace, endpoint);
    if (output === "host") return a.host;
    if (output === "port") return a.port === null ? "" : String(a.port);
    // DRAFT(ai): url = http://<host>[:port] (80 이면 포트 생략)
    return a.port === null || a.port === 80 ? `http://${a.host}` : `http://${a.host}:${a.port}`;
  }
  return ctx.local?.(c, output) ?? fromOut(ctx.out, `link.${to}.${output}`);
}
// G3-5: 그룹 1 = id, 2 = 출력, 3 = 부른 Service 이름(선택). 계약 쪽 정의를 그대로 쓴다
export const TEMPLATE = LINK_TEMPLATE;
export const renderTemplate = (spec: AppSpecV2, tpl: string, ctx: LinkCtx) =>
  tpl.replace(TEMPLATE, (_m, id: string, o: string, ep: string | undefined) => linkValue(spec, id, o, ctx, ep));

// IR env 한 줄 → k8s env 한 줄. 순서는 IR 그대로($(VAR) 참조 순서가 뜻을 가짐)
export function k8sEnv(spec: AppSpecV2, e: EnvVarV2, ctx: LinkCtx): Record<string, unknown> {
  if ("value" in e) return { name: e.name, value: e.value };
  if ("template" in e) return { name: e.name, value: renderTemplate(spec, e.template, ctx) };
  if ("fromLink" in e) return { name: e.name, value: linkValue(spec, e.fromLink.to, e.fromLink.output, ctx, e.fromLink.endpoint, e.fromLink.subscription) };
  // EV-1: optional·containerName·divisor 는 있을 때만 그대로
  const opt = (o: { optional?: boolean }) => (o.optional !== undefined ? { optional: o.optional } : {});
  if ("fromSecret" in e) return { name: e.name, valueFrom: { secretKeyRef: { name: e.fromSecret.secret, key: e.fromSecret.key, ...opt(e.fromSecret) } } };
  if ("fromConfig" in e) return { name: e.name, valueFrom: { configMapKeyRef: { name: e.fromConfig.config, key: e.fromConfig.key, ...opt(e.fromConfig) } } };
  if ("fromField" in e) return { name: e.name, valueFrom: { fieldRef: { fieldPath: e.fromField } } };
  return { name: e.name, valueFrom: { resourceFieldRef: { resource: e.fromResource,
    ...(e.containerName ? { containerName: e.containerName } : {}), ...(e.divisor ? { divisor: e.divisor } : {}) } } };
}

// ── k8s 값 조각 ────────────────────────────────────────
type Amount = { cpuMilli: number | null; memMiB: number | null; extended?: Record<string, string> } | undefined;
const qty = (a: Amount) => {
  const o: Record<string, string> = {};
  if (a?.cpuMilli != null) o.cpu = `${a.cpuMilli}m`;
  if (a?.memMiB != null) o.memory = `${a.memMiB}Mi`;
  // G-1: 확장 자원은 이름·수량 글자 그대로 (GPU 처럼 도착 노드풀이 있어야 하는 것은 v2Blockers 가 먼저 막음)
  for (const [k, v] of Object.entries(a?.extended ?? {}).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))) o[k] = v;
  return Object.keys(o).length ? o : undefined;
};
// 없는 값은 키 자체를 안 둔다 (requests·limits 지어내지 않음)
export function k8sResources(r: { request?: Amount; limit?: Amount }): Record<string, unknown> | undefined {
  const o: Record<string, unknown> = {};
  const req = qty(r.request), lim = qty(r.limit);
  if (req) o.requests = req;
  if (lim) o.limits = lim;
  return Object.keys(o).length ? o : undefined;
}
// undefined 칸은 지운다 (차트 `with` 가 없는 키를 안 그림. JSON 지문도 키가 안 남음)
export const compact = <T extends Record<string, unknown>>(o: T): T =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
