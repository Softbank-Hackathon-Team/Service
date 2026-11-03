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
  lastVerifiedAt: z.string().nullable(),
  failureReason: z.string().nullable(), // 예: 권한 부족 + 동작 이름. 모양은 ConnectionFailure 또는 "PERMISSION_MISSING:<동작>"
}).strict();
export type EnvironmentView = z.infer<typeof EnvironmentView>;

// 연결 확인 실패 사유 (설계 IA 6.4 실패 사유 + 링크 만료 + 쿠버네티스 접근 없음).
// 화면에 줄 때는 "PERMISSION_MISSING:<동작>"처럼 뒤에 붙일 수 있어 EnvironmentView.failureReason은 문자열로 둔다
export const ConnectionFailure = z.enum([
  "ROLE_ASSUME_DENIED", "PERMISSION_MISSING", "ORG_POLICY_BLOCKED",
  "ROLE_NOT_FOUND", "LINK_EXPIRED", "K8S_ACCESS_MISSING",
  "ACCOUNT_MISMATCH",   // L7i: GCP 프로젝트 번호가 처음 확인한 값과 다름
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
}).strict();
export type VerifyBody = z.infer<typeof VerifyBody>;

const ACCOUNT_ID_RE: Partial<Record<Provider, RegExp>> = {
  aws: /^\d{12}$/,                               // AWS 계정 번호 12자리
  gcp: /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/,         // GCP 프로젝트 ID (6~30자)
};
// 제공자별 계정 번호 검사. onprem·azure_mock은 verify 대상이 아니라 늘 거부
export function checkAccountId(provider: Provider, id: string): boolean {
  const re = ACCOUNT_ID_RE[provider];
  return re !== undefined && re.test(id);
}

// 연결 링크 발급 응답. AWS = CloudFormation 빠른 생성 url, GCP = Cloud Shell url 또는 명령 한 줄, 온프레 = 설치 명령 한 줄
export const ConnectionLinkKind = z.enum(["aws_quick_create", "gcp_cloud_shell", "onprem_install"]);
export type ConnectionLinkKind = z.infer<typeof ConnectionLinkKind>;
export const ConnectionLink = z.object({
  kind: ConnectionLinkKind,
  url: z.url().optional(),            // AWS 빠른 생성 링크 / Cloud Shell 열기 주소
  command: z.string().optional(),     // GCP 명령 한 줄 / 온프레 설치 한 줄
  externalId: z.string().optional(),  // AWS만. 확인 문구 (비밀 아님, 회사·환경마다 다름. 설계 IA 6.1)
  expiresAt: z.string(),              // 24시간
}).strict().refine((v) => v.url !== undefined || v.command !== undefined, "url or command");
export type ConnectionLink = z.infer<typeof ConnectionLink>;

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
