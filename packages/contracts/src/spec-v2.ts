import { z } from "zod";
import { BuildPlan } from "./build.js";

// DRAFT(ai): 공통 명세(IR) v2. 리소스(components) + 의존성(links) + 라우팅(entry) + 보안 기준선(posture).
//   설계 20번 4장 스케치 + 24번 I1 + 3.5장 R1~R3. 이름·상한·종류 목록은 팀 검토 대상.
//   규칙: Zod 는 모양만(transform·preprocess·refine·default 안 씀 → toJSONSchema 가 그대로 뽑힘).
//   의미 검증(참조·중복·의도·벤더 주소)은 전부 spec-v2-check.ts 의 checkV2.
//   없는 값은 비우거나 null. 기본값을 지어내지 않는다(재현성).
//   v1(spec.ts) 은 안 건드린다. 이름이 겹치지 않게 일반 이름에는 V2 를 붙인다.

// ── 공통 조각 ─────────────────────────────────────────
// id: 글자로 시작, 소문자·숫자·하이픈, 40자 이하 (DNS 라벨에 넣을 수 있게)
const Id = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/);
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
const Amount = z.object({
  cpuMilli: z.number().int().min(1).max(64000).nullable(),
  memMiB: z.number().int().min(1).max(262144).nullable(),
}).strict();
const Resources = z.object({ request: Amount.optional(), limit: Amount.optional() }).strict();
const PortSpec = z.object({ name: z.string().optional(), port: Port, protocol: Protocol.optional() }).strict();
const Timing = {
  periodSec: z.number().int().optional(),
  failureThreshold: z.number().int().optional(),
  initialDelaySec: z.number().int().optional(),
};
const Probe = z.discriminatedUnion("type", [
  z.object({ type: z.literal("http"), path: z.string().optional(), port: z.union([Port, z.string()]), scheme: z.enum(["HTTP", "HTTPS"]).optional(), ...Timing }).strict(),
  z.object({ type: z.literal("tcp"), port: z.union([Port, z.string()]), ...Timing }).strict(),
  z.object({ type: z.literal("grpc"), port: Port, ...Timing }).strict(),
  z.object({ type: z.literal("exec"), command: z.array(z.string()), ...Timing }).strict(),
]);

// 의존성 출력 이름. 도착 모듈이 이 이름으로 값을 낸다 (어댑터가 import 해서 씀)
// DRAFT(ai): 표는 설계 20번 4.5 / PoC OUTPUTS_OK 그대로
export const LINK_OUTPUTS = {
  postgres: ["host", "port", "url", "user"],
  cache: ["host", "port", "url"],
  objectStore: ["name", "url"],
  queue: ["url", "name"],
  service: ["host", "port", "url"],
} as const satisfies Record<string, readonly string[]>;
export const LinkOutputV2 = z.enum(["host", "port", "url", "name", "user"]);
export type LinkOutputV2 = z.infer<typeof LinkOutputV2>;

// 환경변수: 값 하나는 아래 출처 중 하나. 벤더 주소였던 값은 fromLink·template 으로 바꿔 적는다
const EnvVar = z.union([
  z.object({ name: EnvName, value: z.string() }).strict(),
  z.object({ name: EnvName, template: z.string() }).strict(),          // "rediss://${shop-cache.host}:6379"
  z.object({ name: EnvName, fromResource: z.string() }).strict(),      // limits.cpu 같은 자원 값
  z.object({ name: EnvName, fromSecret: z.object({ secret: z.string(), key: z.string() }).strict() }).strict(),
  z.object({ name: EnvName, fromConfig: z.object({ config: z.string(), key: z.string() }).strict() }).strict(),
  z.object({ name: EnvName, fromField: z.string() }).strict(),         // metadata.namespace 같은 파드 정보
  z.object({ name: EnvName, fromLink: z.object({ to: Id, output: LinkOutputV2 }).strict() }).strict(),
]);
export type EnvVarV2 = z.infer<typeof EnvVar>;
const EnvFrom = z.union([
  z.object({ config: z.string(), prefix: z.string() }).strict(),
  z.object({ secret: z.string(), prefix: z.string() }).strict(),
]);
// 설정 묶음(ConfigMap 등): 내용 해시로 "출발과 같은가"를 판 비교에서 본다
const Config = z.object({ name: z.string(), data: Str, sha256: z.string(), mountPath: z.string().optional() }).strict();

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
}).strict();

// service·job 공통
const Workload = {
  namespace: z.string().optional(),                   // k8s 출발이면 있음
  image: ImageV2,
  command: z.array(z.string()).max(50).optional(),
  args: z.array(z.string()).max(100).optional(),
  resources: Resources,
  env: z.array(EnvVar).max(200),
  envFrom: z.array(EnvFrom).max(20).optional(),
  configs: z.array(Config).max(20).optional(),
  secretMounts: z.array(z.object({ secret: z.string(), mountPath: z.string() }).strict()).max(20).optional(),
  serviceAccount: z.string(),                         // 출발 신원 이름. 안 적혔으면 k8s 규칙대로 "default"
  securityContext: z.record(z.string(), z.unknown()).optional(),
  sidecars: z.array(Container).max(5).optional(),
  initContainers: z.array(Container).max(5).optional(),
  volumes: z.array(z.object({
    name: z.string(), mountPath: z.string(), sizeGb: z.number().optional(),
    access: z.enum(["RWO", "RWX", "ROX"]).optional(),
  }).strict()).max(10).optional(),
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
    ports: z.array(PortSpec).max(10).optional(),        // 없을 수 있다 (워커)
    endpoints: z.array(z.object({                       // k8s Service 객체 (파드 앞 고정 주소)
      name: z.string(),
      type: z.enum(["ClusterIP", "NodePort", "LoadBalancer", "Headless"]),
      ports: z.array(z.object({
        name: z.string().optional(), port: Port, targetPort: z.union([Port, z.string()]), protocol: Protocol,
      }).strict()),
    }).strict()).max(5).optional(),
    probes: z.object({ readiness: Probe.optional(), liveness: Probe.optional(), startup: Probe.optional() }).strict().optional(),
    replicas: z.object({ min: z.number().int().min(0).max(100), max: z.number().int().min(0).max(100) }).strict(),   // max 0 = 0으로 줄여 둔 서비스 (재현성: 그대로 가져옴, checkV2 가 검토 표시)
    scale: z.object({ targetCpuPct: z.number().int().min(1).max(100) }).strict().optional(),
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

const PostgresV2 = z.object({
  id: Id, kind: z.literal("postgres"),
  props: z.object({
    // DRAFT(ai): R3 — CNPG·Cloud SQL 에서 못 읽을 수 있어 nullable. 못 읽으면 가져오기가 검토 표시
    majorVersion: z.string().regex(/^\d{1,2}$/).nullable(),
    storageGb: z.number().int().min(1).max(65536).nullable(),   // v1 의 100 자르기 없앰
    storageMaxGb: z.number().int().optional(),
    compute: Amount.optional(),
    ha: z.boolean().optional(),
    readReplicas: z.number().int().min(0).max(15).optional(),
    databases: z.array(z.string()).max(50).optional(),
    extensions: z.array(z.string()).max(100).optional(),
    parameters: Str.optional(),
    logicalReplication: z.boolean().optional(),
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
  }).strict(),
}).strict();

const ObjectStoreV2 = z.object({
  id: Id, kind: z.literal("objectStore"),
  props: z.object({
    versioning: z.boolean(),
    public: z.boolean().nullable(),                     // null = 모름. 모듈은 null 을 공개로 열지 않고 사람에게 묻는다
    sizeGb: z.number().nonnegative().nullable(),
    lifecycle: z.array(z.object({
      prefix: z.string(), expireDays: z.number().int().optional(), toColdAfterDays: z.number().int().optional(),
    }).strict()).max(50).optional(),
    cors: z.array(z.record(z.string(), z.unknown())).optional(),
  }).strict(),
}).strict();

const QueueV2 = z.object({
  id: Id, kind: z.literal("queue"),
  props: z.object({
    model: z.enum(["queue", "topic"]),                  // SQS = queue, Pub/Sub·SNS = topic
    ordered: z.boolean().optional(),
    retentionSec: z.number().int().min(60).max(2678400).optional(),
    ackTimeoutSec: z.number().int().optional(),
    deadLetter: z.object({ to: Id.optional(), maxReceive: z.number().int().optional() }).strict().optional(),
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
  grants: z.array(Grant).max(50).optional(),
}).strict();
export type LinkV2 = z.infer<typeof LinkV2>;

// ── 라우팅 (Gateway API HTTPRoute Standard 필드 모양) ──────
const Match = z.object({
  path: z.object({ type: z.enum(["Exact", "PathPrefix"]), value: z.string().startsWith("/") }).strict(),
  headers: z.array(z.object({ name: z.string(), value: z.string() }).strict()).max(8).optional(),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]).optional(),
}).strict();
const Route = z.object({
  matches: z.array(Match).min(1).max(8),
  backends: z.array(z.object({ to: Id, port: Port, weight: z.number().int().min(0).max(1_000_000) }).strict()).min(1).max(4),
}).strict();
const EntryHost = z.object({
  hostnames: z.array(z.string()).min(1).max(10),
  tls: z.object({ mode: z.enum(["terminate", "passthrough"]), source: z.string().optional() }).strict().optional(),
  routes: z.array(Route).max(20),
}).strict();
export const EntriesV2 = z.object({
  via: z.literal("cloudflare-lb"),
  hosts: z.array(EntryHost).min(1).max(10),            // 라우팅이 없으면 entry 자체를 뺀다
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
  }).strict()).max(200),
  network: z.array(z.discriminatedUnion("scope", [
    z.object({
      scope: z.literal("namespace"), namespace: z.string(), mode: Mode,
      policies: z.array(z.string()),
      default: z.enum(["allow-all", "as-declared"]),
    }).strict(),
    z.object({
      scope: z.literal("component"), subject: Id, mode: Mode,
      ingress: z.union([z.array(z.object({ from: z.string(), port: Port.optional() }).strict()), z.literal("unknown")]),
      public: z.boolean().nullable(),
    }).strict(),
  ])).max(50),
}).strict();
export type PostureV2 = z.infer<typeof PostureV2>;

// ── 최상위 ────────────────────────────────────────────
export const AppSpecV2 = z.object({
  schemaVersion: z.literal("2"),
  app: z.object({ name: Id }).strict(),
  availability: z.enum(["singleZone", "multiZone"]).optional(),   // 출발에서 읽은 경우만
  components: z.array(ComponentV2).min(1).max(30),
  links: z.array(LinkV2).max(100),
  entry: EntriesV2.optional(),
  posture: PostureV2,
  security: z.unknown().optional(),                     // 보안 명세 파트 자리. 일반 IR 은 비워 둔다
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
  included: z.array(z.string().max(300)).max(200).optional(),                  // BOUNDPULL: 사람이 끌어온 자원("<원본종류>:<이름>"). 재가져오기 때도 경계 안 유지
  ids: z.record(z.string(), Id),                        // 벤더 고유 키 → id. 재가져오기 때 같은 id 유지
  environment: z.array(z.unknown()).optional(),         // 근거·환경 종류로 읽은 항목 (매퍼 몫)
}).strict();
export type ImportResultV2 = z.infer<typeof ImportResultV2>;

// checkV2 가 내는 "사람 승인 필요" 줄. 계획서 확인 항목(acknowledgements)으로 간다
export const ApprovalRowV2 = z.object({
  kind: z.enum(["runtime_change", "build"]),
  subject: Id,                                          // 리소스 id
  from: z.string().optional(),
  to: z.string().optional(),
  detail: z.string().optional(),
}).strict();
export type ApprovalRowV2 = z.infer<typeof ApprovalRowV2>;
