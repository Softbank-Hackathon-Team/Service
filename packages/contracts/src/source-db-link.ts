import { z } from "zod";

// APP-22 (가) 출발 DB 잇기: 컷오버 전까지 도착 앱이 출발 DB(관리형 Postgres, 지금은 AWS RDS)에 붙는다.
// DECISION(team): 컷오버 전(트래픽 10·50%) 도착 앱의 쓰기는 전부 출발 DB, 컷오버 때 도착 DB 로 전환 (Jeong 결정 APP-22 (가), 2026-11-04 01:57Z)
// 출발 쪽에서 여는 것:
//   ① 출발 RDS 보안 그룹에 인바운드 규칙 (5432, 도착 클러스터가 나가는 IP /32 만). 우리가 넣은 규칙 번호만 기록했다가 그것만 뺀다
//      (고객이 같은 규칙을 이미 갖고 있으면 Duplicate → 우리 것으로 안 셈 → 정리 때 안 건드림)
//   ② 최소 권한 앱 계정 하나 (LOGIN, 연결 수 제한, 표 읽기·쓰기와 시퀀스 사용만. DDL·소유 없음)
//   ③ TLS: 앱 연결 문자열 sslmode=verify-full
// 롤백·정리 때 ①②를 걷는다. 상태는 source_db_links 표 (0045)

// DRAFT(ai): 한 이전에 나가는 IP 는 8개까지 (GKE Cloud NAT 고정 IP 는 보통 1~2개)
export const SOURCE_DB_LINK_MAX_CIDRS = 8;
const IPV4_32 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}\/32$/;

export const SourceDbLinkInput = z.object({
  region: z.string().regex(/^[a-z]{2}(-[a-z]+)+-\d$/),
  // RDS DB 식별자 규칙: 글자로 시작, 글자·숫자·하이픈 1~63
  dbInstanceId: z.string().regex(/^[A-Za-z][A-Za-z0-9-]{0,62}$/),
  dbName: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,62}$/),
  egressCidrs: z.array(z.string().regex(IPV4_32, "IPv4 /32 only"))
    .min(1).max(SOURCE_DB_LINK_MAX_CIDRS)
    .refine((xs) => xs.every((c) => !c.startsWith("0.")), "0.0.0.0/8 not allowed"),
  port: z.number().int().min(1).max(65535).default(5432),
  // 규칙을 넣을 RDS 보안 그룹. 없으면 RDS 에 붙은 첫 보안 그룹 (DRAFT(ai))
  securityGroupId: z.string().regex(/^sg-[0-9a-f]{8,17}$/).optional(),
  schemas: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,62}$/)).min(1).max(20).default(["public"]),
  // DRAFT(ai): 앱 계정 동시 연결 상한 (도착 파드 수 × 풀 크기보다 넉넉히)
  connectionLimit: z.number().int().min(1).max(500).default(50),
}).strict();
export type SourceDbLinkInput = z.infer<typeof SourceDbLinkInput>;

// 계획 = 같은 입력이면 같은 값 (순수 함수 planSourceDbLink 결과)
export const SourceDbLinkPlan = z.object({
  migrationId: z.uuid(),
  region: z.string(),
  dbInstanceId: z.string(),
  dbName: z.string(),
  port: z.number().int(),
  securityGroupId: z.string().optional(),
  ruleDescription: z.string(),            // svc-dblink <이전 앞 8자> (규칙 설명. 기록을 잃어도 이걸로 우리 규칙을 찾는다)
  tags: z.record(z.string(), z.string()),
  egressCidrs: z.array(z.string()),
  roleName: z.string(),                   // svc_link_<이전 앞 8자>
  connectionLimit: z.number().int(),
  schemas: z.array(z.string()),
  sslmode: z.literal("verify-full"),
}).strict();
export type SourceDbLinkPlan = z.infer<typeof SourceDbLinkPlan>;

export const SourceDbLinkStatus = z.enum(["opening", "opened", "closing", "closed"]);
export type SourceDbLinkStatus = z.infer<typeof SourceDbLinkStatus>;

// open 결과. 비밀번호는 여기서만 한 번 돌려주고 DB·로그에 남기지 않는다 (도착 비밀에 넣는 건 배포 쪽)
export const SourceDbLinkOpened = z.object({
  user: z.string(),
  password: z.string(),
  host: z.string(),
  port: z.number().int(),
  dbName: z.string(),
  sslmode: z.literal("verify-full"),
  securityGroupId: z.string(),
  ruleIds: z.array(z.string()),           // 우리가 넣은 규칙 (정리 때 이것만 뺌)
  alreadyAllowed: z.array(z.string()),    // 고객 규칙이 이미 허용하던 CIDR (우리 것 아님)
  stub: z.boolean().optional(),
}).strict();
export type SourceDbLinkOpened = z.infer<typeof SourceDbLinkOpened>;

export const SourceDbLinkClosed = z.object({
  closed: z.boolean(),                    // 걷을 게 없었거나 다 걷음
  removed: z.array(z.string()),
  pending: z.array(z.string()),           // 다음 번에 다시 (예: 출발 DB 에 못 붙어 앱 계정을 못 지움)
  stub: z.boolean().optional(),
}).strict();
export type SourceDbLinkClosed = z.infer<typeof SourceDbLinkClosed>;

// 이름 규칙 한 곳 (워커·컷오버 울타리·정리가 같이 쓴다). 이전 번호 앞 8자(하이픈 빼고 소문자)
const short8 = (migrationId: string) => migrationId.replace(/-/g, "").slice(0, 8).toLowerCase();
/** 출발 DB 잇기 앱 계정 이름. 컷오버 울타리(fence)도 이 계정의 쓰기를 막는다 */
export const sourceLinkRoleOf = (migrationId: string) => `svc_link_${short8(migrationId)}`;
/** 출발 RDS 보안 그룹에 넣는 규칙의 설명 (우리 규칙 표시) */
export const sourceLinkRuleDescOf = (migrationId: string) => `svc-dblink ${short8(migrationId)}`;
