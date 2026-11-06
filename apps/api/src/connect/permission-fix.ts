import { AWS_DEFAULT_REGION } from "@svc/security";
import type { PermissionFix } from "@svc/contracts";
import { gcpCloudShellLink, stackNameFor, type GcpLinkInput } from "./link.js";

// PERM-GATE: 빠진 권한 묶음을 고치는 링크·명령 (순수 함수). 연결 링크(link.ts)와 같은 설정·같은 스크립트·같은 템플릿을 쓴다.
//   GCP = 연결과 같은 Cloud Shell 링크 + 명령에 ONLY_BUNDLES (빠진 묶음만 맞추는 모드, 전체 재실행 아님). 다시 돌려도 같은 끝
//   AWS = 같은 연결 스택(stackNameFor)을 지금 템플릿 판으로 업데이트. 매개변수는 스택에 있는 것 전부 이전 값 그대로(UsePreviousValue),
//         새 템플릿에만 있는 매개변수는 기본값. 명령에 비밀값·계정 번호를 넣지 않는다 (ExternalId 도 이전 값을 쓰게 해서 명령에 안 나옴)

const BUNDLE_RE = /^(aws|gcp)\.[a-z0-9.]+$/;
const clean = (bundles: string[], cloud: "aws" | "gcp") => [...new Set(bundles.filter((b) => BUNDLE_RE.test(b) && b.startsWith(`${cloud}.`)))].sort();

export function gcpPermissionFix(i: GcpLinkInput & { bundles: string[] }): PermissionFix | null {
  const bundles = clean(i.bundles, "gcp");
  if (!bundles.length) return null;
  const l = gcpCloudShellLink(i);
  // 연결 명령의 "… bash onboarding/gcp-connect.sh" 앞에 묶음만 붙인다 (값은 소문자·숫자·점·쉼표뿐이라 따옴표가 필요 없다)
  const command = l.command.replace(/ bash onboarding\/gcp-connect\.sh$/, ` ONLY_BUNDLES=${bundles.join(",")} bash onboarding/gcp-connect.sh`);
  return { kind: "cloudshell", url: l.url, command };
}

export interface AwsFixInput { envId: string; region?: string | null; templateUrl: string; bundles: string[] }
export function awsPermissionFix(i: AwsFixInput): PermissionFix | null {
  if (!clean(i.bundles, "aws").length) return null;
  const region = i.region?.trim() || AWS_DEFAULT_REGION;
  const stack = stackNameFor(i.envId);
  const r = encodeURIComponent(region);
  // DRAFT(ai) 【추정】 콘솔 "스택 업데이트 → 현재 템플릿 바꾸기" 화면을 템플릿 주소를 채운 채로 연다 (빠른 생성 링크처럼 문서화된 주소 모양은 아님).
  //   매개변수 화면은 기존 값이 기본으로 채워진다. 확실한 길은 아래 명령
  const url = `https://${r}.console.aws.amazon.com/cloudformation/home?region=${r}#/stacks/update/template?stackId=${encodeURIComponent(stack)}&templateURL=${encodeURIComponent(i.templateUrl)}`;
  const params = `$(aws cloudformation describe-stacks --region ${region} --stack-name ${stack} --query 'Stacks[0].Parameters[].ParameterKey' --output text | tr '\\t' '\\n' | sed 's/.*/ParameterKey=&,UsePreviousValue=true/')`;
  const command = `aws cloudformation update-stack --region ${region} --stack-name ${stack} --template-url '${i.templateUrl.replace(/'/g, "")}' --capabilities CAPABILITY_NAMED_IAM --parameters ${params}`;
  return { kind: "cloudformation", url, command };
}
