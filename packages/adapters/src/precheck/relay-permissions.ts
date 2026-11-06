// 온프레 이전 중계기 권한 (출발 AWS → 온프레 도착). 워커 relay/aws-relay.ts 가 부르는 aws CLI 동작과 글자 하나까지 같아야 한다.
//   원본 문서 = infra/permissions/aws-relay-statements.json (고객이 출발 실행 역할 svc-operate 에 따로 붙이는 문 묶음).
//   시험이 이 목록 = 그 파일의 동작 전부 인지 대조한다. CloudFormation 연결 템플릿(다른 영역 담당)에는 아직 안 들어 있다 → 사전 점검이 빠진 동작을 알린다
// 사전 점검은 읽기만 한다: iam simulate-principal-policy (관찰 역할로 실행 역할 정책을 흉내 평가). 자원을 만들지 않는다

import type { CloudCheck } from "./cloud-precheck.js";

/** 중계기 만들기·지우기에 쓰는 동작 전부 (정렬). 지울 때 쓰는 것도 같은 세션 정책이다 (security STEP_ROLES.relay) */
export const RELAY_ACTIONS = [
  "ec2:AuthorizeSecurityGroupEgress",   // 중계 SG 나가기 5432 → VPC, 출발 RDS SG 나가기 → 중계 사설 IP/32
  "ec2:AuthorizeSecurityGroupIngress",  // 중계 SG 들어오기 22(온프레 /32)·5432(VPC·플랫폼)·15432(플랫폼 출발 입구), 출발 RDS SG 들어오기 ← 중계 SG
  "ec2:CreateSecurityGroup",
  "ec2:CreateTags",                     // 만들 때 태그 (ec2:CreateAction 조건)
  "ec2:DeleteSecurityGroup",
  "ec2:DescribeImages",                 // AMI 가 Amazon 소유 arm64 인지 확인
  "ec2:DescribeInstances",
  "ec2:DescribeRouteTables",            // 공개 서브넷 고르기 (0.0.0.0/0 → igw-*)
  "ec2:DescribeSecurityGroupRules",
  "ec2:DescribeSecurityGroups",
  "ec2:DescribeSubnets",
  "ec2:DescribeVpcs",                   // VPC 대역
  "ec2:RevokeSecurityGroupEgress",      // 새 SG 기본 나가기 전부 허용 빼기, 정리 때 RDS 나가기 규칙 빼기
  "ec2:RevokeSecurityGroupIngress",     // 온프레 나가는 IP 가 바뀌면 옛 22 규칙 빼기, 정리 때 RDS 들어오기 규칙 빼기
  "ec2:RunInstances",
  "ec2:TerminateInstances",
  "rds:DescribeDBInstances",            // 출발 RDS 주소·VPC·SG
  // 출발 RDS 가 관리하는 마스터 비밀(rds!db-…) 읽기. 고객 역할 문장은 태그 aws:rds:primaryDBInstanceArn = 그 DB 하나로 묶는다 (매개변수 SourceDbInstanceId).
  //   흉내 평가에는 그 태그 값을 안 넣어서 매개변수를 채웠어도 "빠짐"으로 보일 수 있다 (판정이 WARN 이라 막지는 않음)
  "secretsmanager:GetSecretValue",
  "ssm:GetParameter",                   // AL2023 arm64 AMI (AWS 공개 SSM 값)
] as const;

// 흉내 평가 때 넣는 조건 값: 문 묶음의 태그·리전·이미지 소유 조건이 "맞는 요청"일 때 허용되는지 본다
export function relaySimContext(region: string): object[] {
  const s = (k: string, v: string) => ({ ContextKeyName: k, ContextKeyValues: [v], ContextKeyType: "string" });
  return [s("aws:RequestedRegion", region), s("aws:RequestTag/managed-by", "platform"), s("aws:ResourceTag/managed-by", "platform"),
    s("aws:RequestTag/svc:migration", "precheck"), s("aws:ResourceTag/svc:migration", "precheck"), s("ec2:Owner", "amazon"), s("ec2:CreateAction", "RunInstances")];
}

export const RELAY_PERM_FIX = "연결 스택을 지금 템플릿(infra/onboarding/aws-connect.json, 중계기 문 묶음 포함)으로 업데이트한다. "
  + "출발 RDS 보안 그룹이 중계기와 5432 를 주고받지 못하면(나가기·들어오기) 스택 입력값 SourceDbSecurityGroupId 에 그 보안 그룹을 넣는다 (이미 열려 있으면 비워도 된다). "
  + "출발 DB 관리자 비밀번호를 사람이 넣지 않으려면 RDS 에서 마스터 비밀 관리(Secrets Manager)를 켜고 스택 입력값 SourceDbInstanceId 에 그 DB 식별자를 넣는다. "
  + "자동 점검을 하려면 관찰 역할에 iam:SimulatePrincipalPolicy 가 있어야 한다";

/** simulate-principal-policy 결과 → 점검 한 줄.
 *  DRAFT(ai): 빠진 동작이 있어도 WARN (막지 않음). 흉내 평가는 자원 ARN 을 "*" 로 보고 조건 값을 우리가 넣은 것으로만 평가해,
 *    자원별 문(ARN 지정)을 실제와 다르게 볼 수 있다 【미확인】. 실제로 빠졌으면 apply 가 RELAY_PROVISION_FAILED(권한 없음)로 멈춘다
 *  TODO(human): 빠진 동작을 block(명세 검토로 되돌림)으로 올릴지 */
export function relayPermVerdict(r: { code: number; stderr: string; json?: unknown }, roleArn: string): CloudCheck {
  const id = "PC-RELAY-PERM", side = "source" as const, item = "출발 실행 역할 중계기 권한";
  const all = RELAY_ACTIONS.join(", ");
  if (r.code !== 0) {
    const denied = /AccessDenied|UnauthorizedOperation|not authorized/i.test(r.stderr);
    return { id, side, item, verdict: "WARN",
      reason: `${denied ? "관찰 역할에 iam:SimulatePrincipalPolicy 가 없어" : "권한 흉내 평가가 실패해"} 확인 못 함. 필요한 동작 ${RELAY_ACTIONS.length}개: ${all}`,
      fix: RELAY_PERM_FIX };
  }
  const res = ((r.json as { EvaluationResults?: { EvalActionName?: string; EvalDecision?: string }[] })?.EvaluationResults ?? []);
  const allowed = new Set(res.filter((x) => x.EvalDecision === "allowed").map((x) => x.EvalActionName));
  const missing = RELAY_ACTIONS.filter((a) => !allowed.has(a));
  if (!missing.length) return { id, side, item, verdict: "PASS", reason: `${roleArn.split(":").pop()} 에 중계기 동작 ${RELAY_ACTIONS.length}개 허용 (흉내 평가)` };
  return { id, side, item, verdict: "WARN", reason: `빠진 동작 ${missing.length}개: ${missing.join(", ")} — 이대로면 apply 가 중계기를 못 만든다`, fix: RELAY_PERM_FIX };
}

/** aws CLI 인자 (실행 역할 ARN · 리전) */
export function relaySimArgs(roleArn: string, region: string): string[] {
  return ["iam", "simulate-principal-policy", "--policy-source-arn", roleArn, "--action-names", ...RELAY_ACTIONS,
    "--context-entries", JSON.stringify(relaySimContext(region))];
}
