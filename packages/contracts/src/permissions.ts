import { z } from "zod";

// 고객 권한 묶음·차이 (PERM-GATE). 고객 권한을 "실패 뒤 사후 수습"이 아니라 "필요한 단계 전에, 최소 권한으로" 받기 위한 모양.
//   묶음 정의는 손으로 적지 않는다: adapters 권한표·역할 파일·연결 스크립트 목록에서 export-permissions 가 뽑아
//   infra/permissions/permission-bundles.json 으로 낸다 (packages/adapters/src/permissions/bundles.ts). 여기는 경계를 넘는 모양만 둔다.

/** 권한을 쓰는 단계 (worker 단계 역할 STEP_ROLES 를 사람이 읽는 묶음으로 접은 것) */
export const PermissionStage = z.enum(["observe", "plan", "env", "operate", "relay", "deploy", "cleanup", "rollback"]);
export type PermissionStage = z.infer<typeof PermissionStage>;
export const PermissionCloud = z.enum(["aws", "gcp"]);
export type PermissionCloud = z.infer<typeof PermissionCloud>;
/** 묶음이 필요한 조건 (명세·계획에서 계산). always = 그 쪽 클라우드면 늘 */
export const PermissionRequiredWhen = z.enum(["always", "secrets", "postgres", "data", "env_layer_create",
  "relay_aws_onprem", "relay_aws_gcp", "relay_gcp_aws", "argo_hub"]);
export type PermissionRequiredWhen = z.infer<typeof PermissionRequiredWhen>;

export const PermissionBundle = z.object({
  id: z.string().regex(/^(aws|gcp)\.[a-z0-9.]+$/),
  cloud: PermissionCloud,
  stage: PermissionStage,
  // both = 같은 역할을 출발·도착 어느 쪽으로 쓰든 (AWS 관찰 역할은 환경 계정 안 하나)
  side: z.enum(["source", "target", "both"]),
  // 고객 쪽 주체: GCP = SA 짧은 이름(svc-env …) 또는 platform(이 회사 전용 플랫폼 SA), AWS = 역할 이름(svc-operate …)
  principal: z.string().min(1).max(64),
  // GCP = 커스텀 역할 ID(platform_env …), AWS = 정책 이름(svc-operate-policy·relay·observe-extra …)
  role: z.string().min(1).max(64),
  conditional: z.boolean(),           // 조건부 바인딩으로만 주는 역할 (GCP _iam·_db_secret)
  permissions: z.array(z.string().min(1).max(120)).max(400),
  apis: z.array(z.string().min(1).max(80)).max(40),   // GCP 만: 그 프로젝트에 켜져 있어야 하는 API
  requiredWhen: z.array(PermissionRequiredWhen).min(1).max(5),   // 하나라도 맞으면 필요
}).strict();
export type PermissionBundle = z.infer<typeof PermissionBundle>;

/** 권한 묶음 파일 (infra/permissions/permission-bundles.json). version = 권한 판 (연결 스크립트·템플릿에 같은 번호가 박힌다) */
export const PermissionBundleFile = z.object({
  version: z.number().int().positive(),
  bundles: z.array(PermissionBundle).max(60),
}).strict();
export type PermissionBundleFile = z.infer<typeof PermissionBundleFile>;

/** 고치는 법: GCP = 빠진 묶음만 맞추는 Cloud Shell 링크 + 명령, AWS = 연결 스택 업데이트(새 템플릿 판, 기존 매개변수 그대로) 링크 + 명령.
 *  명령에는 비밀값·계정 번호를 넣지 않는다 */
export const PermissionFix = z.object({
  kind: z.enum(["cloudshell", "cloudformation", "command"]),
  url: z.string().max(4000).optional(),
  command: z.string().max(4000),
}).strict();
export type PermissionFix = z.infer<typeof PermissionFix>;

export const PermissionGap = z.object({
  bundleId: z.string().max(80),
  envId: z.uuid(),
  cloud: PermissionCloud,
  stage: PermissionStage,
  side: z.enum(["source", "target", "both"]),
  principal: z.string().max(64),
  role: z.string().max(64),
  requiredWhen: z.array(PermissionRequiredWhen).min(1).max(5),
  // block = 빠졌음이 확인됨 (이대로면 그 단계가 403), warn = 확인 못 함·흉내 평가가 자원 모양에 기대는 판정
  level: z.enum(["block", "warn"]),
  missing: z.array(z.string().max(120)).max(400),       // 고객 역할에 없는 권한 (권한표에는 있음 → 고치는 링크로 해결)
  missingApis: z.array(z.string().max(80)).max(40),
  // 권한표에도 없는 권한 (apply 403 안전망이 로그에서 찾은 것). 고객 링크로는 안 고쳐진다 → 플랫폼이 권한표를 고치고 판을 올린다
  notInTable: z.array(z.string().max(120)).max(100).optional(),
  unverified: z.string().max(300).optional(),           // 확인 못 한 이유 (관찰 역할이 역할 정의를 못 읽음 등)
  grantedVersion: z.number().int().nonnegative().nullable(),
  requiredVersion: z.number().int().positive(),
  fix: PermissionFix.optional(),                        // api 가 채운다 (링크 설정은 api 에만 있다)
}).strict();
export type PermissionGap = z.infer<typeof PermissionGap>;

/** 환경 화면의 권한 상태: 마지막 확인 결과 + 빠진 묶음 전부를 한 번에 맞추는 고치는 법 */
export const EnvPermissions = z.object({
  envId: z.uuid(),
  checkedAt: z.string().nullable(),
  refreshing: z.boolean(),
  requiredVersion: z.number().int().positive(),
  grantedVersion: z.number().int().nonnegative().nullable(),
  gaps: z.array(PermissionGap).max(60),
  error: z.string().max(300).optional(),                // 확인 자체를 못 함 (연결 안 됨·관찰 역할 못 빌림 …)
  fix: PermissionFix.optional(),
}).strict();
export type EnvPermissions = z.infer<typeof EnvPermissions>;

/** 저장 모양 (environment_permissions.result). worker 가 쓰고 api 가 읽는다 */
export const StoredPermissionCheck = z.object({
  requiredVersion: z.number().int().positive(),
  grantedVersion: z.number().int().nonnegative().nullable(),
  gaps: z.array(PermissionGap).max(60),
  error: z.string().max(300).optional(),
}).strict();
export type StoredPermissionCheck = z.infer<typeof StoredPermissionCheck>;

export const PermissionCheckAccepted = z.object({
  envId: z.uuid(),
  queued: z.boolean(),        // false = 같은 환경 확인이 이미 도는 중
}).strict();
export type PermissionCheckAccepted = z.infer<typeof PermissionCheckAccepted>;

export const PermissionsQuery = z.object({
  // 고치는 링크를 이 묶음들로 (이전 사전 점검이 막힌 묶음). 비우면 마지막 확인의 빠진 묶음 전부
  bundles: z.string().max(1000).regex(/^[a-z0-9.,]*$/).optional(),
}).strict();
export type PermissionsQuery = z.infer<typeof PermissionsQuery>;
