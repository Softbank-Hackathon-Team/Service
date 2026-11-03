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
}

export function awsQuickCreateUrl(i: AwsLinkInput): string {
  const region = i.region?.trim() || AWS_DEFAULT_REGION;
  const q = [
    `templateURL=${encodeURIComponent(i.templateUrl)}`,
    `stackName=${encodeURIComponent(stackNameFor(i.envId))}`,
    `param_ExternalId=${encodeURIComponent(i.externalId)}`,
    `param_PlatformPrincipalArn=${encodeURIComponent(i.principalArn)}`,
    `param_EksClusterName=${encodeURIComponent(i.clusterName)}`,
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
