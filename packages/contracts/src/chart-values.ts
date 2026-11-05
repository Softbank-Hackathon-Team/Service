import { z } from "zod";
import { K8sProbe } from "./k8s-probe.js";

// DRAFT(ai): PB-1/BV-1 — 앱 Helm 차트(gitops/charts/app)가 받는 값의 모양. 쿠버네티스 도착(EKS·GKE·k3s) Builder 가 만들고
//   차트 템플릿(workloads.yaml·cnpg.yaml·externalsecret.yaml·ingress.yaml·db-tunnel.yaml·sealedsecret.yaml)이 읽는다. 둘이 같은 이 계약을 보게 해서
//   "Builder 는 id·image.ref·IR 프로브를 내는데 차트는 name·image 글자·k8s 프로브를 읽는" 어긋남을 막는다.
//   규칙: 우리 칸은 .strict() (오타·옛 칸을 바로 잡음). k8s 객체를 그대로 넘기는 칸(env·resources·프로브 본문·securityContext)은 느슨하게.
//   없는 값은 키를 안 둔다 (차트 `with` 가 안 그림, 지문에도 안 남음).
//   계획 지문(helmValuesHash)이 이 값을 덮으므로 칸을 바꾸면 기존 계획 지문이 바뀐다.

const K8sObj = z.record(z.string(), z.unknown());
const Name = z.string().min(1).max(253);

// k8s 프로브 모양은 k8s-probe.ts 하나 (PR-1 시간 칸 포함)
const Probes = z.object({ readiness: K8sProbe.optional(), liveness: K8sProbe.optional(), startup: K8sProbe.optional() }).strict();

const ContainerPort = z.object({
  name: z.string().optional(), containerPort: z.number().int().min(1).max(65535), protocol: z.enum(["TCP", "UDP", "SCTP"]).optional(),
  hostPort: z.number().int().min(1).max(65535).optional(),   // HN-1/CV-1: 출발 hostPort 그대로 (host_access 승인 뒤)
}).strict();
// CV-1: 컨테이너 마운트 원문 (k8s volumeMounts 한 줄)
const VolumeMount = z.object({ name: Name, mountPath: z.string().min(1), subPath: z.string().optional(), readOnly: z.boolean().optional() }).strict();

// 보조·초기화 컨테이너: k8s 컨테이너 모양 그대로 (차트가 toYaml 로 넣음)
export const ChartContainer = z.object({
  name: Name,
  image: z.string(),
  command: z.array(z.string()).optional(),
  args: z.array(z.string()).optional(),
  ports: z.array(ContainerPort).optional(),
  env: z.array(K8sObj).optional(),
  resources: K8sObj.optional(),
  readinessProbe: K8sProbe.optional(),
  livenessProbe: K8sProbe.optional(),
  startupProbe: K8sProbe.optional(),
  volumeMounts: z.array(VolumeMount).optional(),      // CV-1: 보조·초기화 컨테이너 마운트 원문
  restartPolicy: z.literal("Always").optional(),      // CV-1: 네이티브 사이드카 (initContainers 안)
  securityContext: K8sObj.optional(),                 // CV-1: 컨테이너 단위 원문
}).strict();
export type ChartContainer = z.infer<typeof ChartContainer>;

// k8s Service 하나 (IR endpoints 한 줄 = Service 한 개. endpoints 가 없으면 Builder 가 포트로 워크로드 이름 Service 한 개를 만든다)
export const ChartService = z.object({
  name: Name,
  type: z.enum(["ClusterIP", "NodePort", "LoadBalancer", "Headless"]),
  ports: z.array(z.object({
    name: z.string().optional(), port: z.number().int(), targetPort: z.union([z.number().int(), z.string()]), protocol: z.enum(["TCP", "UDP", "SCTP"]).optional(),
    appProtocol: z.string().optional(),               // CV-1: 출발 appProtocol 그대로
  }).strict()).min(1),
  annotations: z.record(z.string(), z.string()).optional(),   // CV-1: 허용 목록 annotation 그대로
}).strict();

export const ChartWorkload = z.object({
  name: Name,                                         // = IR 부품 id = Deployment·CronJob 이름
  kind: z.enum(["service", "job"]),
  image: z.string(),                                  // 도착 레지스트리 주소@digest (또는 자리표시)
  command: z.array(z.string()).optional(),
  args: z.array(z.string()).optional(),
  env: z.array(K8sObj).optional(),
  envFrom: z.array(K8sObj).optional(),
  ports: z.array(ContainerPort).optional(),
  services: z.array(ChartService).optional(),
  probes: Probes.optional(),
  resources: K8sObj.optional(),
  replicas: z.number().int().min(0).optional(),       // HPA 없을 때만 Deployment.spec.replicas
  // CV-1: metrics·behavior = 출발 HPA autoscaling/v2 원문 (metrics 가 있으면 cpuPct 대신 그것을 그린다)
  scale: z.object({ min: z.number().int().min(0), max: z.number().int().min(0), cpuPct: z.number().int().optional(),
    metrics: z.array(K8sObj).optional(), behavior: K8sObj.optional() }).strict().optional(),
  // CV-1: PodDisruptionBudget (출발 값 그대로). 셀렉터는 차트가 이 워크로드 라벨로
  disruption: z.object({
    name: Name, minAvailable: z.union([z.number().int(), z.string()]).optional(), maxUnavailable: z.union([z.number().int(), z.string()]).optional(),
    unhealthyPodEvictionPolicy: z.enum(["IfHealthyBudget", "AlwaysAllow"]).optional(),
  }).strict().optional(),
  // CV-1: 파드 배치 원문 (nodeSelector·tolerations·affinity·topologySpreadConstraints·priorityClassName)
  scheduling: z.object({
    nodeSelector: z.record(z.string(), z.string()).optional(), tolerations: z.array(K8sObj).optional(), affinity: K8sObj.optional(),
    topologySpreadConstraints: z.array(K8sObj).optional(), priorityClassName: z.string().optional(),
  }).strict().optional(),
  host: z.object({ network: z.boolean().optional(), pid: z.boolean().optional(), ipc: z.boolean().optional() }).strict().optional(),   // CV-1: hostNetwork·hostPID·hostIPC
  podAnnotations: z.record(z.string(), z.string()).optional(),   // CV-1: 파드 템플릿 annotation (허용 목록 키만)
  serviceAccount: z.object({ name: Name, create: z.boolean(), annotations: z.record(z.string(), z.string()).optional() }).strict().optional(),
  securityContext: z.object({ pod: K8sObj.optional(), container: K8sObj.optional() }).strict().optional(),
  initContainers: z.array(ChartContainer).optional(),
  sidecars: z.array(ChartContainer).optional(),
  // CM-2·CM-3: mountPath 가 있을 때만 차트가 마운트한다. 마운트 원문(volumes·volumeMounts)이 있는 워크로드는 Builder 가 mountPath 를 안 넣음
  configs: z.array(z.object({ name: Name, data: z.record(z.string(), z.string()), mountPath: z.string().min(1).optional() }).strict()).optional(),
  secretMounts: z.array(z.object({ name: Name, secretName: Name, mountPath: z.string() }).strict()).optional(),
  pvcs: z.array(z.object({
    name: Name, size: z.string(), mountPath: z.string().min(1).optional(), accessModes: z.array(z.string()).min(1), storageClassName: z.string().optional(),
    claimTemplate: z.boolean().optional(),            // D6: StatefulSet volumeClaimTemplates (파드마다 PVC). 차트가 따로 PVC 를 안 만듦
  }).strict()).optional(),
  // D6 DRAFT(ai): 출발 워크로드 종류 그대로 (없으면 Deployment). statefulSet = serviceName·podManagementPolicy·PVC 보존 정책
  workloadKind: z.enum(["statefulset", "daemonset"]).optional(),
  statefulSet: z.object({ serviceName: z.string(), podManagementPolicy: z.enum(["OrderedReady", "Parallel"]).optional(),
    pvcRetention: z.object({ whenDeleted: z.enum(["Retain", "Delete"]).optional(), whenScaled: z.enum(["Retain", "Delete"]).optional() }).strict().optional() }).strict().optional(),
  podLabels: z.record(z.string(), z.string()).optional(),   // PL-2: 출발 파드 라벨 (플랫폼 라벨과 겹치면 플랫폼 우선)
  volumes: z.array(K8sObj).optional(),                // k8s 볼륨 그대로 (pvcs·configs·secretMounts 로 못 그리는 것)
  volumeMounts: z.array(VolumeMount).optional(),      // 주 컨테이너 마운트 원문
  job: z.object({
    schedule: z.string(),
    timeZone: z.string().optional(),
    concurrencyPolicy: z.enum(["Allow", "Forbid", "Replace"]).optional(),
    suspend: z.boolean().optional(),
    backoffLimit: z.number().int().optional(),
    activeDeadlineSeconds: z.number().int().optional(),
    restartPolicy: z.enum(["OnFailure", "Never"]).optional(),
  }).strict().optional(),
}).strict();
export type ChartWorkload = z.infer<typeof ChartWorkload>;

// 앱 비밀: 비밀 하나 = ExternalSecret 하나 (target 이름 = IR 비밀 이름 그대로 → 앱이 보는 이름 수정 0).
//   keys 가 있으면 키마다 remoteRef.property, 비면 dataFrom.extract (원격 JSON 통째)
export const ChartSecret = z.object({
  name: Name,
  remoteKey: z.string(),
  keys: z.array(z.string()),
  type: z.string().optional(),
  decode: z.array(z.string()).optional(),             // base64 로 저장된 키 (ESO decodingStrategy)
  paired: z.array(z.object({ key: z.string(), component: z.string(), output: z.literal("password") }).strict()).optional(),
}).strict();

// 온프레 DB 이전 (cnpg.yaml·db-tunnel.yaml·sealedsecret.yaml). Builder 는 replication.enabled·role·passwordSecret 만 낸다.
//   validUntil·ensure·certificates·dbTunnel·sealedSecrets 는 워커가 이전마다 더한다
export const ChartPgReplication = z.object({
  enabled: z.boolean(),
  role: Name.optional(),
  passwordSecret: Name.optional(),
  validUntil: z.iso.datetime({ offset: true }).optional(),   // RFC3339. 지나면 이 역할 비밀번호로 못 붙는다
  ensure: z.enum(["present", "absent"]).optional(),          // 정리: absent 로 한 번 배포해 역할을 지운 뒤 칸을 뺀다
}).strict();
export const ChartPgCertificates = z.object({ serverCASecret: Name, serverTLSSecret: Name }).strict();
export type ChartPgCertificates = z.infer<typeof ChartPgCertificates>;
// 이전 동안만 사는 SSH DB 터널 (deploy/helm/onprem-db-tunnel 과 같은 모양). Service 이름 db-tunnel
export const ChartDbTunnel = z.object({
  relay: z.object({
    host: z.string().regex(/^[A-Za-z0-9.-]+$/),
    port: z.number().int().min(1).max(65535).optional(),   // 기본 22
    knownHosts: z.string().min(1),                          // 중계 호스트 키 고정 (처음 보는 키 거부)
  }).strict(),
  keySecret: Name,                                          // 키 id = 개인키
  forward: z.object({ target: z.string().regex(/^[A-Za-z0-9.-]+:5432$/) }).strict(),
  reverse: z.object({ enabled: z.boolean(), cnpgName: Name.optional() }).strict().optional(),
  image: z.string().regex(/@sha256:[0-9a-f]{64}$/),         // 다이제스트 고정
}).strict();
export type ChartDbTunnel = z.infer<typeof ChartDbTunnel>;
// 봉인 비밀 (bitnami SealedSecret, strict 범위 = 이름·네임스페이스에 묶임). 값은 암호문만
export const ChartSealedSecret = z.object({
  name: Name, type: z.string().optional(),
  encryptedData: z.record(z.string(), z.string().min(1)).refine((m) => Object.keys(m).length > 0, "encryptedData 가 비었다"),
}).strict();
export type ChartSealedSecret = z.infer<typeof ChartSealedSecret>;

export const ChartPostgres = z.discriminatedUnion("mode", [
  // 클라우드 관리형 DB: 접속 주소·비밀 위치만. 비밀은 ESO 로 secretName 에 받는다
  z.object({
    id: z.string(), mode: z.literal("external"),
    host: z.string(), port: z.number().int(),
    passwordSecret: z.string(), passwordProperty: z.string().optional(),
    secretName: Name,
  }).strict(),
  // 온프레: 차트가 CNPG Cluster 를 만든다
  z.object({
    id: z.string(), mode: z.literal("cnpg"), name: Name,
    instances: z.number().int().min(1),
    majorVersion: z.string().nullable(),
    storageGb: z.number().int().nullable(),
    parameters: z.record(z.string(), z.string()).optional(),
    resources: K8sObj.optional(),
    // DB 이전용 (cnpg.yaml 머리 주석). 이전 전용 역할 하나: role 기본 svc_migrate, passwordSecret 기본 <name>-migrate, ensure 기본 present
    replication: ChartPgReplication.optional(),
    certificates: ChartPgCertificates.optional(),               // 플랫폼이 준 서버 CA·TLS 비밀 → Cluster spec.certificates (워커가 이전마다 넣음)
    host: z.string(), port: z.number().int(), passwordSecret: Name,
    walStorageGb: z.number().int().optional(),                  // DM-8: cnpg.yaml walStorage
    database: z.string().optional(), owner: z.string().optional(),   // DBN-1·E10-2: bootstrap.initdb
  }).strict(),
]);
export type ChartPostgres = z.infer<typeof ChartPostgres>;

export const ChartIngressPath = z.object({
  path: z.string(), pathType: z.enum(["Prefix", "Exact"]), service: Name, port: z.number().int(), workload: z.string(),
}).strict();
export const ChartIngress = z.object({
  mode: z.enum(["cloudflared", "lb"]),
  className: z.string(),
  tunnelTokenSecret: z.string(),
  hosts: z.array(z.object({ hostnames: z.array(z.string()).min(1), tls: z.boolean().optional(), paths: z.array(ChartIngressPath) }).strict()),
  // 트래픽 판정 지표 (#245). cloudflared 가 응답 수를 127.0.0.1 이 아닌 파드 주소 :2000 에 내고, 고객 클러스터의 수집기
  //   (deploy/helm/onprem-agent metrics)가 파드 표시(svc.platform/*)를 보고 긁어 svc_ingress_requests_total{env,migration,code} 로 보낸다.
  //   collectorNamespace = 그 수집기 네임스페이스. :2000 은 거기서만 들어올 수 있다 (차트 ingress.yaml NetworkPolicy)
  metrics: z.object({
    migration: z.string().regex(/^[0-9a-f-]{36}$/i),
    env: z.enum(["source", "target"]),
    collectorNamespace: Name.optional(),
  }).strict().optional(),
}).strict();

export const ChartValues = z.object({
  app: z.object({ name: Name }).strict(),
  namespace: Name,
  labels: z.record(z.string(), z.string()),
  // J-1: 누가 잡을 돌리나. 기본(없음) = source → 도착 CronJob 은 멈춰 둔다 (두 곳에서 같이 돌지 않게). 컷오버 때 target
  jobOwner: z.enum(["source", "target"]).optional(),
  workloads: z.array(ChartWorkload),
  identities: z.array(z.object({ id: z.string(), serviceAccount: z.string(), workloads: z.array(z.string()) }).strict()).optional(),
  externalSecrets: z.object({
    store: z.object({ kind: z.enum(["ClusterSecretStore", "SecretStore"]), name: z.string() }).strict(),
    secrets: z.array(ChartSecret),
  }).strict(),
  postgres: z.array(ChartPostgres).optional(),
  dbTunnel: ChartDbTunnel.optional(),                       // 온프레 DB 이전 터널 (워커가 이전마다, 차트 db-tunnel.yaml)
  sealedSecrets: z.array(ChartSealedSecret).optional(),     // 봉인 비밀 (워커가 이전마다, 차트 sealedsecret.yaml)
  ingress: ChartIngress.optional(),
  // W3: 온프레 바닥(할당량)을 git 으로. enabled 는 배포 때 채우는 자리표시(<env:onpremFloorViaGit>) → "1"/"0". 차트 floor.yaml
  floor: z.object({
    enabled: z.string(),
    quota: z.object({ cpuMilli: z.number().int().positive().optional(), memoryMi: z.number().int().positive().optional() }).strict(),
  }).strict().optional(),
  warnings: z.array(z.string()),
  // 배포 단계가 더하는 칸 (Builder 는 안 냄): 트래픽 기록·진행 기한
  traffic: z.object({ role: z.string(), weightPct: z.number(), approvedSteps: z.array(z.number()) }).strict().nullable().optional(),
  progressDeadlineSeconds: z.number().int().optional(),
}).strict();
export type ChartValues = z.infer<typeof ChartValues>;
