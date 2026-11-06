import { z } from "zod";
import { Provider } from "./common.js";

// 환경 연결 상태 8개
export const ConnectionStatus = z.enum([
  "draft", "awaiting_customer", "verifying", "connected",
  "unstable", "failed", "expired", "disconnected",
]);
export type ConnectionStatus = z.infer<typeof ConnectionStatus>;

// 화면이 받는 환경 한 개
export const EnvironmentView = z.object({
  id: z.uuid(),
  provider: Provider,
  name: z.string(),
  connectionStatus: ConnectionStatus,
  accountId: z.string().nullable(),     // 고객 계정 번호 (확인 뒤)
  // 결정 3번 A안: GCP 이전 전용 프로젝트 ID (도착 자원·실행 역할은 여기만). 값이 있을 때만 칸이 붙는다 (옛 응답과 글자 그대로)
  targetProjectId: z.string().optional(),
  lastVerifiedAt: z.string().nullable(),
  failureReason: z.string().nullable(), // 예: 권한 부족 + 동작 이름. 모양은 ConnectionFailure 또는 "PERMISSION_MISSING:<동작>"
  // VERIFYAPI: 마지막 연결 확인(사람 요청)이 남긴 "사람이 할 일" (OBSROLE3, environments.verify_detail).
  //   연결은 됐지만 관찰 역할에 선택 권한이 빠진 경우만 칸이 붙는다. 없으면 칸 자체가 없음 (전 응답과 글자 그대로)
  missingPermissions: z.array(z.string().max(300)).max(100).optional(),   // 빠진 권한 이름 (GCP 권한 이름 등)
  needsHuman: z.array(z.string().max(300)).max(100).optional(),           // 고객이 할 일 한 줄씩 (예: 연결 스크립트 다시 실행)
  // RV-24: 마지막 확인이 흉내 자격(클라우드 안 읽음)으로 닫혔으면 true. 진짜 확인이면 칸 자체가 없음
  mock: z.literal(true).optional(),
  // PERM-GATE: 마지막 권한 확인에서 빠진 묶음 수 (확인한 적 없으면 칸이 없음). 자세한 것은 GET /environments/:id/permissions
  permissionGaps: z.number().int().nonnegative().optional(),
}).strict();
export type EnvironmentView = z.infer<typeof EnvironmentView>;

// 연결 확인 실패 사유 (설계 IA 6.4 실패 사유 + 링크 만료 + 쿠버네티스 접근 없음).
// 화면에 줄 때는 "PERMISSION_MISSING:<동작>"처럼 뒤에 붙일 수 있어 EnvironmentView.failureReason은 문자열로 둔다
export const ConnectionFailure = z.enum([
  "ROLE_ASSUME_DENIED", "PERMISSION_MISSING", "ORG_POLICY_BLOCKED",
  "ROLE_NOT_FOUND", "LINK_EXPIRED", "K8S_ACCESS_MISSING",
  "ACCOUNT_MISMATCH",   // L7i: GCP 프로젝트 번호가 처음 확인한 값과 다름
  // PF01: 플랫폼 쪽 문제 (고객이 고칠 것 없음, 운영자가 고친 뒤 다시 확인). 예전엔 verifying 에 영영 남았다
  "PLATFORM_CREDENTIALS_INVALID",   // 워커 자기 AWS 자격 만료·무효 (SSO 만료 등)
  "PLATFORM_CLI_MISSING",           // 워커에 aws 명령 없음
  "PLATFORM_ERROR",                 // 그 밖의 오류로 재시도를 다 씀
]);
export type ConnectionFailure = z.infer<typeof ConnectionFailure>;

// 환경 만들기 본문 (POST /environments). 이름 중복은 라우트가 409로 막는다 (DB 유일 색인 없음)
export const CreateEnvironmentBody = z.object({
  provider: Provider,
  // DRAFT(ai): 이름 64자, 리전 32자, 클러스터 이름 100자 상한. 화면 표시·DB 칸 길이를 생각한 임시값
  name: z.string().trim().min(1).max(64),
  region: z.string().max(32).optional(),
  clusterName: z.string().max(100).optional(),
}).strict();
export type CreateEnvironmentBody = z.infer<typeof CreateEnvironmentBody>;

// 연결 확인 요청 본문 (고객이 계정 번호를 입력). 제공자별 모양은 checkAccountId가 본다
export const VerifyBody = z.object({
  accountId: z.string(),
  // 결정 3번 A안 (GCP 만): 이전 전용 프로젝트 ID. accountId(원래 프로젝트, 관찰만)와 달라야 한다. 모양은 checkAccountId("gcp") 와 같음
  // DRAFT(ai): 빠지면 예전처럼 원래 프로젝트 하나로 (옛 고객·시험). 진짜 발급기에서 실행 역할은 전용 프로젝트에만 있으므로 실행 단계가 ROLE_NOT_FOUND 로 막힌다
  targetProjectId: z.string().optional(),
}).strict();
export type VerifyBody = z.infer<typeof VerifyBody>;

const ACCOUNT_ID_RE: Partial<Record<Provider, RegExp>> = {
  aws: /^\d{12}$/,                               // AWS 계정 번호 12자리
  gcp: /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/,         // GCP 프로젝트 ID (6~30자)
};
// PF07 (운영자 실수): AWS 콘솔 오른쪽 위 계정 번호는 "1111-2222-3333" 모양으로 보인다 → 그대로 붙여 넣어도 받게
//   AWS 는 빈칸·대시를 지운 12자리로, 모든 제공자는 앞뒤 빈칸만 지운다. 검사(checkAccountId)는 이 값으로 한다
export function normalizeAccountId(provider: Provider, id: string): string {
  const t = id.trim();
  return provider === "aws" ? t.replace(/[\s-]/g, "") : t;
}
// 제공자별 계정 번호 검사. onprem·azure_mock은 verify 대상이 아니라 늘 거부
export function checkAccountId(provider: Provider, id: string): boolean {
  const re = ACCOUNT_ID_RE[provider];
  return re !== undefined && re.test(id);
}

// AWS 연결 역할 이름 꼬리 (environments.aws_role_suffix, 0056). 한 AWS 계정에 환경을 여럿 연결하려고 환경마다 역할 이름을 다르게 한다
//   새 AWS 연결(확인 문구를 새로 만들 때) = "-" + 환경 번호 앞 8자 (연결 스택 이름 svc-connect-<같은 8자> 와 같음)
//   옛 환경 = NULL → 꼬리 없음 (svc-observe·svc-operate·svc-deploy 그대로, 고객이 할 일 없음)
// 템플릿 매개변수 RoleSuffix 의 AllowedPattern 과 DB CHECK 가 같은 모양이다
export const AWS_ROLE_SUFFIX_RE = /^-[0-9a-f]{8}$/;
export function awsRoleSuffixFor(envId: string): string {
  return `-${envId.replace(/[^A-Za-z0-9]/g, "").slice(0, 8).toLowerCase()}`;
}
/** 고객 계정 안 역할·정책 이름 (svc-observe·svc-operate·svc-deploy·svc-operate-policy) + 환경 꼬리. 꼬리가 없거나 모양이 틀리면 옛 이름 */
export function awsRoleName(base: string, suffix?: string | null): string {
  return suffix && AWS_ROLE_SUFFIX_RE.test(suffix) ? `${base}${suffix}` : base;
}

// 연결 링크 발급 응답. AWS = CloudFormation 빠른 생성 url, GCP = Cloud Shell url 또는 명령 한 줄, 온프레 = 설치 명령 한 줄
export const ConnectionLinkKind = z.enum(["aws_quick_create", "gcp_cloud_shell", "onprem_install"]);
export type ConnectionLinkKind = z.infer<typeof ConnectionLinkKind>;
export const ConnectionLink = z.object({
  kind: ConnectionLinkKind,
  url: z.url().optional(),            // AWS 빠른 생성 링크 / Cloud Shell 열기 주소
  command: z.string().optional(),     // GCP 명령 한 줄 / 온프레 설치 한 줄
  externalId: z.string().optional(),  // AWS만. 확인 문구 (비밀 아님, 회사·환경마다 다름. 설계 IA 6.1)
  // F17: AWS만. false = 링크가 템플릿에 "권한 경계 정책(platform-app-boundary)을 만들지 마"를 넘김 (같은 계정에 이미 있음 → 이름 충돌로 스택 실패 방지)
  createBoundaryPolicy: z.boolean().optional(),
  expiresAt: z.string(),              // 24시간
}).strict().refine((v) => v.url !== undefined || v.command !== undefined, "url or command");
export type ConnectionLink = z.infer<typeof ConnectionLink>;
// F17: 연결 링크 요청 쿼리. boundaryPolicyExists=true = 고객 계정에 platform-app-boundary 가 이미 있다고 알림 (CLI 가 get-policy 로 확인하거나 화면이 물음)
export const ConnectionLinkQuery = z.object({
  boundaryPolicyExists: z.enum(["true", "false"]).optional(),
}).strict();
export type ConnectionLinkQuery = z.infer<typeof ConnectionLinkQuery>;

// 연결 상태 전이 표 (설계 IA 6.4). 같은 상태로 가기는 no-op 허용(재확인 성공·heartbeat·링크 재발급)
// DRAFT(ai): 주기 재확인은 verifying으로 안 옮긴다. 옮기면 guards가 진행 중 이전을 막는다
export const CONNECTION_VALID: Readonly<Record<ConnectionStatus, readonly ConnectionStatus[]>> = {
  draft: ["awaiting_customer", "connected", "disconnected"],
  awaiting_customer: ["awaiting_customer", "verifying", "expired", "connected", "disconnected"],
  verifying: ["connected", "failed"],
  connected: ["connected", "unstable", "disconnected"],
  unstable: ["connected", "unstable", "disconnected"],
  failed: ["awaiting_customer", "verifying", "disconnected"],
  expired: ["awaiting_customer", "disconnected"],
  disconnected: [],
};

// draft·awaiting_customer → connected 는 온프레 Agent heartbeat 전용 (고객 쪽 Agent가 직접 붙으니 verify 단계가 없다)
const ONPREM_ONLY_TO_CONNECTED: ReadonlySet<ConnectionStatus> = new Set(["draft", "awaiting_customer"]);
export function canTransition(provider: Provider, from: ConnectionStatus, to: ConnectionStatus): boolean {
  if (!CONNECTION_VALID[from].includes(to)) return false;
  if (to === "connected" && ONPREM_ONLY_TO_CONNECTED.has(from) && provider !== "onprem") return false;
  return true;
}

// DRAFT(ai): 주기 재확인 연속 실패 3번이면 불안정 (설계 IA 6.1 5단계 "3번 연속 실패")
export const UNSTABLE_AFTER_FAILURES = 3;

// 주기 재확인 한 번의 결과로 다음 상태와 연속 실패 수를 정한다 (순수 함수)
//   ok: 확인 통과 / roleGone: 고객이 역할을 지움(ROLE_NOT_FOUND) → 해제 (IA 6.4)
export function nextAfterPeriodic(cur: ConnectionStatus, failures: number, ok: boolean, roleGone: boolean):
  { status: ConnectionStatus; failures: number } {
  if (ok) return { status: cur === "unstable" ? "connected" : cur, failures: 0 };
  if (roleGone) return { status: "disconnected", failures };
  const n = failures + 1;
  return { status: n >= UNSTABLE_AFTER_FAILURES ? "unstable" : cur, failures: n };
}
