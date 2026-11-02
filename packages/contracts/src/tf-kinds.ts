import { z } from "zod";

// DRAFT(ai): 도착 Terraform 루트가 받는 종류별 변수 모양. 설계 27번 3.1·4.2(A0·A0b).
//   루트 변수 `<종류>_json` 문자열 안의 항목 하나 = 이 스키마. HCL variable validation 과 같은 이름·같은 모양.
//   원칙: IR 의 선택 칸은 .nullable() 로 받고, HCL 은 null 이면 상품 기본값을 쓴다. 어댑터가 값을 지어내지 않는다(재현성).
//   목록·맵은 지금 규칙대로 `*_json` 문자열(TfVars 는 평평한 값만 허용). 이 파일은 spec-v2.ts 를 고치지 않으려고 id 규칙을 같게 다시 적는다.
const TfId = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/);

// ── Postgres ──────────────────────────────────────────
export const PostgresTfVars = z.object({
  id: TfId,
  name: z.string(),                                  // 도착 인스턴스 이름 (dbInstanceName 재사용, 이전마다 해시)
  major_version: z.string(),
  storage_gb: z.number().int(),
  storage_max_gb: z.number().int().nullable(),
  instance_class: z.string().nullable(),             // IR compute 에서 고름. 못 고르면 null
  ha: z.boolean().nullable(),
  read_replicas: z.number().int().nullable(),
  parameters_json: z.string(),                       // IR parameters 그대로 ("{}" 가능)
  logical_replication: z.literal(true),              // CDC 이전이라 도착은 항상 켬 (출발 값과 무관한 플랫폼 요구)
  allow_from_json: z.string(),                       // 의존성 connect 의 from 신원 + posture ingress(mirror)
  public: z.boolean(),                               // posture public (mirror) 또는 데모 DB_PUBLIC
  peer_cidrs_json: z.string(),                       // 데모 db-network.ts 가 채우던 값
  public_subnet_ids_json: z.string().nullable(),     // aws 만
  // DRAFT(ai): deletion_protection 은 IR 에 없는 플랫폼 값. 데모 정리(disposable) 때 false
  deletion_protection: z.boolean(),
}).strict();
export type PostgresTfVars = z.infer<typeof PostgresTfVars>;

// ── 네임스페이스 · 신원 ───────────────────────────────
export const NamespaceTfVars = z.object({
  name: z.string(),
  quota_cpu_m: z.number().int().nullable(),
  quota_memory_mi: z.number().int().nullable(),
}).strict();
export type NamespaceTfVars = z.infer<typeof NamespaceTfVars>;

export const IdentityTfVars = z.object({
  id: TfId,                          // IR service/job id
  name: z.string(),                  // boundedName({ prefix: "app-", max: aws 64 / gcp 30 }) — 실행 역할 이름 규칙
  service_account: z.string(),       // k8s SA 이름 (IR serviceAccount 그대로)
  secret_names_json: z.string(),
  // A8 DRAFT(ai): 출발 IAM 권한을 도착 모양으로 바꾼 목록(JSON). aws = 문장(effect·actions·star·targets{kind,id,paths}),
  //   gcp = 자원 단위 바인딩(kind·target·role·scope). 자원은 IR id → root 가 모듈 출력(ARN·이름)으로 채움. 없으면 칸 없음
  grants_json: z.string().optional(),
}).strict();
export type IdentityTfVars = z.infer<typeof IdentityTfVars>;

// ── A0b: 캐시 · 오브젝트 스토리지 · 큐 · 잡 ───────────
// DRAFT(ai): 칸 이름은 spec-v2.ts 의 props 를 snake_case 로 옮김. 모르는 값은 null(HCL 이 상품 기본값 또는 거부).
export const CacheTfVars = z.object({
  id: TfId,
  name: z.string(),
  engine: z.enum(["redis", "valkey", "memcached"]),
  version: z.string().nullable(),
  memory_mib: z.number().int().nullable(),
  cluster_mode: z.boolean().nullable(),
  shards: z.number().int().nullable(),
  tls: z.boolean().nullable(),
  auth: z.boolean().nullable(),
  ha: z.boolean().nullable(),
  allow_from_json: z.string(),       // 의존성 from 신원 (캐시는 공개 안 함)
}).strict();
export type CacheTfVars = z.infer<typeof CacheTfVars>;

export const ObjectStoreTfVars = z.object({
  id: TfId,
  name: z.string(),                  // 버킷 이름 (전역 유일, 이전마다 해시)
  versioning: z.boolean(),
  public: z.boolean().nullable(),    // null = 모름 → 모듈은 비공개로 만들고 사람에게 묻는다. 공개로 열지 않음
  size_gb: z.number().nonnegative().nullable(),
  lifecycle_json: z.string(),        // IR lifecycle 그대로 ("[]" 가능)
  cors_json: z.string(),             // IR cors 그대로 ("[]" 가능)
  allow_from_json: z.string(),
  // DRAFT(ai): force_destroy 는 IR 에 없는 플랫폼 값. 데모 정리(disposable) 때 true
  force_destroy: z.boolean(),
}).strict();
export type ObjectStoreTfVars = z.infer<typeof ObjectStoreTfVars>;

export const QueueTfVars = z.object({
  id: TfId,
  name: z.string(),
  model: z.enum(["queue", "topic"]),
  ordered: z.boolean().nullable(),
  retention_sec: z.number().int().nullable(),
  ack_timeout_sec: z.number().int().nullable(),
  dead_letter_to: TfId.nullable(),   // 같은 명세 안의 다른 queue id
  dead_letter_max_receive: z.number().int().nullable(),
  allow_from_json: z.string(),
}).strict();
export type QueueTfVars = z.infer<typeof QueueTfVars>;

// 관리형 컨테이너 런타임의 예약 잡(ECS scheduled task, Cloud Run job). k8s 잡은 Helm 값이라 여기 안 옴
export const JobTfVars = z.object({
  id: TfId,
  name: z.string(),
  schedule: z.string(),              // cron 5필드 (IR 그대로). 클라우드별 표기 변환은 HCL/Builder 몫
  time_zone: z.string().nullable(),
  concurrency_policy: z.enum(["Allow", "Forbid", "Replace"]).nullable(),
  suspend: z.boolean().nullable(),
  backoff_limit: z.number().int().nullable(),
  active_deadline_sec: z.number().int().nullable(),
  restart_policy: z.enum(["OnFailure", "Never"]).nullable(),
  image: z.string(),                 // 도착 레지스트리 주소 + digest
  command_json: z.string().nullable(),
  args_json: z.string().nullable(),
  cpu_milli: z.number().int().nullable(),
  mem_mib: z.number().int().nullable(),
  env_json: z.string(),              // 값 확정된 env 목록 + <tf-output:…> 자리표시
  identity: TfId,                    // 실행 역할을 가진 identity 인스턴스 id
}).strict();
export type JobTfVars = z.infer<typeof JobTfVars>;

// I9: 관리형 컨테이너 서비스 (ECS Fargate 서비스 · Cloud Run 서비스). kinds/service-ecs · kinds/service-cloudrun 이 받는 cfg.
//   TA13: 루트(aws/root·gcp/root)의 service_json 으로 붙음 → TF_KIND_VARS·TF_VAR_KINDS 에 "service". onprem·azure 는 capability 없음(거부)
//   DRAFT(ai): env 값은 Builder 가 확정 못 함(DB 주소·Cloud Run 주소는 같은 apply 안에서 생김) → 조각(parts) 목록으로 넘기고 루트가 합쳐서
//   모듈에는 [{name, value}] 로 넘긴다. ref = "<IR id>.<출력>" (LINK_OUTPUTS 이름). 비밀 값은 안 옴 (도착 저장소 이름만)
export const ServiceEnvPart = z.object({ lit: z.string().nullable(), ref: z.string().regex(/^[a-z][a-z0-9-]{0,39}\.(host|port|url|name|user)$/).nullable() }).strict()
  .refine((p) => (p.lit === null) !== (p.ref === null), "lit·ref 중 하나만");
export const ServiceEnvVar = z.object({ name: z.string().min(1), parts: z.array(ServiceEnvPart) }).strict();
export const ServiceSecretVar = z.object({ name: z.string().min(1), secret: z.string().min(1), key: z.string().min(1) }).strict();
export const ServiceTfVars = z.object({
  id: TfId,
  name: z.string(),                  // 도착 서비스 이름 (ECS 255자·Cloud Run 49자 이하, 이전마다 해시)
  role_name: z.string(),             // TA13: 모듈이 만드는 실행 신원 이름 (aws IAM 역할 app- 64자 / gcp SA account_id app- 30자)
  image: z.string(),
  command_json: z.string().nullable(),
  args_json: z.string().nullable(),
  cpu_milli: z.number().int().nullable(),
  mem_mib: z.number().int().nullable(),
  port: z.number().int().nullable(),           // 받는 포트 하나 (없으면 워커)
  min_instances: z.number().int(),
  max_instances: z.number().int(),
  target_cpu_pct: z.number().int().nullable(), // null = 자동 확장 정책 없음 (min=max 고정)
  health_path: z.string().nullable(),          // HTTP 확인 경로 (readiness http)
  env_json: z.string(),                        // 루트 입력: ServiceEnvVar[] (조각) → 루트가 합쳐 모듈엔 [{name, value}]
  secrets_json: z.string(),                    // ServiceSecretVar[]: secret = 도착 비밀 저장소 이름 (값 아님)
  identity: TfId,                              // 출발 신원(serviceAccount) 묶음 id (화면·대조용. 역할은 서비스마다 role_name)
  public: z.boolean(),                         // 입구(entry)가 이 서비스로 오나. false 면 내부 전용
}).strict();
export type ServiceTfVars = z.infer<typeof ServiceTfVars>;

// 루트 변수 이름(`<이름>_json`) ↔ 항목 스키마. 어댑터·HCL 대조 시험이 이 표를 씀
export const TF_KIND_VARS = {
  postgres: PostgresTfVars,
  namespace: NamespaceTfVars,
  identity: IdentityTfVars,
  cache: CacheTfVars,
  objectStore: ObjectStoreTfVars,
  queue: QueueTfVars,
  job: JobTfVars,
  service: ServiceTfVars,
} as const;
export const TF_VAR_KINDS = ["postgres", "namespace", "identity", "cache", "objectStore", "queue", "job", "service"] as const;
export type TfVarKind = (typeof TF_VAR_KINDS)[number];

// 모듈 내부 출력: 비밀 이름만. link_outputs 에는 안 섞음
export const KIND_INTERNAL_OUTPUTS = { postgres: ["password_secret"], cache: ["auth_secret"] } as const;
