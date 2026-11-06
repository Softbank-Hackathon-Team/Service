import {
  SourceDbLinkInput, SourceDbLinkPlan, sourceLinkRoleOf, sourceLinkRuleDescOf,
  type PrecheckItem, type SourceDbLinkOpened, type SourceDbLinkClosed,
} from "@svc/contracts";
import { CliError, arr, get, runJson, str, type CliDeps } from "../common/cli.js";

// APP-22 (가) 출발 DB 잇기 (AWS RDS). 계약 모양은 contracts/source-db-link.ts
// 계획(planSourceDbLink)·SQL(sourceDbLink*Sql)·사전 점검(sourceDbLinkPrecheck)은 순수 함수. 클라우드를 바꾸는 건 openSourceDbLinkAws·closeSourceDbLinkAws 둘뿐이고
//   CLI 실행기(CliDeps.exec)를 받아서 시험은 가짜 실행기로 돈다. 워커가 SOURCE_DB_LINK=real 일 때만 진짜 실행기를 넘긴다
// DRAFT(ai): 출발 RDS 보안 그룹에 우리 규칙(설명 "svc-dblink <8자>", 태그 managed-by=platform)을 넣고, 돌려받은 규칙 번호만 기록했다가 그것만 뺀다.
//   고객이 같은 CIDR·포트 규칙을 이미 갖고 있으면 Duplicate → 우리 것으로 안 셈 (정리 때 고객 규칙을 안 지움).
//   대안 "플랫폼 보안 그룹을 만들어 RDS 에 덧붙이기"는 버림: 고객 RDS 에 rds:ModifyDBInstance(태그 없는 DB 전체) 권한이 필요하고 RDS 수정 대기가 생긴다

export function planSourceDbLink(migrationId: string, raw: unknown): SourceDbLinkPlan {
  const i = SourceDbLinkInput.parse(raw);
  return SourceDbLinkPlan.parse({
    migrationId, region: i.region, dbInstanceId: i.dbInstanceId, dbName: i.dbName, port: i.port,
    ...(i.securityGroupId ? { securityGroupId: i.securityGroupId } : {}),
    ruleDescription: sourceLinkRuleDescOf(migrationId),
    tags: { "managed-by": "platform", "svc:purpose": "source-db-link", "svc:migration-id": migrationId },
    egressCidrs: [...new Set(i.egressCidrs)].sort(),
    roleName: sourceLinkRoleOf(migrationId),
    connectionLimit: i.connectionLimit, schemas: i.schemas, sslmode: "verify-full",
  });
}

// 이름은 계약 정규식으로 이미 걸렀지만 SQL 에 넣을 때는 늘 따옴표로 감싼다
const qi = (s: string) => `"${s.replace(/"/g, '""')}"`;
const ql = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** 최소 권한 앱 계정 만들기·비밀번호 바꾸기·권한 주기. 여러 번 돌려도 같은 결과 */
export function sourceDbLinkGrantSql(p: SourceDbLinkPlan, password: string): string[] {
  const r = qi(p.roleName);
  return [
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${ql(p.roleName)}) THEN CREATE ROLE ${r} LOGIN; END IF; END $$`,
    `ALTER ROLE ${r} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT CONNECTION LIMIT ${p.connectionLimit} PASSWORD ${ql(password)}`,
    `GRANT CONNECT ON DATABASE ${qi(p.dbName)} TO ${r}`,
    ...p.schemas.flatMap((s) => [
      `GRANT USAGE ON SCHEMA ${qi(s)} TO ${r}`,
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${qi(s)} TO ${r}`,
      `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${qi(s)} TO ${r}`,
    ]),
  ];
}

/** 앱 계정 걷기: 붙은 연결 끊고 → 권한 회수 → 계정 지움. 계정이 없으면 아무것도 안 함
 *  DROP OWNED BY 는 안 쓴다 (PG16 은 만든 사람에게 그 계정의 권한 상속을 기본으로 안 줘서 RDS 마스터가 못 부를 수 있다) */
export function sourceDbLinkDropSql(p: SourceDbLinkPlan): string[] {
  const r = qi(p.roleName);
  const revokes = [
    ...p.schemas.flatMap((s) => [
      `REVOKE ALL ON ALL TABLES IN SCHEMA ${qi(s)} FROM ${r}`,
      `REVOKE ALL ON ALL SEQUENCES IN SCHEMA ${qi(s)} FROM ${r}`,
      `REVOKE ALL ON SCHEMA ${qi(s)} FROM ${r}`,
    ]),
    `REVOKE ALL ON DATABASE ${qi(p.dbName)} FROM ${r}`,
    `DROP ROLE ${r}`,
  ];
  return [
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = ${ql(p.roleName)}`,
    `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${ql(p.roleName)}) THEN ${revokes.map((s) => `EXECUTE ${ql(s)};`).join(" ")} END IF; END $$`,
  ];
}

/** 출발 DB 에 SQL 을 차례로 넣는 쪽 (워커가 출발 관리자 접속으로 만든다). 문장은 로그에 남기지 않는다 (비밀번호가 들어 있음) */
export type SqlRunner = (statements: string[]) => Promise<void>;

// ---- 환경변수 → 입력, 사전 점검 ----
// DRAFT(ai): 켜는 이름 (워커 .env)
//   SOURCE_DB_LINK=real|stub        없으면 꺼짐 (지금까지와 같음)
//   SOURCE_DB_LINK_INSTANCE=<RDS 식별자>
//   SOURCE_DB_LINK_DB=<DB 이름>      없으면 REPL_SOURCE_URL 경로
//   SOURCE_DB_LINK_EGRESS_IPS=a,b   도착 클러스터가 나가는 IP. /32 없이 IP 만 줘도 된다. 없으면 TF_FACT_NAT_EGRESS_IPS_JSON (gcp/env 출력 nat_egress_ips)
//   SOURCE_DB_LINK_REGION           없으면 AWS_REGION, 그것도 없으면 ap-northeast-2
export type SourceDbLinkMode = "off" | "stub" | "real";
export function sourceDbLinkMode(env: NodeJS.ProcessEnv = process.env): SourceDbLinkMode {
  const v = env.SOURCE_DB_LINK?.trim();
  return v === "real" ? "real" : v === "stub" || v === "1" ? "stub" : "off";
}
const dbFromUrl = (u: string | undefined) => {
  try { return u ? decodeURIComponent(new URL(u).pathname.replace(/^\//, "")) || undefined : undefined; } catch { return undefined; }
};
// 도착 나가는 IP: SOURCE_DB_LINK_EGRESS_IPS(쉼표) 가 먼저, 없으면 8nr2 계획 사실 TF_FACT_NAT_EGRESS_IPS_JSON (gcp/env 출력 nat_egress_ips, JSON 목록, /32 없음)
//   facts.natEgressIpsJson (환경 층 DB 사실을 mergeFacts 로 합친 값)이 있으면 TF_FACT_* 보다 먼저
function egressIpsOf(env: NodeJS.ProcessEnv, facts?: Record<string, string>): string[] {
  const csv = (env.SOURCE_DB_LINK_EGRESS_IPS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (csv.length) return csv;
  try {
    const j: unknown = JSON.parse(facts?.natEgressIpsJson ?? env.TF_FACT_NAT_EGRESS_IPS_JSON ?? "[]");
    return Array.isArray(j) ? j.filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter(Boolean) : [];
  } catch { return []; }
}
export function sourceDbLinkInputFromEnv(env: NodeJS.ProcessEnv = process.env, facts?: Record<string, string>): Record<string, unknown> {
  const ips = egressIpsOf(env, facts).map((s) => (s.includes("/") ? s : `${s}/32`));
  return {
    region: env.SOURCE_DB_LINK_REGION?.trim() || env.AWS_REGION?.trim() || "ap-northeast-2",
    dbInstanceId: env.SOURCE_DB_LINK_INSTANCE?.trim() ?? "",
    dbName: env.SOURCE_DB_LINK_DB?.trim() || dbFromUrl(env.REPL_SOURCE_URL) || "",
    egressCidrs: ips,
  };
}
/** E 의 PC-APPLINK 옆에 붙는 항목. 꺼져 있으면 빈 목록 */
export function sourceDbLinkPrecheck(env: NodeJS.ProcessEnv = process.env): PrecheckItem[] {
  const mode = sourceDbLinkMode(env);
  if (mode === "off") return [];
  const r = SourceDbLinkInput.safeParse(sourceDbLinkInputFromEnv(env));
  if (!r.success) {
    const what = r.error.issues.map((x) => `${x.path.join(".") || "input"}: ${x.message}`).join("; ").slice(0, 300);
    return [{ id: "PC-DBLINK-INPUT", level: "block", message: `출발 DB 잇기 입력이 틀림 (${what})`,
      fix: "SOURCE_DB_LINK_INSTANCE·SOURCE_DB_LINK_EGRESS_IPS(도착 나가는 IP /32)·SOURCE_DB_LINK_DB 확인" }];
  }
  return [
    ...(mode === "stub" ? [{ id: "PC-DBLINK-STUB", level: "warn" as const, message: "출발 DB 잇기가 STUB (보안 그룹·앱 계정을 실제로 안 만듦)",
      fix: "실측은 SOURCE_DB_LINK=real" }] : []),
    // TODO(human): rds.force_ssl=1 을 고객 파라미터 그룹에 켤지. 지금은 앱 쪽 sslmode=verify-full 로만 TLS 를 강제한다
    { id: "PC-DBLINK-TLS", level: "info", message: "출발 DB 잇기 TLS 는 앱 연결 sslmode=verify-full 로 강제 (RDS rds.force_ssl 은 안 바꿈)" },
  ];
}

// ---- 열기·걷기 (AWS CLI) ----
/** 열기·걷기가 부르는 aws 명령 → IAM 동작. 관찰 역할(svc-observe)이 아니라 출발 쪽 실행 자격으로 부른다 (OBSROLE2 시험이 이 표의 명령을 관찰 표 대조에서 따로 본다) */
export const SOURCE_DB_LINK_AWS_ACTIONS: Readonly<Record<string, string>> = {
  "rds describe-db-instances": "rds:DescribeDBInstances",
  "ec2 describe-security-group-rules": "ec2:DescribeSecurityGroupRules",
  "ec2 create-tags": "ec2:CreateTags",
  "ec2 authorize-security-group-ingress": "ec2:AuthorizeSecurityGroupIngress",
  "ec2 revoke-security-group-ingress": "ec2:RevokeSecurityGroupIngress",
  "ec2 delete-tags": "ec2:DeleteTags",
};
// 보안 그룹 표시 태그. 열기가 출발 RDS 보안 그룹에 붙이고, 우리 규칙이 다 빠지면 걷기가 뗀다.
//   실행 역할의 규칙 열기·닫기 권한은 이 태그가 붙은 보안 그룹에서만 (IAM 은 보안 그룹 "규칙" 단위 권한이 없어 그룹 태그로 좁힌다. AWS IAM 예시 문서와 같은 방식)
export const SOURCE_DB_LINK_SG_TAG = "svc:source-db-link";
// DECISION(team): 롤백·정리 때 출발 RDS 규칙을 닫을 권한을 연결 템플릿에 넣는다, 우리가 연 규칙만 지울 수 있게 좁게 (Jeong 규칙 2026-11-04 02:03Z, 코디네이터 03:09Z 전달)
// 남는 위험 TODO(human): 실행 자격이 탈취되면 아무 보안 그룹에 이 태그를 붙인 뒤 인바운드 규칙을 열거나 닫을 수 있다 (두 단계. ID-4 의 managed-by 태그와 같은 종류).
//   코드는 기록한 규칙 번호·설명이 맞는 규칙만 닫는다
/** 연결 템플릿 실행 역할(svc-operate)에 붙는 인라인 정책 (export-permissions 가 infra/permissions 에 쓰고 aws-connect-template 이 넣는다) */
export function sourceDbLinkOperatePolicy(region = "ap-northeast-2") {
  const SG = "arn:aws:ec2:*:*:security-group/*";
  return {
    Version: "2012-10-17",
    Statement: [
      { Sid: "SourceDbLinkRules", Effect: "Allow", Action: ["ec2:AuthorizeSecurityGroupIngress", "ec2:RevokeSecurityGroupIngress"], Resource: SG,
        Condition: { StringEquals: { "aws:RequestedRegion": region, [`aws:ResourceTag/${SOURCE_DB_LINK_SG_TAG}`]: "open" } } },
      // 표시 태그 붙이기·떼기: 이 태그 키 하나만 (다른 태그는 못 건드림)
      { Sid: "SourceDbLinkMark", Effect: "Allow", Action: ["ec2:CreateTags", "ec2:DeleteTags"], Resource: SG,
        Condition: { StringEquals: { "aws:RequestedRegion": region }, "ForAllValues:StringEquals": { "aws:TagKeys": [SOURCE_DB_LINK_SG_TAG] } } },
      // 규칙 만들 때 규칙에 붙이는 태그 (managed-by 등). 새로 만드는 규칙에만 = 만들기 요청 안에서만
      { Sid: "SourceDbLinkRuleTags", Effect: "Allow", Action: ["ec2:CreateTags"], Resource: "arn:aws:ec2:*:*:security-group-rule/*",
        Condition: { StringEquals: { "aws:RequestedRegion": region, "ec2:CreateAction": "AuthorizeSecurityGroupIngress" } } },
      { Sid: "SourceDbLinkRead", Effect: "Allow", Action: ["rds:DescribeDBInstances", "ec2:DescribeSecurityGroupRules"], Resource: "*",
        Condition: { StringEquals: { "aws:RequestedRegion": region } } },
    ],
  };
}
async function markSg(d: CliDeps, p: { region: string }, sgId: string, on: boolean) {
  try {
    if (on) await runJson(d, "aws", ["ec2", "create-tags", "--resources", sgId, "--tags", `Key=${SOURCE_DB_LINK_SG_TAG},Value=open`, ...rr(p)]);
    else await runJson(d, "aws", ["ec2", "delete-tags", "--resources", sgId, "--tags", `Key=${SOURCE_DB_LINK_SG_TAG}`, ...rr(p)]);
  }
  catch (e) { if (on || !(e instanceof CliError && /InvalidGroup\.NotFound/.test(e.stderr))) throw e; }
}
const rr = (p: { region: string }) => ["--region", p.region, "--output", "json"];

interface DbInfo { sgIds: string[]; host: string; port: number }
async function describeDb(d: CliDeps, p: { region: string; dbInstanceId: string }): Promise<DbInfo | null> {
  let j: unknown;
  try { j = await runJson(d, "aws", ["rds", "describe-db-instances", "--db-instance-identifier", p.dbInstanceId, ...rr(p)]); }
  catch (e) { if (e instanceof CliError && /DBInstanceNotFound/.test(e.stderr)) return null; throw e; }
  const db = arr(get(j, "DBInstances"))[0];
  if (!db) return null;
  return {
    sgIds: arr(get(db, "VpcSecurityGroups")).map((g) => str(g.VpcSecurityGroupId)).filter((x): x is string => !!x),
    host: str(get(db, "Endpoint", "Address")) ?? "",
    port: Number(get(db, "Endpoint", "Port") ?? 5432),
  };
}
interface Rule { id: string; cidr: string; from: number; to: number; desc: string }
async function ingressRules(d: CliDeps, p: { region: string }, sgId: string): Promise<Rule[]> {
  const j = await runJson(d, "aws", ["ec2", "describe-security-group-rules", "--filters", `Name=group-id,Values=${sgId}`, ...rr(p)]);
  return arr(get(j, "SecurityGroupRules")).filter((r) => r.IsEgress === false && typeof r.CidrIpv4 === "string").map((r) => ({
    id: str(r.SecurityGroupRuleId) ?? "", cidr: str(r.CidrIpv4) ?? "", from: Number(r.FromPort), to: Number(r.ToPort), desc: str(r.Description) ?? "",
  }));
}
async function revokeRules(d: CliDeps, p: { region: string }, sgId: string, ids: string[]) {
  if (!ids.length) return;
  try { await runJson(d, "aws", ["ec2", "revoke-security-group-ingress", "--group-id", sgId, "--security-group-rule-ids", ...ids, ...rr(p)]); }
  catch (e) { if (!(e instanceof CliError && /InvalidSecurityGroupRuleId\.NotFound|InvalidGroup\.NotFound/.test(e.stderr))) throw e; }
}

export interface OpenAwsResult { opened: SourceDbLinkOpened }

/** RDS 보안 그룹에 도착 IP 규칙 넣기(없는 것만) → 지난번에 넣었는데 이번 계획에 없는 우리 규칙 빼기 → 앱 계정. 여러 번 불러도 같은 결과
 *  knownRuleIds: 지난번 열 때 기록한 우리 규칙 (설명으로도 찾는다) */
export async function openSourceDbLinkAws(d: CliDeps, p: SourceDbLinkPlan, sql: SqlRunner, password: string, knownRuleIds: string[] = []): Promise<OpenAwsResult> {
  const db = await describeDb(d, p);
  if (!db) throw new Error(`source db ${p.dbInstanceId} not found in ${p.region}`);
  const sgId = p.securityGroupId ?? db.sgIds[0];
  if (!sgId) throw new Error(`source db ${p.dbInstanceId} has no VPC security group`);
  if (p.securityGroupId && !db.sgIds.includes(p.securityGroupId)) throw new Error(`security group ${p.securityGroupId} is not attached to ${p.dbInstanceId}`);
  const rules = await ingressRules(d, p, sgId);
  const covers = (r: Rule) => r.from <= p.port && p.port <= r.to;
  const ours = rules.filter((r) => knownRuleIds.includes(r.id) || r.desc === p.ruleDescription);
  const keep = ours.filter((r) => p.egressCidrs.includes(r.cidr) && covers(r));
  const stale = ours.filter((r) => !keep.includes(r));
  const alreadyAllowed = p.egressCidrs.filter((c) => !keep.some((r) => r.cidr === c) && rules.some((r) => !ours.includes(r) && r.cidr === c && covers(r)));
  const add = p.egressCidrs.filter((c) => !keep.some((r) => r.cidr === c) && !alreadyAllowed.includes(c));
  const ruleIds = keep.map((r) => r.id);
  // 규칙을 넣거나 빼기 전에 표시 태그 (실행 역할 권한이 이 태그가 붙은 보안 그룹에서만)
  if (add.length || stale.length || keep.length) await markSg(d, p, sgId, true);
  if (add.length) {
    const tags = Object.entries(p.tags).map(([Key, Value]) => ({ Key, Value }));
    const j = await runJson(d, "aws", ["ec2", "authorize-security-group-ingress", "--group-id", sgId,
      "--ip-permissions", JSON.stringify([{ IpProtocol: "tcp", FromPort: p.port, ToPort: p.port, IpRanges: add.map((c) => ({ CidrIp: c, Description: p.ruleDescription })) }]),
      "--tag-specifications", JSON.stringify([{ ResourceType: "security-group-rule", Tags: tags }]), ...rr(p)]);
    ruleIds.push(...arr(get(j, "SecurityGroupRules")).map((r) => str(r.SecurityGroupRuleId)).filter((x): x is string => !!x));
  }
  await revokeRules(d, p, sgId, stale.map((r) => r.id));   // 지난번 IP 가 바뀌었으면 옛 우리 규칙은 닫는다
  await sql(sourceDbLinkGrantSql(p, password));
  return { opened: { user: p.roleName, password, host: db.host, port: db.port, dbName: p.dbName, sslmode: "verify-full",
    securityGroupId: sgId, ruleIds, alreadyAllowed } };
}

/** 앱 계정 지우기 → 우리 규칙만 빼기 (기록한 번호 + 같은 설명). 없는 것은 건너뛴다. 고객 규칙은 안 건드림 */
export async function closeSourceDbLinkAws(d: CliDeps, p: SourceDbLinkPlan, sql: SqlRunner | null,
  known: { securityGroupId?: string | null; ruleIds?: string[] }): Promise<SourceDbLinkClosed> {
  const removed: string[] = [], pending: string[] = [];
  if (sql) {
    try { await sql(sourceDbLinkDropSql(p)); removed.push(`role ${p.roleName}`); }
    catch (e) { pending.push(`role ${p.roleName}: ${(e as Error).message.slice(0, 120)}`); }
  } else pending.push(`role ${p.roleName}: no source admin connection`);
  const sgId = known.securityGroupId ?? p.securityGroupId ?? (await describeDb(d, p))?.sgIds[0] ?? null;
  if (sgId) {
    let rules: Rule[] = [];
    try { rules = await ingressRules(d, p, sgId); }
    catch (e) { if (!(e instanceof CliError && /InvalidGroup\.NotFound/.test(e.stderr))) throw e; }
    const ids = rules.filter((r) => (known.ruleIds ?? []).includes(r.id) || r.desc === p.ruleDescription).map((r) => r.id);
    if (ids.length) await markSg(d, p, sgId, true);   // 옛 판이 연 규칙(태그 없음)도 닫을 수 있게
    await revokeRules(d, p, sgId, ids);
    if (ids.length) removed.push(`ingress rules ${ids.length}`);
    // 다른 이전이 같은 보안 그룹에 연 규칙(svc-dblink …)이 남아 있으면 태그를 남긴다
    const othersLeft = rules.some((r) => !ids.includes(r.id) && r.desc.startsWith("svc-dblink "));
    if (!othersLeft) await markSg(d, p, sgId, false);
  }
  return { closed: pending.length === 0, removed, pending };
}
