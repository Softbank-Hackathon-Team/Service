import { z } from "zod";
import { BuildPlan } from "./build.js";
import { SecuritySpecV2, SourceDbFacts } from "./portability.js";
import { SPEC_LIMITS as L } from "./spec-limits.js";

// DRAFT(ai): 공통 명세(IR) v2. 리소스(components) + 의존성(links) + 라우팅(entry) + 보안 기준선(posture).
//   설계 20번 4장 스케치 + 24번 I1 + 3.5장 R1~R3. 이름·상한·종류 목록은 팀 검토 대상.
//   규칙: Zod 는 모양만(transform·preprocess·refine·default 안 씀 → toJSONSchema 가 그대로 뽑힘).
//   의미 검증(참조·중복·의도·벤더 주소)은 전부 spec-v2-check.ts 의 checkV2.
//   없는 값은 비우거나 null. 기본값을 지어내지 않는다(재현성).
//   v1(spec.ts) 은 안 건드린다. 이름이 겹치지 않게 일반 이름에는 V2 를 붙인다.

// ── 공통 조각 ─────────────────────────────────────────
// id: 글자로 시작, 소문자·숫자·하이픈, 40자 이하 (DNS 라벨에 넣을 수 있게). G3c-6: 끝은 하이픈이 아님 (DNS 라벨 규칙, 가져오기 slug 와 같음)
const Id = z.string().regex(/^[a-z](?:[a-z0-9-]{0,38}[a-z0-9])?$/);
const Port = z.number().int().min(1).max(65535);
const EnvName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_.-]*$/);
const Str = z.record(z.string(), z.string());
// DRAFT(ai): 가져오기는 항상 mirror. narrowed 는 사람이 권장안을 켰을 때만. 기본값을 안 두므로 매번 적는다
const Mode = z.enum(["mirror", "narrowed"]);
const Protocol = z.enum(["TCP", "UDP", "SCTP"]);

// ── 이미지 ────────────────────────────────────────────
// registry = 출발에서 digest 를 읽음. build = 이미지 없음(VM·소스) → BuildPlan 으로 도착에서 만듦.
// digest 모양 검사는 checkV2 (source=registry 인데 sha256 아님 → 오류). 레지스트리 호스트는 도착에서 다시 정한다
export const ImageV2 = z.object({
  source: z.enum(["registry", "build"]),
  repository: z.string(),
  digest: z.string().nullable(),
  build: BuildPlan.optional(),
}).strict();
export type ImageV2 = z.infer<typeof ImageV2>;

// 자원: 출발에 적힌 그대로. 없으면 null. 상품 단계로 올리지 않는다
// G-1 DRAFT(ai): CPU 64코어·메모리 256GiB 상한을 없앰 (큰 워크로드도 그대로 이식). 남용 막기 상한은 L-1 몫.
//   extended = CPU·메모리 말고 출발에 적힌 자원 이름 → k8s 수량 글자 그대로 (nvidia.com/gpu: "1", ephemeral-storage: "10Gi", hugepages-2Mi: "1Gi").
//   값은 바꾸지 않고 도착 requests·limits 에 같은 이름으로 넣는다. GPU 를 못 주는 도착은 v2Blockers 가 계획 단계에서 막는다
export const ExtendedResourceName = z.string().regex(/^(?:[a-z0-9]([-a-z0-9.]*[a-z0-9])?\/)?[A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?$/).max(253);
const Amount = z.object({
  cpuMilli: z.number().int().min(1).nullable(),
  memMiB: z.number().int().min(1).nullable(),
  extended: z.record(ExtendedResourceName, z.string().max(64)).optional(),
}).strict();
const Resources = z.object({ request: Amount.optional(), limit: Amount.optional() }).strict();
// SZ-1 DRAFT(ai): DB 크기는 파드 상한(64 vCPU·256GiB)보다 큰 출발이 흔하다 (RDS r6g.16xlarge 512GiB 등). 넘친다고 줄이거나 가져오기를 깨지 않게 DB 칸만 넓힘
const DbAmount = z.object({
  cpuMilli: z.number().int().min(1).max(512000).nullable(),
  memMiB: z.number().int().min(1).max(33554432).nullable(),
}).strict();
const PortSpec = z.object({ name: z.string().optional(), port: Port, protocol: Protocol.optional(),
  hostPort: Port.optional(),                          // HN-1: 노드 포트를 직접 잡음 (보안 낮음 → host_access 승인)
}).strict();
// PR-1: 출발 프로브 칸 전부 (없는 칸은 비움 = 도착도 k8s 기본값). timeoutSec 를 버리면 느린 헬스 체크가 도착에서 1초로 돌아 재시작 반복
const Timing = {
  periodSec: z.number().int().optional(),
  failureThreshold: z.number().int().optional(),
  initialDelaySec: z.number().int().optional(),
  timeoutSec: z.number().int().optional(),
  successThreshold: z.number().int().optional(),
  terminationGracePeriodSec: z.number().int().optional(),   // 프로브 단위 종료 유예 (liveness·startup)
};
const Probe = z.discriminatedUnion("type", [
  z.object({ type: z.literal("http"), path: z.string().optional(), port: z.union([Port, z.string()]), scheme: z.enum(["HTTP", "HTTPS"]).optional(),
    headers: z.array(z.object({ name: z.string(), value: z.string() }).strict()).max(20).optional(), ...Timing }).strict(),
  z.object({ type: z.literal("tcp"), port: z.union([Port, z.string()]), ...Timing }).strict(),
  z.object({ type: z.literal("grpc"), port: Port, service: z.string().optional(), ...Timing }).strict(),
  z.object({ type: z.literal("exec"), command: z.array(z.string()), ...Timing }).strict(),
]);

// 의존성 출력 이름. 도착 모듈이 이 이름으로 값을 낸다 (어댑터가 import 해서 씀)
// DRAFT(ai): 표는 설계 20번 4.5 / PoC OUTPUTS_OK 그대로
export const LINK_OUTPUTS = {
  // CNPG-RO DRAFT(ai): reader = 읽기 전용 주소 (읽기 복제본이 있으면 그 주소, 없으면 주 서버). 출발이 CNPG -ro·-r 를 가리키던 env 가 받는다
  postgres: ["host", "port", "url", "user", "reader"],
  cache: ["host", "port", "url"],
  objectStore: ["name", "url"],
  queue: ["url", "name"],
  service: ["host", "port", "url"],
} as const satisfies Record<string, readonly string[]>;
export const LinkOutputV2 = z.enum(["host", "port", "url", "name", "user", "reader"]);
export type LinkOutputV2 = z.infer<typeof LinkOutputV2>;
// G3-5 DRAFT(ai): 서비스 대상이면 "어느 k8s Service 객체를 불렀나"(출발 Service 이름 = endpoints[].name)를 같이 적는다.
//   template 은 \${<id>.<출력>@<Service 이름>}, fromLink 는 endpoint 칸. 없으면 예전처럼 이름순 첫 endpoint
//   그룹: 1 = id, 2 = 출력, 3 = Service 이름(없을 수 있음)
export const LINK_TEMPLATE = /\$\{([a-z][a-z0-9-]{0,39})\.(host|port|url|name|user|reader)(?:@([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))?\}/g;
const LinkEndpoint = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/);

// 환경변수: 값 하나는 아래 출처 중 하나. 벤더 주소였던 값은 fromLink·template 으로 바꿔 적는다
const EnvVar = z.union([
  z.object({ name: EnvName, value: z.string() }).strict(),
  z.object({ name: EnvName, template: z.string() }).strict(),          // "rediss://${shop-cache.host}:6379"
  // EV-1: containerName(다른 컨테이너 한도 읽기)·divisor(단위, 예 "1Mi") 원문 그대로
  z.object({ name: EnvName, fromResource: z.string(), containerName: z.string().optional(), divisor: z.string().optional() }).strict(),      // limits.cpu 같은 자원 값
  z.object({ name: EnvName, fromSecret: z.object({ secret: z.string(), key: z.string(), optional: z.boolean().optional() }).strict() }).strict(),   // EV-1: optional
  z.object({ name: EnvName, fromConfig: z.object({ config: z.string(), key: z.string(), optional: z.boolean().optional() }).strict() }).strict(),
  z.object({ name: EnvName, fromField: z.string() }).strict(),         // metadata.namespace 같은 파드 정보
  // G3-5: endpoint = 부른 Service 이름. SUB-1 DRAFT(ai): subscription = 대상 queue(topic 모델)의 subscriptions[].name (출발 구독 이름). 그 구독의 도착 이름을 뜻함 (output 은 name 만)
  z.object({ name: EnvName, fromLink: z.object({ to: Id, output: LinkOutputV2, endpoint: LinkEndpoint.optional(), subscription: z.string().min(1).max(255).optional() }).strict() }).strict(),
]);
export type EnvVarV2 = z.infer<typeof EnvVar>;
const EnvFrom = z.union([
  z.object({ config: z.string(), prefix: z.string(), optional: z.boolean().optional() }).strict(),   // EV-1: optional
  z.object({ secret: z.string(), prefix: z.string(), optional: z.boolean().optional() }).strict(),
]);
// 설정 묶음(ConfigMap 등): 내용 해시로 "출발과 같은가"를 판 비교에서 본다
// N3 DRAFT(ai): data = 출발 값 그대로 (평문 비밀처럼 보이는 키는 가져오기가 빼고 검토 표시). binaryKeys = binaryData 키 이름만(값은 안 담음 → 도착 렌더가 막음)
//   LK-1 DRAFT(ai): templateKeys = 값 안의 출발 주소를 \${<id>.<출력>} 로 바꾼 키. 도착 렌더가 이 키만 템플릿으로 푼다
const Config = z.object({
  name: z.string(), data: Str, sha256: z.string(), mountPath: z.string().optional(),
  binaryKeys: z.array(z.string()).max(500).optional(),
  templateKeys: z.array(z.string()).max(500).optional(),
}).strict();

// N4 DRAFT(ai): 컨테이너 마운트 원문. name = volumes[].name 또는 podVolumes[].name
const VolumeMount = z.object({ name: z.string(), mountPath: z.string(), subPath: z.string().optional(), readOnly: z.boolean().optional() }).strict();
// N4 DRAFT(ai): PVC 가 아닌 파드 볼륨 (PVC 계열은 volumes[]). source = 그 종류의 k8s 원문 (configMap·secret 은 이름 그대로)
export const POD_VOLUME_TYPES = ["configMap", "secret", "emptyDir", "projected", "downwardAPI", "hostPath"] as const;
const PodVolume = z.object({ name: z.string(), type: z.enum(POD_VOLUME_TYPES), source: z.record(z.string(), z.unknown()) }).strict();
// LK-1 DRAFT(ai): command·args 중 템플릿(\${<id>.<출력>})으로 바꾼 칸의 위치 번호. 없으면 전부 글자 그대로
const ArgTemplates = { commandTemplates: z.array(z.number().int().min(0)).max(50).optional(), argTemplates: z.array(z.number().int().min(0)).max(100).optional() };

// 같이 돌던 컨테이너(사이드카·init). 메시 주입형은 injected: true (도착 메시가 다시 넣음)
const Container = z.object({
  name: z.string(),
  image: ImageV2,
  command: z.array(z.string()).optional(),
  args: z.array(z.string()).optional(),
  ports: z.array(PortSpec).optional(),
  env: z.array(EnvVar),
  resources: Resources,
  probes: z.record(z.string(), Probe).optional(),
  injected: z.boolean().optional(),
  volumeMounts: z.array(VolumeMount).max(50).optional(),            // N4
  restartPolicy: z.literal("Always").optional(),                      // N4: 네이티브 사이드카 (initContainers 안 restartPolicy Always)
  securityContext: z.record(z.string(), z.unknown()).optional(),      // N4: 컨테이너 단위 원문
  ...ArgTemplates,
}).strict();

// N5 DRAFT(ai): 배치 칸 원문. 노드 이름처럼 도착에서 안 맞는 값은 가져오기가 검토 표시. topologySpread·priorityClass 는 P-1 과 맞춰 여기
const Scheduling = z.object({
  nodeSelector: Str.optional(),
  tolerations: z.array(z.record(z.string(), z.unknown())).max(50).optional(),
  affinity: z.record(z.string(), z.unknown()).optional(),
  topologySpreadConstraints: z.array(z.record(z.string(), z.unknown())).max(20).optional(),
  priorityClassName: z.string().optional(),
}).strict();

// service·job 공통
const Workload = {
  namespace: z.string().optional(),                   // k8s 출발이면 있음
  // PL-2 DRAFT(ai): 출발 파드 템플릿 라벨 그대로 (NetworkPolicy·PDB·ServiceMonitor 가 이 라벨로 고름). 도착은 플랫폼 라벨과 겹치면 플랫폼 우선
  podLabels: Str.optional(),
  image: ImageV2,
  command: z.array(z.string()).max(L.command).optional(),
  args: z.array(z.string()).max(L.args).optional(),
  resources: Resources,
  env: z.array(EnvVar).max(L.env),
  envFrom: z.array(EnvFrom).max(L.envFrom).optional(),
  configs: z.array(Config).max(L.configs).optional(),
  secretMounts: z.array(z.object({ secret: z.string(), mountPath: z.string() }).strict()).max(L.secretMounts).optional(),
  serviceAccount: z.string(),                         // 출발 신원 이름. 안 적혔으면 k8s 규칙대로 "default"
  securityContext: z.record(z.string(), z.unknown()).optional(),
  sidecars: z.array(Container).max(L.sidecars).optional(),
  initContainers: z.array(Container).max(L.initContainers).optional(),
  // A-1 DRAFT(ai): 이 워크로드 파드가 돌던 출발 노드 CPU 종류 (kubernetes.io/arch, 정렬·중복 없음). 못 읽으면 칸 없음 + 검토 표시.
  //   image.digest 는 실행 중 Pod imageID = 받아 온 digest (태그로 받았으면 multi-arch 목록(index) digest) 그대로. 도착 노드풀 arch 와 대조는 v2Blockers
  nodeArch: z.array(z.string().regex(/^[a-z0-9]+$/)).max(8).optional(),
  volumes: z.array(z.object({
    name: z.string(), mountPath: z.string(), sizeGb: z.number().optional(),
    access: z.enum(["RWO", "RWX", "ROX", "RWOP"]).optional(),
    // D6 DRAFT(ai): 출발 그대로. storageClass = 출발 클래스 이름(도착 대응은 Q-3), claimTemplate = StatefulSet 파드별 PVC(volumeClaimTemplates)
    storageClass: z.string().optional(),
    claimTemplate: z.boolean().optional(),           // subPath·readOnly 는 마운트 칸(N4 volumeMounts) 몫
    claimName: z.string().optional(),                 // N4: Deployment 가 참조하던 출발 PVC 이름 그대로
  }).strict()).max(L.volumes).optional(),
  podVolumes: z.array(PodVolume).max(L.volumes).optional(),   // N4
  volumeMounts: z.array(VolumeMount).max(L.volumes).optional(),   // N4: 주 컨테이너 마운트 (있으면 volumes[].mountPath 보다 우선)
  // SS-V DRAFT(ai): k8s Secret 밖 비밀 저장소에서 오는 비밀 (출발 그대로 기록). eso = ExternalSecret 이 만든 k8s Secret, vault-agent = Vault Agent 주입 파일.
  //   도착 저장소로 값 복사·연결은 자동으로 안 함 → v2Blockers 가 사람에게 묻는다. 값은 안 담음 (경로·키 이름만)
  secretSources: z.array(z.object({
    via: z.enum(["eso", "vault-agent"]),
    secret: z.string().optional(),                    // eso: 만들어지는 k8s Secret 이름 / vault-agent: 주입 파일 이름
    store: z.string().optional(),                     // eso: SecretStore·ClusterSecretStore 이름 (kind/name)
    provider: z.string().optional(),                  // aws·gcpsm·vault·azurekv … (SecretStore spec.provider 키) / vault-agent 는 vault
    role: z.string().optional(),                      // vault-agent: Vault 역할
    refs: z.array(z.object({ key: z.string(), remote: z.string(), property: z.string().optional() }).strict()).max(100),
  }).strict()).max(20).optional(),
  scheduling: Scheduling.optional(),                  // N5
  host: z.object({ network: z.literal(true).optional(), pid: z.literal(true).optional(), ipc: z.literal(true).optional() }).strict().optional(),   // HN-1: hostNetwork·hostPID·hostIPC
  podAnnotations: Str.optional(),                     // N10: 허용 목록 키만
  ...ArgTemplates,                                    // LK-1
};

// 출발 원래 실행 모양 (매트릭스 "지금" 칸). runtime 과 다르면 checkV2 가 runtime_change 승인 줄을 낸다
export const OriginV2 = z.object({
  runtime: z.enum(["k8s", "managedContainer", "vm", "paas", "source"]),
  product: z.string(),                                 // 예: eks, gke, k3s, ecs, cloudRun, ec2
}).strict();
export type OriginV2 = z.infer<typeof OriginV2>;

const ServiceV2 = z.object({
  id: Id, kind: z.literal("service"),
  props: z.object({
    // 도착 실행 방식. 재현성: 기본은 출발과 같은 클래스 (VM → VM, ECS·Cloud Run → 관리형 컨테이너, k8s → k8s). 다른 칸은 runtime_change 승인
    runtime: z.enum(["k8s", "managedContainer", "vm"]),
    origin: OriginV2,
    ...Workload,
    // D6 DRAFT(ai): 출발 워크로드 종류. 없으면 deployment (옛 IR 그대로). 도착도 같은 종류로 그린다
    workloadKind: z.enum(["deployment", "statefulset", "daemonset"]).optional(),
    statefulSet: z.object({
      serviceName: z.string(),                          // 파드별 고정 DNS(<파드>.<serviceName>) 를 주는 headless Service
      podManagementPolicy: z.enum(["OrderedReady", "Parallel"]).optional(),
      pvcRetention: z.object({ whenDeleted: z.enum(["Retain", "Delete"]).optional(), whenScaled: z.enum(["Retain", "Delete"]).optional() }).strict().optional(),
    }).strict().optional(),
    ports: z.array(PortSpec).max(L.ports).optional(),        // 없을 수 있다 (워커)
    endpoints: z.array(z.object({                       // k8s Service 객체 (파드 앞 고정 주소)
      name: z.string(),
      type: z.enum(["ClusterIP", "NodePort", "LoadBalancer", "Headless"]),
      ports: z.array(z.object({
        name: z.string().optional(), port: Port, targetPort: z.union([Port, z.string()]), protocol: Protocol,
        appProtocol: z.string().min(1).max(253).optional(),   // V-1: 출발 Service 포트의 appProtocol 그대로 (http2·grpc 등, 입구·메시가 읽음)
        nodePort: Port.optional(),                      // NP-1: 출발 번호 그대로 (바깥 장비가 이 번호를 가리킴)
      }).strict()),
      annotations: Str.optional(),                      // N10: 허용 목록 키만
      // V-1 DRAFT(ai): Service 동작 칸. 출발에 적힌 것만 (없으면 칸 없음 = k8s 기본)
      publishNotReadyAddresses: z.boolean().optional(),
      sessionAffinity: z.enum(["None", "ClientIP"]).optional(),
      sessionAffinityTimeoutSec: z.number().int().min(1).max(86400).optional(),
      externalTrafficPolicy: z.enum(["Cluster", "Local"]).optional(),
      internalTrafficPolicy: z.enum(["Cluster", "Local"]).optional(),
      loadBalancerSourceRanges: z.array(z.string()).max(100).optional(),   // NP-1: 빠지면 도착 LB 가 더 넓게 열림
      loadBalancerIP: z.string().optional(),            // info: 클라우드가 달라 같은 IP 는 못 받음 (검토 표시)
    }).strict()).max(L.endpoints).optional(),
    probes: z.object({ readiness: Probe.optional(), liveness: Probe.optional(), startup: Probe.optional() }).strict().optional(),
    replicas: z.object({ min: z.number().int().min(0).max(L.replicas), max: z.number().int().min(0).max(L.replicas) }).strict(),   // max 0 = 0으로 줄여 둔 서비스 (재현성: 그대로 가져옴, checkV2 가 검토 표시)
    // N7 DRAFT(ai): metrics·behavior = HPA autoscaling/v2 원문. targetCpuPct 는 옛 칸(CPU 하나)이라 그대로 둠 (metrics 가 있으면 도착은 metrics 를 씀)
    scale: z.object({
      targetCpuPct: z.number().int().min(1).max(100).optional(),
      metrics: z.array(z.record(z.string(), z.unknown())).max(20).optional(),
      behavior: z.record(z.string(), z.unknown()).optional(),
    }).strict().optional(),
    // N5 DRAFT(ai): PodDisruptionBudget 하나 (출발 값 그대로, 정수 또는 "50%")
    disruption: z.object({
      name: z.string(),
      minAvailable: z.union([z.number().int().min(0), z.string()]).optional(),
      maxUnavailable: z.union([z.number().int().min(0), z.string()]).optional(),
      unhealthyPodEvictionPolicy: z.enum(["IfHealthyBudget", "AlwaysAllow"]).optional(),   // PD-1: 출발 값 그대로
    }).strict().optional(),
  }).strict(),
}).strict();

const JobV2 = z.object({
  id: Id, kind: z.literal("job"),
  props: z.object({
    ...Workload,
    schedule: z.string().min(9),                        // cron 5필드. 변환은 매퍼
    timeZone: z.string().optional(),
    concurrencyPolicy: z.enum(["Allow", "Forbid", "Replace"]).optional(),
    suspend: z.boolean().optional(),
    backoffLimit: z.number().int().optional(),
    activeDeadlineSec: z.number().int().optional(),
    restartPolicy: z.enum(["OnFailure", "Never"]).optional(),
  }).strict(),
}).strict();

// INCL DRAFT(ai): 클러스터 안(k8s 워크로드)으로 띄운 데이터 서비스. 출발 모양 = 그 워크로드(id)가 곧 이 데이터 자원.
//   가져오기가 이미지·포트·라벨로 알아보고 데이터 자원을 하나 더 만든다(워크로드는 그대로 남음). 도착 Builder 는 지금처럼 워크로드를 그대로 그리고
//   이 자원·이 자원으로 가는 의존성은 안 그린다(renderViewV2). 데이터는 안 따라감 → 가져오기가 "데이터 복사 필요" 검토 줄을 띄움
// TODO(human): 도착 종류를 출발과 같게(워크로드 그대로) 둘지, 관리형·D7 표(notes/research/35)로 바꿀지, XC-1 호환 API 로 갈지는 사람이 정함
export const IN_CLUSTER_PRODUCTS = ["postgres", "redis", "valkey", "minio", "rabbitmq", "kafka"] as const;
const InClusterSource = z.object({ workload: Id, product: z.enum(IN_CLUSTER_PRODUCTS) }).strict();

const PostgresV2 = z.object({
  id: Id, kind: z.literal("postgres"),
  props: z.object({
    // DRAFT(ai): R3 — CNPG·Cloud SQL 에서 못 읽을 수 있어 nullable. 못 읽으면 가져오기가 검토 표시
    majorVersion: z.string().regex(/^\d{1,2}$/).nullable(),
    storageGb: z.number().int().min(1).max(65536).nullable(),   // v1 의 100 자르기 없앰
    storageMaxGb: z.number().int().optional(),
    compute: DbAmount.optional(),
    ha: z.boolean().optional(),
    readReplicas: z.number().int().min(0).max(15).optional(),
    databases: z.array(z.string()).max(L.databases).optional(),
    extensions: z.array(z.string()).max(L.extensions).optional(),
    parameters: Str.optional(),
    logicalReplication: z.boolean().optional(),
    // DBN-1·E10-2 DRAFT(ai): 앱이 붙는 DB 이름·앱 계정(역할) 이름. 출발 앱 주소(user@…/db)·CNPG initdb·RDS DBName 에서 읽음.
    //   도착 세 곳(RDS·Cloud SQL·CNPG)이 이 이름 그대로 만든다. 없으면 Builder 기본(<앱>_ · app) + 사전 점검 경고
    appDatabase: z.string().min(1).max(63).optional(),
    appUser: z.string().min(1).max(63).optional(),
    // BK-1 DRAFT(ai): 출발 자동 백업. retentionDays 0 = 백업 꺼짐, null = 못 읽음. pitr = 시점 복구(WAL 보관) 켬
    backup: z.object({ retentionDays: z.number().int().min(0).max(3650).nullable(), pitr: z.boolean().nullable() }).strict().optional(),
    // BK-1 DRAFT(ai): 출발 유지보수 창 (UTC, RDS 모양 "ddd:hh:mm-ddd:hh:mm"). 없으면 도착 상품이 고름
    maintenanceWindow: z.string().regex(/^(mon|tue|wed|thu|fri|sat|sun):([01]\d|2[0-3]):[0-5]\d-(mon|tue|wed|thu|fri|sat|sun):([01]\d|2[0-3]):[0-5]\d$/).optional(),
    // DM-8 DRAFT(ai): CNPG WAL 전용 볼륨 크기(GB). 클라우드 도착(RDS·Cloud SQL)은 볼륨 하나라 경고, 온프레는 CNPG walStorage 로
    walStorageGb: z.number().int().min(1).max(65536).optional(),
    // DM-7 DRAFT(ai): 출발 접속 포트. 없으면 5432. 도착이 포트를 고를 수 있으면(RDS) 같은 포트로 만들고, 못 고르면(Cloud SQL·CNPG 5432 고정) 사전 점검 경고
    port: z.number().int().min(1).max(65535).optional(),
    // SSL-1 DRAFT(ai): 출발 DB 가 평문 연결을 거절하나. null = 못 읽음. false 면 도착도 같게 두고 checkV2 가 tls_relaxed 승인 줄
    tlsRequired: z.boolean().nullable().optional(),
    inCluster: InClusterSource.optional(),     // INCL
  }).strict(),
}).strict();

const CacheV2 = z.object({
  id: Id, kind: z.literal("cache"),
  props: z.object({
    engine: z.enum(["redis", "valkey", "memcached"]),
    version: z.string().optional(),
    memoryMiB: z.number().int().min(1).max(1048576).nullable(),
    clusterMode: z.boolean().optional(),
    shards: z.number().int().optional(),
    tls: z.boolean().nullable(),
    auth: z.boolean().nullable(),
    ha: z.boolean().optional(),
    port: z.number().int().min(1).max(65535).optional(),   // DM-7: 출발 접속 포트 (없으면 6379)
    inCluster: InClusterSource.optional(),     // INCL
  }).strict(),
}).strict();

// DM-1·TF4-1 DRAFT(ai): CORS 규칙 한 줄의 공통 모양. 출발 클라우드 칸 이름(S3 AllowedOrigins…, GCS origin…)은 매퍼가 여기로 바꾼다.
//   origins·methods 는 출발에 적힌 그대로(좁힌 출처를 "*" 로 넓히거나 메서드를 GET 으로 줄이지 않음). 비면 규칙이 아니라서 거부(min 1).
//   allowedHeaders = 브라우저가 보내도 되는 요청 헤더(S3 AllowedHeaders), exposeHeaders = 응답에서 읽어도 되는 헤더(S3 ExposeHeaders·GCS responseHeader)
export const CorsRuleV2 = z.object({
  origins: z.array(z.string().min(1)).min(1),
  methods: z.array(z.string().min(1)).min(1),
  allowedHeaders: z.array(z.string()).optional(),
  exposeHeaders: z.array(z.string()).optional(),
  maxAgeSec: z.number().int().nonnegative().optional(),
}).strict();
export type CorsRuleV2 = z.infer<typeof CorsRuleV2>;

const ObjectStoreV2 = z.object({
  id: Id, kind: z.literal("objectStore"),
  props: z.object({
    versioning: z.boolean().nullable(),                 // DM-2: null = 출발 설정을 못 읽음 (꺼짐 아님). Builder 가 사람에게 묻는다
    public: z.boolean().nullable(),                     // null = 모름(모듈은 열지 않고 사람에게 묻는다). B-2: true 면 도착도 공개 + checkV2 public_bucket 승인 줄
    sizeGb: z.number().nonnegative().nullable(),
    lifecycle: z.array(z.object({
      prefix: z.string(), expireDays: z.number().int().optional(), toColdAfterDays: z.number().int().optional(),
    }).strict()).max(L.lifecycle).optional(),
    cors: z.array(CorsRuleV2).max(L.corsRules).optional(),
    // B-1b: 버킷 이벤트 알림 (S3 → SQS·SNS·Lambda, GCS → Pub/Sub). to = IR 큐·토픽 id, 없으면 IR 밖 대상(함수·EventBridge·다른 계정)
    notifications: z.array(z.object({
      target: z.enum(["queue", "topic", "function", "eventbus"]),
      to: Id.optional(),
      events: z.array(z.string().max(100)).max(20),
      prefix: z.string().max(1024).optional(),
      suffix: z.string().max(1024).optional(),
    }).strict()).max(L.notifications).optional(),
    inCluster: InClusterSource.optional(),     // INCL
  }).strict(),
}).strict();

// PS-1·DM-6·B-1 DRAFT(ai): 받는 쪽(구독) 설정. queue 모델이면 큐 자체 칸, topic 모델이면 subscriptions 한 줄마다.
//   retentionSec = 안 받은 메시지를 얼마나 두나 (SQS MessageRetentionPeriod = Pub/Sub 구독 messageRetentionDuration, 토픽 보관과 다름)
//   idleExpirySec = 안 쓰면 구독을 지우는 시간(Pub/Sub expirationPolicy.ttl). 없음 = 만료 안 함
//   retainAcked = 받은(ack) 메시지도 보관(되감기용). filter = Pub/Sub 구독 필터 원문. push = 밀어 보내는 구독의 주소
const ReceiveV2 = {
  ackTimeoutSec: z.number().int().optional(),
  retentionSec: z.number().int().min(60).max(2678400).optional(),
  ordered: z.boolean().optional(),
  idleExpirySec: z.number().int().min(1).optional(),
  retainAcked: z.boolean().optional(),
  filter: z.string().min(1).optional(),
  push: z.object({ endpoint: z.string().min(1) }).strict().optional(),
};
const SubscriptionV2 = z.object({
  name: z.string().min(1),                              // 출발 구독 이름 (도착 이름은 Builder 가 정함)
  ...ReceiveV2,
  deadLetter: z.object({ maxReceive: z.number().int().optional() }).strict().optional(),   // 구독 목록 안 DLQ 는 아직 못 그림 (v2Blockers)
}).strict();

const QueueV2 = z.object({
  id: Id, kind: z.literal("queue"),
  props: z.object({
    model: z.enum(["queue", "topic"]),                  // SQS = queue, Pub/Sub·SNS = topic
    ...ReceiveV2,
    deadLetter: z.object({ to: Id.optional(), maxReceive: z.number().int().optional() }).strict().optional(),
    subscriptions: z.array(SubscriptionV2).max(L.subscriptions).optional(),   // PS-1: topic 모델의 구독이 둘 이상일 때
    // B-2: SNS 토픽 구독 (Pub/Sub 구독 subscriptions 와 다른 칸). sqs 구독은 to = IR 큐 id. 나머지 프로토콜(http·lambda·email…)은 대상 주소를 안 담고 종류만
    topicSubscriptions: z.array(z.object({
      protocol: z.enum(["sqs", "http", "https", "lambda", "email", "email-json", "sms", "application", "firehose"]),
      to: Id.optional(),
    }).strict()).max(L.topicSubscriptions).optional(),
    inCluster: InClusterSource.optional(),     // INCL
  }).strict(),
}).strict();

// 리소스 유형 6개 판별 합집합
export const ComponentV2 = z.discriminatedUnion("kind", [ServiceV2, JobV2, PostgresV2, CacheV2, ObjectStoreV2, QueueV2]);
export type ComponentV2 = z.infer<typeof ComponentV2>;
export const COMPONENT_KINDS_V2 = ["service", "job", "postgres", "cache", "objectStore", "queue"] as const;
export type ComponentKindV2 = (typeof COMPONENT_KINDS_V2)[number];

// ── 의존성 ────────────────────────────────────────────
// 이 의존성의 근거가 된 출발 권한 문장 원문. 모듈은 의도가 아니라 이걸 같은 범위로 옮긴다
const Grant = z.object({
  effect: z.literal("Allow"),
  actions: z.array(z.string()),
  resources: z.array(z.string()),
  conditions: z.record(z.string(), z.unknown()).optional(),
}).strict();
export const LinkV2 = z.object({
  from: Id,                                             // service 또는 job
  to: z.union([
    Id,                                                 // IR 리소스
    z.object({ unmapped: z.string() }).strict(),        // 옮기지 못한 자원(출발에 남음). 의존성 유지용 기록
    z.object({ external: z.string() }).strict(),        // 고객 밖 서비스. 주소 그대로, 도착 방화벽 출구만
  ]),
  intent: z.enum(["connect", "read", "write", "readwrite", "admin", "call"]),
  grants: z.array(Grant).max(L.grantsPerLink).optional(),
}).strict();
export type LinkV2 = z.infer<typeof LinkV2>;

// ── 라우팅 (Gateway API HTTPRoute Standard 필드 모양) ──────
const Match = z.object({
  path: z.object({ type: z.enum(["Exact", "PathPrefix"]), value: z.string().startsWith("/") }).strict(),
  headers: z.array(z.object({ name: z.string(), value: z.string() }).strict()).max(L.headers).optional(),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]).optional(),
}).strict();
const Route = z.object({
  matches: z.array(Match).min(1).max(L.matches),
  backends: z.array(z.object({ to: Id, port: Port, weight: z.number().int().min(0).max(1_000_000) }).strict()).min(1).max(L.backends),
}).strict();
// GW-2 DRAFT(ai): 앱 호스트 이름에 걸린 출발 공개 DNS 레코드 (Route53·Cloud DNS). 기록·계획 줄용 (도착에서 바꾸는 건 사람·다른 단계 몫)
//   read=false = 못 읽음(권한 없음 등). read=true 인데 records 가 비면 공개 영역에서 못 찾음(다른 DNS 업체일 수 있음)
const DnsRecord = z.object({
  provider: z.enum(["route53", "clouddns"]),
  zone: z.string(),                                     // 영역 이름 (example.com.)
  name: z.string(),                                     // 레코드 이름 그대로 (끝 점 포함)
  type: z.string().regex(/^[A-Z]{1,10}$/),             // A·AAAA·CNAME …
  ttl: z.number().int().min(0).optional(),
  values: z.array(z.string()).max(20),
  alias: z.string().optional(),                         // Route53 별칭 대상(DNSName)
  weight: z.number().int().min(0).optional(),           // 가중치 레코드
  setId: z.string().optional(),                         // Route53 SetIdentifier
  policy: z.string().optional(),                        // 가중치 외 라우팅 정책 이름 (failover·latency·geo·wrr …)
}).strict();
const EntryHost = z.object({
  hostnames: z.array(z.string()).min(1).max(L.hostnames),
  tls: z.object({ mode: z.enum(["terminate", "passthrough"]), source: z.string().optional() }).strict().optional(),
  routes: z.array(Route).min(1).max(L.routes),          // G3c-6: 경로 0개 호스트는 없다 (가져오기는 빼고, PATCH 도 막는다)
  dns: z.object({ read: z.boolean(), records: z.array(DnsRecord).max(10) }).strict().optional(),   // GW-2
  annotations: Str.optional(),                          // N10: Ingress 동작 키(허용 목록)만
  // ENT-1: 출발 Ingress 가 인터넷 공개였나 사내망 전용이었나 (클래스 이름·scheme annotation). 없으면 공개로 본다(옛 명세)
  exposure: z.enum(["public", "internal"]).optional(),
}).strict();
export const EntriesV2 = z.object({
  via: z.literal("cloudflare-lb"),
  hosts: z.array(EntryHost).min(1).max(L.hosts),            // 라우팅이 없으면 entry 자체를 뺀다
}).strict();
export type EntriesV2 = z.infer<typeof EntriesV2>;

// ── 보안 기준선 ───────────────────────────────────────
// 의존성으로 못 옮기는 출발 상태 (Resource "*", Deny, 조건, DB 방화벽, NetworkPolicy 없음)
export const PostureV2 = z.object({
  permissions: z.array(z.object({
    subject: Id,
    source: z.string(),                                 // iam:<역할 이름> 등 원문 근거
    effect: z.enum(["Allow", "Deny"]),
    actions: z.array(z.string()),
    notActions: z.array(z.string()).optional(),
    resources: z.array(z.string()),
    notResources: z.array(z.string()).optional(),
    conditions: z.record(z.string(), z.unknown()).optional(),
    covers: z.array(Id).optional(),
    mode: Mode,
    note: z.string().optional(),
  }).strict()).max(L.permissions),
  network: z.array(z.discriminatedUnion("scope", [
    z.object({
      scope: z.literal("namespace"), namespace: z.string(), mode: Mode,
      policies: z.array(z.string()),
      default: z.enum(["allow-all", "as-declared"]),
      // N6 DRAFT(ai): NetworkPolicy 원문 (이름·본문 그대로). 도착은 같은 이름으로 그림
      rules: z.array(z.object({
        name: z.string(),
        podSelector: z.record(z.string(), z.unknown()),
        policyTypes: z.array(z.enum(["Ingress", "Egress"])).optional(),
        ingress: z.array(z.record(z.string(), z.unknown())).max(100).optional(),
        egress: z.array(z.record(z.string(), z.unknown())).max(100).optional(),
      }).strict()).max(100).optional(),
    }).strict(),
    z.object({
      scope: z.literal("component"), subject: Id, mode: Mode,
      ingress: z.union([z.array(z.object({ from: z.string(), port: Port.optional() }).strict()), z.literal("unknown")]),
      public: z.boolean().nullable(),
    }).strict(),
  ])).max(L.network),
  // E-1: 출발 앱이 밖으로 나갈 때 쓰는 고정 IP (NAT). 파트너 허용 목록에 들어 있을 수 있다. 도착은 클라우드가 달라 같은 IP 를 못 씀 → 계획 승인 줄
  //   fixed=false 면 출발도 자동 할당(바뀔 수 있음), null 이면 NAT 없음/모름. 못 읽었으면 칸 없음
  egress: z.object({ source: z.string().max(64), ips: z.array(z.string().max(64)).max(L.egressIps), fixed: z.boolean().nullable() }).strict().optional(),
}).strict();
export type PostureV2 = z.infer<typeof PostureV2>;

// ── k8s 권한 (T3) ─────────────────────────────────────
// DRAFT(ai): 앱 네임스페이스의 Role·RoleBinding 원문 + 이 앱 SA 를 가리키는 ClusterRoleBinding(이름·참조만, 도착은 사람 확인)
const RbacRule = z.record(z.string(), z.unknown());
const RoleRef = z.object({ kind: z.enum(["Role", "ClusterRole"]), name: z.string() }).strict();
const Subject = z.object({ kind: z.enum(["ServiceAccount", "User", "Group"]), name: z.string(), namespace: z.string().optional() }).strict();
export const RbacV2 = z.object({
  roles: z.array(z.object({ name: z.string(), namespace: z.string().optional(), rules: z.array(RbacRule).max(L.rbacRules) }).strict()).max(L.rbacRoles),
  roleBindings: z.array(z.object({ name: z.string(), namespace: z.string().optional(), roleRef: RoleRef, subjects: z.array(Subject).max(L.rbacSubjects) }).strict()).max(L.rbacBindings),
  clusterBindings: z.array(z.object({ name: z.string(), roleRef: RoleRef, subjects: z.array(Subject).max(L.rbacSubjects) }).strict()).max(L.rbacBindings).optional(),
}).strict();
export type RbacV2 = z.infer<typeof RbacV2>;
// ── 앱 비밀 (T1·SC-1·CA-1) ────────────────────────────
// DRAFT(ai): 이름·종류·키 이름만. 값은 IR·플랫폼을 안 거친다 (N2: 출발 클러스터 안 복사 Job 이 도착 비밀 저장소에 바로 씀).
//   type      = k8s Secret type 글자 그대로. 플랫폼은 Secret 객체를 안 읽으므로 가져오기는 쓰임새로 추정(Ingress tls → kubernetes.io/tls,
//               imagePullSecrets → kubernetes.io/dockerconfigjson, 나머지 Opaque, 신뢰도 0.9). 도착은 ExternalSecret target.template.type 으로 같은 type
//   allKeys   = envFrom·secretMounts 로 통째 쓰임 → 키 전부 옮김. false 면 keys 에 적힌 키만
//   binary    = 값이 UTF-8 글자가 아님 → 원격엔 base64, 도착 ExternalSecret 은 그 키만 decodingStrategy Base64. 가져오기는 안 채움(값을 못 봄).
//               복사 Job 이 글자 아닌 키를 만나면 키 이름만 알리고 멈춤 → 사람이 명세 검토에서 켬
//   pairedWith= 이 키 = 그 postgres·cache 의 비밀번호. 도착은 출발 값을 옮기지 않고 도착 DB·캐시가 새로 만든 비밀번호로 바꿔 끼움.
//               복사 Job 은 이 키를 건너뜀. 가져오기 추론은 신뢰도 0.9(검토 표시)
export const SecretKeyV2 = z.object({
  key: z.string().min(1).max(253),                     // k8s 키 또는 비밀 저장소 JSON 키 (ECS·Cloud Run 출발)
  binary: z.boolean().optional(),
  pairedWith: z.object({ component: Id, output: z.literal("password") }).strict().optional(),
}).strict();
export type SecretKeyV2 = z.infer<typeof SecretKeyV2>;
export const SecretV2 = z.object({
  name: z.string().min(1).max(512),                    // 출발 비밀 이름 그대로 (k8s Secret · Secrets Manager · Secret Manager)
  type: z.string().min(1).max(253),
  allKeys: z.boolean(),
  keys: z.array(SecretKeyV2).max(L.secretKeys),
}).strict();
export type SecretV2 = z.infer<typeof SecretV2>;
// SC-1: type 별로 k8s 가 요구하는 키 (복사 Job 이 출발 파일에서 이 키가 있는지 본다. 없으면 키 이름만 알리고 멈춤)
export const SECRET_TYPE_REQUIRED_KEYS: Readonly<Record<string, readonly string[]>> = {
  "kubernetes.io/tls": ["tls.crt", "tls.key"],
  "kubernetes.io/dockerconfigjson": [".dockerconfigjson"],
  "kubernetes.io/dockercfg": [".dockercfg"],
  "kubernetes.io/ssh-auth": ["ssh-privatekey"],
};
// ── 네임스페이스 (NS-1·M-1) ─────────────────────────────
// DRAFT(ai): 출발 네임스페이스 객체의 허용 목록 라벨·annotation (파드 보안 수준·메시 주입). 도착 네임스페이스 이름 = name 그대로 (M-1)
//   T4(ResourceQuota·LimitRange)도 이 항목에 칸을 더한다
export const NamespaceV2 = z.object({
  name: z.string().regex(/^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/),
  labels: Str.optional(),
  annotations: Str.optional(),
}).strict();
export type NamespaceV2 = z.infer<typeof NamespaceV2>;

// V-1 DRAFT(ai): ExternalName Service (바깥 주소를 클러스터 안 이름으로 감싼 것). 워크로드가 없어 리소스가 아니라 따로 둔다
export const ServiceAliasV2 = z.object({
  name: z.string(),
  namespace: z.string().optional(),
  externalName: z.string().min(1).max(253),
  ports: z.array(z.object({ name: z.string().optional(), port: Port, protocol: Protocol.optional() }).strict()).max(10).optional(),
}).strict();
export type ServiceAliasV2 = z.infer<typeof ServiceAliasV2>;

// ── 최상위 ────────────────────────────────────────────
// E-2: 출발 사설 DNS 레코드 하나. 이름(name)이 IR 자원 to 를 가리킨다 (값 = 출발 주소라 안 담음). 도착에 같은 이름을 만들지는 계획 줄로 사람이 정함
export const PrivateDnsRecordV2 = z.object({
  zone: z.string().min(1).max(253),
  name: z.string().min(1).max(253),
  type: z.enum(["A", "AAAA", "CNAME"]),
  to: Id,
}).strict();
export type PrivateDnsRecordV2 = z.infer<typeof PrivateDnsRecordV2>;

export const AppSpecV2 = z.object({
  schemaVersion: z.literal("2"),
  app: z.object({ name: Id }).strict(),
  availability: z.enum(["singleZone", "multiZone"]).optional(),   // 출발에서 읽은 경우만
  components: z.array(ComponentV2).min(1).max(L.components),
  links: z.array(LinkV2).max(L.links),
  entry: EntriesV2.optional(),
  posture: PostureV2,
  rbac: RbacV2.optional(),                              // T3
  privateDns: z.array(PrivateDnsRecordV2).max(L.privateDns).optional(),   // E-2: 출발 사설 DNS 이름 중 IR 자원을 가리키는 것 (없으면 칸 없음)
  secrets: z.array(SecretV2).max(L.secrets).optional(),       // T1·SC-1: 워크로드가 쓰는 비밀 (없으면 옛 판 = 비밀 표 전)
  namespaces: z.array(NamespaceV2).max(20).optional(),             // NS-1: k8s 출발이면 앱 네임스페이스 (없으면 옛 판 또는 k8s 밖 출발)
  serviceAliases: z.array(ServiceAliasV2).max(50).optional(),      // V-1: ExternalName Service
  security: SecuritySpecV2.optional(),                  // 보안 명세 파트. 가져오기는 비워 두고 고객이 명세 검토에서 넣는다 (PATCH "security")
}).strict();
export type AppSpecV2 = z.infer<typeof AppSpecV2>;

// ── 필드 출처·신뢰도 (v1 FieldMetaEntry 와 같은 모양이지만 따로 정의: openapi 이름 유지) ──
export const FieldMetaEntryV2 = z.object({
  source: z.string(),
  confidence: z.union([z.literal(1), z.literal(0.9), z.literal(0.6)]),
  needs_review: z.boolean(),
  rationale: z.string().optional(),
}).strict();
export type FieldMetaEntryV2 = z.infer<typeof FieldMetaEntryV2>;
export const FieldMetaV2 = z.record(z.string(), FieldMetaEntryV2);   // 키 = "components.<id>.<필드>" 등
export type FieldMetaV2 = z.infer<typeof FieldMetaV2>;

// 옮기지 못한 출발 자원. grade: A 자동 / B 사람 확인 / C 카탈로그 밖(출발에 두고 연결 유지)
// DRAFT(ai): 등급 뜻은 설계 20번 6.10장 기준 요약
export const UnmappedV2 = z.object({
  resource: z.string(),                                 // "<원본 종류>:<이름>"
  grade: z.enum(["A", "B", "C"]),
  reason: z.string(),
}).strict();
export type UnmappedV2 = z.infer<typeof UnmappedV2>;

// BOUNDARY DRAFT(ai): 앱 경계 밖 자원 (계정에 있지만 이 앱의 서비스·잡이 근거 있는 의존성으로 닿지 않음). 이름·종류만, 값 없음.
//   unmapped(이 앱 것인데 못 옮김)와 다르다: 이전 대상이 아니라 화면·보고에서 "경계 밖 N개" 로만 센다
export const OutOfBoundaryV2 = z.object({
  resource: z.string().max(300),                        // "<원본 종류>:<이름>"
  kind: z.enum(COMPONENT_KINDS_V2),
  reason: z.string().max(300),
}).strict();
export type OutOfBoundaryV2 = z.infer<typeof OutOfBoundaryV2>;

// BOUNDPULL DRAFT(ai): 경계 밖 데이터 자원을 사람이 끌어올 때(PATCH include) 쓰는 재료. 원본(인벤토리)은 저장하지 않으므로
//   가져오기 때 경계 밖으로 뺀 데이터 자원의 매퍼 결과(구성요소 + 그 fieldMeta)를 판 안에 둔다. 키 = outOfBoundary.resource. API 보기(GET spec)에는 안 나감
export const BoundaryPoolItem = z.object({
  component: ComponentV2,
  fieldMeta: FieldMetaV2,                               // "components.<id>.<칸>" 키만
  nativeType: z.string().max(100).optional(),           // postgres 의 원본 종류 (v1 투영 재료)
}).strict();
export type BoundaryPoolItem = z.infer<typeof BoundaryPoolItem>;

// 가져오기 결과 v2 한 벌 (spec_versions.spec_v2 한 칸)
export const ImportResultV2 = z.object({
  spec: AppSpecV2,
  fieldMeta: FieldMetaV2,
  unmapped: z.array(UnmappedV2),
  outOfBoundary: z.array(OutOfBoundaryV2).optional(),   // BOUNDARY: 경계 밖 (없으면 옛 판 = 경계 단계 전)
  boundaryPool: z.record(z.string().max(300), BoundaryPoolItem).optional(),   // BOUNDPULL: 경계 밖 데이터 자원을 끌어올 재료 (워크로드는 없음)
  included: z.array(z.string().max(300)).max(L.included).optional(),                  // BOUNDPULL: 사람이 끌어온 자원("<원본종류>:<이름>"). 재가져오기 때도 경계 안 유지
  ids: z.record(z.string(), Id),                        // 벤더 고유 키 → id. 재가져오기 때 같은 id 유지
  environment: z.array(z.unknown()).optional(),         // 근거·환경 종류로 읽은 항목 (매퍼 몫)
  // 가져오기가 출발 원본에서 읽은 DB 보안 사실 (postgres 구성요소 id → 사실). spec 밖이라 사람이 PATCH 로 못 고친다.
  //   다시 가져오면 새로 읽은 값으로 바뀐다 (carry 대상 아님). 없으면 옛 판 = 출발 사실 모름
  securityFacts: z.record(Id, SourceDbFacts).optional(),
  // G3b-1 DRAFT(ai): 이 판을 만든 가져오기가 출발에서 새로 읽은 links·entry·posture (사람 값 합치기 전). PATCH 판은 기준 판 것을 이어받는다.
  //   다음 가져오기의 3-way 합치기가 이것을 바탕(B)으로 쓴다 (예전엔 "사람이 처음 고치기 전 판"에 영원히 묶였다). 없으면 옛 판
  fresh: z.object({ links: z.array(LinkV2).optional(), entry: EntriesV2.optional(), posture: PostureV2.optional() }).strict().optional(),
}).strict();
export type ImportResultV2 = z.infer<typeof ImportResultV2>;

// checkV2 가 내는 "사람 승인 필요" 줄. 계획서 확인 항목(acknowledgements)으로 간다
export const ApprovalRowV2 = z.object({
  kind: z.enum(["runtime_change", "build", "tls_relaxed", "host_access", "public_bucket"]),   // HN-1: host_access = 노드 네트워크·프로세스·경로·포트를 직접 씀 (보안 낮음)
  // B-2: public_bucket = 출발이 공개 버킷 → 도착도 공개로 엶 (보안 낮음, 보안 영역 승인)
  // SSL-1: tls_relaxed = 출발이 평문 DB 연결을 허용 → 도착도 같게 (보안 낮음)
  subject: Id,                                          // 리소스 id
  from: z.string().optional(),
  to: z.string().optional(),
  detail: z.string().optional(),
}).strict();
export type ApprovalRowV2 = z.infer<typeof ApprovalRowV2>;
