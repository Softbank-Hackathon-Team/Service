import { randomBytes } from "node:crypto";
import { AWS_DEFAULT_REGION } from "@svc/security";

// 연결 링크 문자열 만들기 (순수 함수). 경로(routes/environments.ts)는 값만 모아 여기로 넘긴다
// 【사실: AWS 문서 "Use quick-create links for stacks"】 templateURL 은 S3 주소만, 파라미터는 param_<이름>(대소문자 그대로),
//   NoEcho 파라미터는 링크로 못 넘김, IAM 자원 확인 체크는 고객이 콘솔에서 직접 누른다

// DRAFT(ai): 링크 수명 24시간 (설계 IA 6.1 5단계 "링크는 24시간 안에 쓰지 않으면 만료")
export const LINK_TTL_MS = 24 * 60 * 60 * 1000;

// 확인 문구(ExternalId). 랜덤 32바이트 → base64url 43자 (설계 IA 6.1 1단계). 비밀은 아니지만 로그엔 앞 4자만
export function newExternalId(): string {
  return randomBytes(32).toString("base64url");
}
export const externalIdHint = (id: string) => id.slice(0, 4);

// 스택 이름: 영문 시작, [A-Za-z0-9-], 128자 이하 (CloudFormation 규칙). 환경 번호 앞 8자로 고객 계정 안에서 구분
export function stackNameFor(envId: string): string {
  return `svc-connect-${envId.replace(/[^A-Za-z0-9]/g, "").slice(0, 8)}`;
}

export interface AwsLinkInput {
  envId: string;
  region?: string | null;          // 없으면 기본 리전
  templateUrl: string;             // CONNECT_TEMPLATE_URL (S3 주소)
  principalArn: string;            // PLATFORM_PRINCIPAL_ARN (역할을 빌릴 수 있는 플랫폼 워커 역할 하나)
  externalId: string;
  clusterName: string;
  // F17: false 면 param_CreateBoundaryPolicy=false (템플릿 기본 true). 빠지면 템플릿 기본값
  createBoundaryPolicy?: boolean;
}

// F17: 플랫폼 주체 ARN(arn:aws:iam::<12자리>:role/...)의 계정 칸. 모양이 아니면 null
export const principalAccount = (arn: string): string | null => /^arn:aws:iam::(\d{12}):/.exec(arn)?.[1] ?? null;

// F17: 템플릿에 경계 정책을 만들라고 할지. 같은 계정에 platform-app-boundary 가 이미 있으면 CloudFormation 이
//   NAME_CONFLICT_VALIDATION 으로 스택 전체를 되돌린다 (11/3 실세션 2회차). 아래 둘 중 하나면 만들지 않는다
//   - 요청자가 "이미 있다"고 알림 (CLI 가 aws iam get-policy 로 확인, 화면은 고객에게 물음)
//   - 고객 계정 = 플랫폼 계정 (데모 한 계정: 도착 환경 모듈 infra/modules/aws/env 가 같은 이름 정책을 먼저 만든다)
// DRAFT(ai): 계정을 모르면(연결 확인 전 첫 링크) 템플릿 기본값(만듦). 고객 계정은 보통 플랫폼과 달라 충돌이 없다【추정】
export function shouldCreateBoundary(o: { boundaryPolicyExists?: boolean; envAccountId?: string | null; principalArn: string }): boolean {
  if (o.boundaryPolicyExists === true) return false;
  const pa = principalAccount(o.principalArn);
  if (o.envAccountId && pa && o.envAccountId === pa) return false;
  return true;
}

export function awsQuickCreateUrl(i: AwsLinkInput): string {
  const region = i.region?.trim() || AWS_DEFAULT_REGION;
  const q = [
    `templateURL=${encodeURIComponent(i.templateUrl)}`,
    `stackName=${encodeURIComponent(stackNameFor(i.envId))}`,
    `param_ExternalId=${encodeURIComponent(i.externalId)}`,
    `param_PlatformPrincipalArn=${encodeURIComponent(i.principalArn)}`,
    `param_EksClusterName=${encodeURIComponent(i.clusterName)}`,
    ...(i.createBoundaryPolicy === false ? ["param_CreateBoundaryPolicy=false"] : []),
  ].join("&");
  const r = encodeURIComponent(region);
  return `https://${r}.console.aws.amazon.com/cloudformation/home?region=${r}#/stacks/create/review?${q}`;
}

// 연결 링크 설정 (요청 때마다 읽는다: 시험·운영이 값을 바꿔도 다시 띄울 필요 없음). 둘 중 하나라도 없으면 null
export function connectSettings(env: NodeJS.ProcessEnv = process.env): { templateUrl: string; principalArn: string } | null {
  const templateUrl = env.CONNECT_TEMPLATE_URL?.trim();
  const principalArn = env.PLATFORM_PRINCIPAL_ARN?.trim();
  return templateUrl && principalArn ? { templateUrl, principalArn } : null;
}
