// GCP 출발 → AWS 도착 DB 복제 중계기 (gcp-aws). 출발 = GCP 프로젝트의 Cloud SQL(공개 IP), 도착 = apply 가 고객 AWS 계정에 새로 만드는 RDS(기존 EKS VPC 의 사설 서브넷).
// 중계기는 도착 AWS 계정(그 VPC 의 공개 서브넷)에 산다 → 도착 실행 역할(svc-operate)을 빌리고 세션 정책은 중계기 동작만 (security STEP_ROLES.relay_target, policy relay).
// 길 넷:
//   L1 워커 → 도착 RDS: 중계 공개 IP:15432 → RDS:5432 (TCP 그대로, TLS 는 워커↔RDS 끝까지). 중계 보안 그룹은 PLATFORM_EGRESS_CIDRS 만 받는다
//   L2 워커 → 출발 Cloud SQL: 공개 IP:5432 바로 (verify-ca, 서버 CA = instances.describe serverCaCert). 승인된 네트워크에 PLATFORM_EGRESS_CIDRS 가 있어야 한다 (고객이 연다, 사전 점검이 본다)
//   L3 도착 RDS → 출발 Cloud SQL (정방향 구독): RDS 는 VPC NAT 로 나간다 → RDS 보안 그룹에 "Cloud SQL 공개 IP/32:5432 로 나가기"(relay-db-egress 태그)를 단다.
//      Cloud SQL 승인된 네트워크에 도착 VPC NAT 공인 IP 가 있어야 한다. DRAFT(ai): 워커가 출발 Cloud SQL 허용 주소를 고치지 않는다 (출발 자원은 읽기만,
//      gcloud --authorized-networks 는 목록 통째 덮어쓰기라 고객 설정을 지울 수 있다) → 사전 점검이 NAT IP 를 읽어 빠지면 막고 고객에게 정확한 값을 알려 준다
//   L4 출발 Cloud SQL → 도착 RDS (롤백 창 역방향 구독): 중계 공개 IP:15432 → RDS:5432. 중계 보안 그룹은 Cloud SQL 나가는 IP/32 만 더 받는다 (aws-gcp L3 의 거울)
// apply 순서: terraform 앞(prepareGcpAwsRelayStep) = 문 + 출발 Cloud SQL 읽기(출발 관찰 역할) → terraform(도착 RDS) → 뒤(provisionGcpAwsRelayStep) = 중계기·RDS 규칙·끝점 두 줄.
//   terraform 을 다시 돌 일이 없다 (Cloud SQL 허용 주소는 고객 몫, RDS 보안 그룹 규칙은 중계기 태그 규칙).
// 지우기: relay-step teardownRelayStep 이 같은 표(relayHome = target)로 도착 계정 태그 자원을 지운다 (cleanup·롤백·repl-cleanup 그대로)
import { tmpdir } from "node:os";
import { envFor, gcpEnvFor, spawnExec, type Exec } from "@svc/adapters";
import type { ReplicationEndpoint, TfOutputs } from "@svc/contracts";
import { readTfFacts } from "@svc/replication";
import { replicationEndpointsFor, withTenant } from "@svc/core";
import { withStepRoles, type StepRoles } from "../jobs/_roles.js";
import type { MigrationRow } from "../jobs/_step.js";
import type { StopHint } from "../jobs/_stop-hint.js";
import {
  buildRelayPlan, discoverRelayNetwork, discoverRelaySource, isIpv4, platformEgressCidrs, provisionRelay, RelayError, resolveRelayAmi,
  PG_PORT, RELAY_SOURCE_PORT, type CloudSqlPeer, type RelayAwsDeps, type RelaySource,
} from "./aws-relay.js";
import {
  ensureTargetAppLogin, readRelayFacts, relayApplies, relayKindOf, saveEndpointRows, sourcePasswordRef,
  type CloudSqlInstanceRef, type RelayFacts, type RelayStepOutcome,
} from "./relay-step.js";

// DRAFT(ai): 서울. 환경 행에 region 이 없을 때 (relay-step DEFAULT_REGION 과 같은 값)
const DEFAULT_REGION = "ap-northeast-2";
// DRAFT(ai): 출발 Cloud SQL 관리자 = Cloud SQL 기본 사용자 postgres (cloudsqlsuperuser: 자기에게 REPLICATION 을 준다, replication ensureReplicationAttr).
//   운영자가 끝점 줄(npm run repl:endpoint -- set)로 다른 계정을 넣었으면 그 줄의 계정·비밀번호 참조를 그대로 둔다
export const GCP_SOURCE_ADMIN_USER = "postgres";

type Job = { tenantId: string; migrationId: string };
type Failed = Extract<RelayStepOutcome, { kind: "failed" }>;

// ── 출발 Cloud SQL 읽기 ──────────────────────────────────────────────────────────────

/** gcloud sql instances describe 에서 중계기·끝점·점검에 쓰는 것만 */
export interface CloudSqlSource {
  project: string; instance: string;
  /** 공개 IP (ipAddresses type PRIMARY). 워커(L2)·도착 RDS 정방향 구독(L3)이 붙는 주소 */
  publicIp: string | null;
  /** 나가는 IP (type OUTGOING). 롤백 창 역방향 구독(L4)이 중계기로 들어오는 출처 */
  outgoingIp: string | null;
  ipv4Enabled: boolean;
  /** 승인된 네트워크 (CIDR 또는 IP 하나) */
  authorizedNetworks: string[];
  /** DB 플래그 cloudsql.logical_decoding = on */
  logicalDecoding: boolean;
  /** ipConfiguration.sslMode (ENCRYPTED_ONLY 등). 옛 인스턴스는 null 이고 requireSsl 만 있다 */
  sslMode: string | null; requireSsl: boolean | null;
  /** 서버 CA 인증서 PEM (공개 값). 워커가 verify-ca 로 확인한다 */
  serverCaPem: string | null;
}

type RawCloudSql = {
  ipAddresses?: { type?: string; ipAddress?: string }[];
  settings?: { ipConfiguration?: { ipv4Enabled?: boolean; authorizedNetworks?: { value?: string }[]; sslMode?: string; requireSsl?: boolean };
    databaseFlags?: { name?: string; value?: string }[] };
  serverCaCert?: { cert?: string };
};
/** 순수: describe JSON → 사실 */
export function cloudSqlSourceOf(ref: CloudSqlInstanceRef, raw: unknown): CloudSqlSource {
  const it = (raw ?? {}) as RawCloudSql;
  const ip = (t: string) => { const v = it.ipAddresses?.find((a) => a.type === t)?.ipAddress ?? ""; return isIpv4(v) ? v : null; };
  const ipc = it.settings?.ipConfiguration;
  const cert = it.serverCaCert?.cert ?? "";
  return {
    project: ref.project, instance: ref.instance,
    publicIp: ip("PRIMARY"), outgoingIp: ip("OUTGOING"),
    ipv4Enabled: ipc?.ipv4Enabled === true,
    authorizedNetworks: (ipc?.authorizedNetworks ?? []).map((a) => String(a.value ?? "").trim()).filter(Boolean).sort(),
    logicalDecoding: (it.settings?.databaseFlags ?? []).some((f) => f.name === "cloudsql.logical_decoding" && String(f.value ?? "").toLowerCase() === "on"),
    sslMode: typeof ipc?.sslMode === "string" ? ipc.sslMode : null, requireSsl: typeof ipc?.requireSsl === "boolean" ? ipc.requireSsl : null,
    serverCaPem: /-----BEGIN CERTIFICATE-----/.test(cert) && !/PRIVATE KEY/.test(cert) ? cert.trim() : null,
  };
}

/** 빌린 출발 관찰 토큰으로 Cloud SQL 하나를 읽는다 (읽기만). 실패는 RELAY_SOURCE_DB_UNKNOWN */
export async function readCloudSqlSource(ref: CloudSqlInstanceRef, env: NodeJS.ProcessEnv, exec: Exec = spawnExec): Promise<CloudSqlSource> {
  const r = await exec(env.GCLOUD_BIN ?? "gcloud", ["sql", "instances", "describe", ref.instance, `--project=${ref.project}`, "--format=json"],
    { cwd: tmpdir(), env, timeoutMs: 60_000 });
  if (r.code !== 0) {
    const why = r.code === 127 ? "gcloud 가 없다 (워커 이미지 확인)" : r.stderr.replace(/\s+/g, " ").trim().slice(-200);
    throw new RelayError("RELAY_SOURCE_DB_UNKNOWN", `출발 Cloud SQL ${ref.instance} 읽기 실패: ${why}`);
  }
  try { return cloudSqlSourceOf(ref, JSON.parse(r.stdout)); }
  catch { throw new RelayError("RELAY_SOURCE_DB_UNKNOWN", `출발 Cloud SQL ${ref.instance}: describe 응답이 JSON 이 아니다`); }
}

// ── 점검 (순수, 사전 점검과 apply 문이 같이 쓴다) ──────────────────────────────────────────

const ip4n = (s: string) => s.split(".").reduce((a, x) => a * 256 + Number(x), 0);
/** outer(CIDR 또는 IP) 가 inner(CIDR 또는 IP) 를 통째로 품는가 */
export function cidrCovers(outer: string, inner: string): boolean {
  const parse = (c: string): [number, number] | null => {
    const [ip, pre = "32"] = c.trim().split("/");
    const n = Number(pre);
    return ip && isIpv4(ip) && Number.isInteger(n) && n >= 0 && n <= 32 ? [ip4n(ip), n] : null;
  };
  const o = parse(outer), i = parse(inner);
  if (!o || !i || o[1] > i[1]) return false;
  const size = 2 ** (32 - o[1]);
  return Math.floor(o[0] / size) === Math.floor(i[0] / size);
}

export interface SourceProblem extends StopHint { id: string; level: "block" | "warn"; message: string }

/** 출발 Cloud SQL 이 이 중계기 길(L2·L3·L4)을 받을 수 있나. natIps = 도착 VPC NAT 공인 IP (모르면 null → 경고만) */
export function cloudSqlSourceProblems(sql: CloudSqlSource, o: { platformCidrs: string[]; natIps?: string[] | null }): SourceProblem[] {
  const out: SourceProblem[] = [];
  const name = sql.instance;
  const patch = `gcloud sql instances patch ${name} --project=${sql.project}`;
  if (!sql.ipv4Enabled || !sql.publicIp)
    out.push({ id: "PC-RELAY-SQL-PUBLIC", level: "block", message: `출발 Cloud SQL ${name} 에 공개 IP 가 없다 (워커·도착 RDS 가 붙을 길이 없음)`,
      missing: [`gcp: Cloud SQL ${name} 공개 IP (ipv4Enabled)`],
      hint: `고객이 ${patch} --assign-ip 로 공개 IP 를 켠다 (승인된 네트워크로만 열린다. 조직 정책 sql.restrictPublicIp 가 막으면 그 프로젝트만 예외)` });
  else if (!sql.outgoingIp)
    out.push({ id: "PC-RELAY-SQL-PUBLIC", level: "block", message: `출발 Cloud SQL ${name} 의 나가는 IP(OUTGOING)를 못 읽었다 (롤백 창 역방향 구독을 중계기가 받을 출처)`,
      missing: [`gcp: Cloud SQL ${name} 나가는 IP (ipAddresses type OUTGOING)`],
      hint: "공개 IP 를 켠 인스턴스는 나가는 IP 를 함께 갖는다. 고객 콘솔 연결 탭에서 나가는 IP 가 보이는지 확인한 뒤 다시 점검한다" });
  const notCovered = (want: string[]) => want.filter((c) => !sql.authorizedNetworks.some((a) => cidrCovers(a, c)));
  const plat = notCovered(o.platformCidrs);
  if (plat.length)
    out.push({ id: "PC-RELAY-SQL-AUTHNET", level: "block", message: `출발 Cloud SQL ${name} 승인된 네트워크에 플랫폼 워커 나가는 대역이 없다 (워커 → Cloud SQL 직접 접속)`,
      missing: plat.map((c) => `gcp: Cloud SQL ${name} 승인된 네트워크 ${c}`),
      hint: `고객이 ${patch} --authorized-networks=<지금 목록>,${plat.join(",")} 로 더한다 (목록 통째 덮어쓰기라 지금 값을 같이 준다)` });
  if (o.natIps === null || o.natIps === undefined)
    out.push({ id: "PC-RELAY-SQL-NAT", level: "warn", message: `도착 VPC 의 NAT 공인 IP 를 못 읽어 출발 Cloud SQL ${name} 승인된 네트워크를 확인 못 했다 (도착 RDS 정방향 구독이 NAT 로 나간다)`,
      missing: ["aws: 도착 VPC NAT 공인 IP"],
      hint: `도착 VPC NAT 게이트웨이 공인 IP/32 를 고객이 ${patch} --authorized-networks 에 더한다. 빠지면 sync 첫 구독이 접속 시간 초과로 멈춘다` });
  else {
    const nat = notCovered(o.natIps.map((x) => `${x}/32`));
    if (!o.natIps.length)
      out.push({ id: "PC-RELAY-SQL-NAT", level: "block", message: "도착 VPC 에 쓸 수 있는 NAT 게이트웨이가 없다 (도착 RDS 정방향 구독이 출발 Cloud SQL 공개 IP 로 나갈 길이 없음)",
        missing: ["aws: 도착 VPC NAT 게이트웨이"], hint: "도착 EKS VPC 의 사설 서브넷이 NAT 게이트웨이로 나가게 한 뒤 다시 점검한다" });
    else if (nat.length)
      out.push({ id: "PC-RELAY-SQL-NAT", level: "block", message: `출발 Cloud SQL ${name} 승인된 네트워크에 도착 VPC NAT 공인 IP 가 없다 (도착 RDS 정방향 구독이 NAT 로 나간다)`,
        missing: nat.map((c) => `gcp: Cloud SQL ${name} 승인된 네트워크 ${c}`),
        hint: `고객이 ${patch} --authorized-networks=<지금 목록>,${nat.join(",")} 로 더한다 (목록 통째 덮어쓰기라 지금 값을 같이 준다)` });
  }
  if (!sql.logicalDecoding)
    out.push({ id: "PC-RELAY-SQL-DECODING", level: "block", message: `출발 Cloud SQL ${name} 의 DB 플래그 cloudsql.logical_decoding 이 on 이 아니다 (논리 복제 발행 불가)`,
      missing: [`gcp: Cloud SQL ${name} 플래그 cloudsql.logical_decoding=on`],
      hint: `고객이 ${patch} --database-flags=<지금 플래그>,cloudsql.logical_decoding=on 으로 켠다 (재시작, 플래그 목록 통째 덮어쓰기라 지금 값을 같이 준다)` });
  if (sql.sslMode === "TRUSTED_CLIENT_CERTIFICATE_REQUIRED" || (sql.sslMode === null && sql.requireSsl === true))
    out.push({ id: "PC-RELAY-SQL-TLS", level: "block", message: `출발 Cloud SQL ${name} 이 클라이언트 인증서를 요구한다 (워커·도착 RDS 구독은 서버 인증서 TLS 만 쓴다)`,
      missing: [`gcp: Cloud SQL ${name} sslMode=ENCRYPTED_ONLY`],
      hint: `고객이 ${patch} --ssl-mode=ENCRYPTED_ONLY 로 바꾼다 (암호화는 그대로 강제, 클라이언트 인증서만 안 요구)` });
  return out;
}

/** 출발 줄 비밀번호 참조와 그 env 이름 (env: 일 때만). 운영자가 cloudsql 줄을 넣어 두었으면 그 참조 */
export function gcpSourcePasswordRef(existing: readonly ReplicationEndpoint[], sourceEnvId: string, migrationId: string): { ref: string; envName: string | null } {
  const old = existing.find((e) => e.side === "source" && e.provider === "cloudsql");
  const ref = old?.passwordRef ?? sourcePasswordRef(null, sourceEnvId, migrationId.replace(/-/g, "").slice(0, 8));
  return { ref, envName: ref.startsWith("env:") ? ref.slice(4) : null };
}
const secretHint = (envName: string): string =>
  `worker-env 비밀(Secrets Manager platform/app JSON)에 출발 Cloud SQL 관리자(${GCP_SOURCE_ADMIN_USER}, 다른 계정이면 npm run repl:endpoint -- set 으로 출발 줄 username) 비밀번호를 ${envName} 로 넣고 `
  + `차트 components.worker.secretKeys 에 ${envName} 을 더해 워커를 다시 띄운 뒤 다시 계획한다`;

// ── 문 (apply 의 terraform 앞) ────────────────────────────────────────────────────────

export type GcpAwsRelayGate =
  | { kind: "skip"; reason: string }
  | ({ kind: "fail"; failureCode: string; reason: string } & Partial<StopHint>)
  | { kind: "go"; cloudSql: CloudSqlSource; platformCidrs: string[]; region: string; db: string; user: string };

/** 순수: 사실 → 문 (Cloud SQL 은 아직 안 읽음). go 의 cloudSql 은 prepare 가 채운다 */
export function gcpAwsRelayGate(f: RelayFacts, env: NodeJS.ProcessEnv): Exclude<GcpAwsRelayGate, { kind: "go" }> | { kind: "ready"; ref: CloudSqlInstanceRef; platformCidrs: string[]; region: string; db: string; user: string } {
  const no = relayApplies(f, env);
  if (no) return { kind: "skip", reason: no };
  if (relayKindOf(f.sourceProvider, f.targetProvider) !== "gcp-aws") return { kind: "skip", reason: "not_gcp_aws_relay" };
  if (!f.postgres.length) return { kind: "skip", reason: "no_postgres" };
  if (f.postgres.length !== 1) return { kind: "fail", failureCode: "RELAY_SOURCE_DB_UNKNOWN", reason: `명세에 postgres 가 ${f.postgres.length}개다 (중계기·끝점 줄은 이전마다 하나)` };
  if (!f.cloudSql) return { kind: "fail", failureCode: "RELAY_SOURCE_DB_UNKNOWN", reason: "명세의 postgres 에 출발 Cloud SQL 인스턴스가 없다 (spec_v2.ids 의 selfLink)",
    missing: ["spec_v2.ids: Cloud SQL selfLink"], hint: "출발 GCP 환경을 다시 가져와(import) 명세에 Cloud SQL 인스턴스가 잡히게 하거나 RELAY_AUTO=0 으로 사람이 끝점 줄을 넣는다 (npm run repl:endpoint -- set)" };
  let platformCidrs: string[];
  try { platformCidrs = platformEgressCidrs(env.PLATFORM_EGRESS_CIDRS); }
  catch (e) {
    const fix: StopHint = { missing: ["PLATFORM_EGRESS_CIDRS"],
      hint: "worker-env 비밀(Secrets Manager platform/app JSON 의 PLATFORM_EGRESS_CIDRS, 차트 components.worker.secretKeys)에 워커 NAT 공인 IP 대역(/24 이상 좁게, 쉼표 목록)을 넣고 워커를 다시 띄운 뒤 다시 계획한다" };
    return { kind: "fail", failureCode: (e as RelayError).code ?? "RELAY_CONFIG_MISSING", reason: `${(e as Error).message} → ${fix.hint}`, ...fix };
  }
  const pg = f.postgres[0]!;
  return { kind: "ready", ref: f.cloudSql, platformCidrs, region: f.targetRegion || DEFAULT_REGION, db: pg.db, user: pg.user };
}

export interface GcpAwsRelayDeps {
  env?: NodeJS.ProcessEnv;
  facts?: RelayFacts;
  /** 출발 Cloud SQL 읽기 (시험이 바꾼다). 기본 = 출발 관찰 역할(STEP_ROLES.relay_source_read)을 빌려 gcloud */
  readSource?: (ref: CloudSqlInstanceRef) => Promise<CloudSqlSource>;
  /** 도착 중계기 역할 빌리기 (시험이 바꾼다). 기본 withStepRoles("relay_target") */
  borrow?: <T>(fn: (r: Pick<StepRoles, "awsEnv" | "denied" | "signal">) => Promise<T>) => Promise<T>;
  aws?: Partial<Pick<RelayAwsDeps, "exec" | "sleep" | "pollMs" | "pollTries">>;
  /** 지금 끝점 줄 (기본 DB 에서 읽음) */
  existing?: readonly ReplicationEndpoint[];
  /** 끝점 줄 쓰기 (기본 withTenant upsert) */
  save?: (rows: ReplicationEndpoint[]) => Promise<void>;
  /** 도착 앱 로그인 역할 맞추기 (관리자 ≠ 앱일 때만). 기본 relay-step ensureTargetAppLogin */
  appLogin?: (target: ReplicationEndpoint) => Promise<"created" | "updated" | "privileged">;
}

/** 출발 관찰 역할을 빌려 Cloud SQL 을 읽는다 (빌림 → 읽기 → 회수가 이 함수 안에서 끝난다) */
async function readSourceBorrowed(j: Job, m: MigrationRow, ref: CloudSqlInstanceRef, env: NodeJS.ProcessEnv): Promise<CloudSqlSource> {
  return withStepRoles("relay_source_read", j, m, async (roles) => {
    const token = roles.gcpToken?.source;
    if (!token) throw new RelayError("RELAY_SOURCE_DB_UNKNOWN", roles.denied.length
      ? `출발 GCP 관찰 역할을 못 빌렸다: ${roles.denied.map((x) => x.code).join(",")}` : "출발 GCP 관찰 역할 토큰이 없다 (출발 환경이 GCP 인지, 연결이 끝났는지)");
    return readCloudSqlSource(ref, gcpEnvFor(token, ref.project, env));
  });
}

/** apply 의 terraform 앞: 문 + 출발 Cloud SQL 이 길을 받을 수 있는지(공개 IP·나가는 IP·승인된 네트워크(플랫폼)·논리 디코딩·TLS) + 출발 비밀번호 env.
 *  짝이 gcp->aws 가 아니면 null (예전 그대로). 실패는 도착 RDS 를 만들기 전에 낸다 */
export async function prepareGcpAwsRelayStep(j: Job, m: MigrationRow, deps: Pick<GcpAwsRelayDeps, "env" | "facts" | "readSource"> = {}): Promise<GcpAwsRelayGate | null> {
  const env = deps.env ?? process.env;
  const facts = deps.facts ?? await withTenant(j.tenantId, (tx) => readRelayFacts(tx, j.tenantId, m, env));
  if (relayKindOf(facts.sourceProvider, facts.targetProvider) !== "gcp-aws") return null;
  const g = gcpAwsRelayGate(facts, env);
  if (g.kind !== "ready") return g;
  const pw = gcpSourcePasswordRef(facts.existing, m.sourceEnvId, j.migrationId);
  if (pw.envName && !env[pw.envName])
    return { kind: "fail", failureCode: "REPL_SECRET_UNRESOLVED", reason: `출발 Cloud SQL 관리자 비밀번호 env ${pw.envName} 가 워커에 없다`,
      missing: [pw.envName], hint: secretHint(pw.envName) };
  let sql: CloudSqlSource;
  try { sql = await (deps.readSource ?? ((ref) => readSourceBorrowed(j, m, ref, env)))(g.ref); }
  catch (e) {
    if (!(e instanceof RelayError)) throw e;
    return { kind: "fail", failureCode: e.code, reason: e.message, missing: [`gcp: Cloud SQL ${g.ref.instance} 읽기 (svc-observe cloudsql.instances.get)`],
      hint: "출발 GCP 연결(svc-observe)이 살아 있는지, 인스턴스 이름·프로젝트가 명세와 같은지 확인한 뒤 다시 계획한다" };
  }
  // NAT IP 는 도착 관찰 역할로 사전 점검이 본다 (apply 의 중계기 역할에는 NAT 읽기가 없다) → 여기서는 NAT 를 빼고 막힘만
  const bad = cloudSqlSourceProblems(sql, { platformCidrs: g.platformCidrs, natIps: [] }).filter((p) => p.level === "block" && p.id !== "PC-RELAY-SQL-NAT");
  if (bad.length)
    return { kind: "fail", failureCode: "RELAY_SOURCE_DB_UNKNOWN", reason: bad.map((p) => p.message).join(" / "),
      missing: bad.flatMap((p) => p.missing), hint: bad.map((p) => p.hint).join(" / ") };
  return { kind: "go", cloudSql: sql, platformCidrs: g.platformCidrs, region: g.region, db: g.db, user: g.user };
}

// ── 끝점 두 줄 (순수) ──────────────────────────────────────────────────────────────────

/** 도착 관리자와 비밀번호 키: terraform 이 관리자를 앱과 나눴으면(db_admin_username) 그 계정 + db_admin_password, 아니면 RDS 마스터(= 앱 계정) + db_password */
export function targetAdminOf(out: TfOutputs): { admin: string | null; app: string | null; passwordKey: "db_admin_password" | "db_password" } {
  const app = out.db_username || null;
  return out.db_admin_username ? { admin: out.db_admin_username, app, passwordKey: "db_admin_password" } : { admin: app, app, passwordKey: "db_password" };
}

/** GCP 출발 → AWS 도착 끝점 두 줄.
 *  출발 = Cloud SQL 공개 IP:5432 (워커 verify-ca, 도착 RDS 구독도 같은 주소로 NAT 를 지나 붙는다).
 *  도착 = 중계 공개 IP:15432 (워커, 진짜 RDS 이름은 tls_servername) + 같은 입구를 롤백 창 역방향 구독(Cloud SQL)의 peer 로 */
export function gcpAwsEndpointRows(i: {
  tenantId: string; migrationId: string; sourceEnvId: string; cloudSql: CloudSqlSource; db: string; appUser: string;
  rds: RelaySource; publicIp: string; out: TfOutputs; existing: readonly ReplicationEndpoint[];
}): [ReplicationEndpoint, ReplicationEndpoint] {
  const id8 = i.migrationId.replace(/-/g, "").slice(0, 8);
  if (!i.cloudSql.publicIp) throw new RelayError("RELAY_SOURCE_DB_UNKNOWN", `출발 Cloud SQL ${i.cloudSql.instance} 에 공개 IP 가 없다`);
  const t = targetAdminOf(i.out);
  if (!t.admin) throw new RelayError("RELAY_TARGET_DB_UNKNOWN", "terraform 출력에 도착 RDS 계정(db_username)이 없다 (aws/root 모듈이 옛 판)");
  // 운영자가 넣은 cloudsql 출발 줄이면 계정·비밀번호 참조를 그대로 둔다 (다른 관리자 계정)
  const oldS = i.existing.find((e) => e.side === "source" && e.provider === "cloudsql");
  const oldT = i.existing.find((e) => e.side === "target" && e.provider === "rds");
  const ca = i.cloudSql.serverCaPem;
  const source: ReplicationEndpoint = {
    tenantId: i.tenantId, migrationId: i.migrationId, side: "source", label: `cloudsql-src-${id8}`, provider: "cloudsql",
    host: i.cloudSql.publicIp, port: PG_PORT, dbname: i.db,
    username: oldS?.username ?? GCP_SOURCE_ADMIN_USER,
    passwordRef: gcpSourcePasswordRef(i.existing, i.sourceEnvId, i.migrationId).ref,
    // 도착 RDS(사설 서브넷)는 VPC NAT 로 같은 공개 IP 에 붙는다 (Cloud SQL 승인된 네트워크 = NAT 공인 IP)
    peerHost: i.cloudSql.publicIp, peerPort: PG_PORT,
    appRole: i.appUser, fenceRoles: oldS?.fenceRoles ?? [], schemaName: oldS?.schemaName ?? null,
    // 워커 → Cloud SQL 은 서버 CA 로 확인 (인증서에 공개 IP 이름이 없어 verify-full 대신 verify-ca). 상대(RDS)는 require (endpoint.ts peerTlsProblem)
    sslmode: ca ? "verify-ca" : "require", tlsServername: null, caPem: ca,
    relayHost: null, relayKnownHosts: null, relayPort: 22,
  };
  const target: ReplicationEndpoint = {
    tenantId: i.tenantId, migrationId: i.migrationId, side: "target", label: `rds-tgt-${id8}`, provider: "rds",
    // DRAFT(ai): 워커는 사설 RDS 에 직접 못 닿는다 (플랫폼 EKS 와 다른 VPC·계정) → 중계 입구(공개 IP:15432, TCP 그대로). 진짜 RDS 이름은 tls_servername
    host: i.publicIp, port: RELAY_SOURCE_PORT, dbname: i.out.db_name || i.db,
    username: t.admin, passwordRef: `tf:${t.passwordKey}`,
    // 롤백 창 역방향 구독: 출발 Cloud SQL → 같은 입구 (중계 보안 그룹이 Cloud SQL 나가는 IP/32 만 받는다)
    peerHost: i.publicIp, peerPort: RELAY_SOURCE_PORT,
    appRole: t.app ?? i.appUser, fenceRoles: oldT?.fenceRoles ?? [], schemaName: oldT?.schemaName ?? null,
    sslmode: oldT?.sslmode ?? "require", tlsServername: i.rds.endpoint, caPem: oldT?.caPem ?? null,
    relayHost: null, relayKnownHosts: null, relayPort: 22,
  };
  return [source, target];
}

// ── 만들기 (apply 의 terraform 뒤) ─────────────────────────────────────────────────────

const TARGET_FIX: Record<"role_denied" | "no_cred" | "aws_denied" | "db_secret", StopHint> = {
  role_denied: { missing: ["aws: 도착 svc-operate 인라인 정책 relay"],
    hint: "도착 AWS 연결 스택(CloudFormation svc-connect-*)을 새 템플릿으로 업데이트해 svc-operate 에 중계기 정책(relay = infra/permissions/aws-relay-statements.json)을 붙이고 다시 계획·승인한다" },
  no_cred: { missing: ["aws: 도착 svc-operate"], hint: "도착 AWS 환경을 연결 링크(CloudFormation 연결 스택, ExternalId)로 연결했는지 확인한 뒤 다시 계획·승인한다" },
  aws_denied: { missing: ["aws: 도착 svc-operate 인라인 정책 relay (TargetDbRulesForRelay)"],
    hint: "도착 AWS 연결 스택을 새 템플릿으로 업데이트해 svc-operate 의 중계기 정책(relay)을 지금 판으로 맞춘 뒤 다시 계획·승인한다" },
  db_secret: { missing: ["db-secret.json: db_password"],
    hint: "terraform apply 뒤 도착 RDS 관리 비밀(Secrets Manager rds!db-…)을 못 꺼냈다(감사 terraform.secretFetched): 도착 svc-operate 에 secretsmanager:GetSecretValue 가 있는지, 워커 TF_FETCH_DB_SECRET 을 끄지 않았는지 확인한 뒤 다시 계획·승인한다" },
};
const AWS_DENIED = /^(UnauthorizedOperation|AccessDenied)/;
function failure(e: unknown, extra: Record<string, unknown> = {}): Failed {
  if (!(e instanceof RelayError)) throw e;
  const fix = e.code === "RELAY_DB_EGRESS_DENIED" || e.code === "RELAY_DB_INGRESS_DENIED" || AWS_DENIED.test(e.awsCode ?? "") ? TARGET_FIX.aws_denied : undefined;
  const tag = "만든 자원은 태그(managed-by=platform, svc:migration=<이전>)를 단 채 도착 계정에 남는다. 원인을 고친 뒤 다시 계획·승인하면 태그로 찾아 이어 간다. 취소하면 repl-cleanup 이 태그로 지운다";
  return { kind: "failed", failureCode: e.code, reason: e.message,
    detail: { ...extra, ...(e.awsCode ? { awsCode: e.awsCode } : {}), ...(fix ? { missing: fix.missing } : {}), hint: fix ? `${fix.hint} / ${tag}` : tag } };
}

/** RDS 엔드포인트(<식별자>.<무작위>.<지역>.rds.amazonaws.com) → 식별자 */
export const rdsIdentifierOfAddress = (address: string | undefined): string | null =>
  /^([A-Za-z][A-Za-z0-9-]{0,62})\.[a-z0-9]+\.[a-z0-9-]+\.rds\.amazonaws\.com$/.exec(address ?? "")?.[1] ?? null;

/** 도착 계정에 중계기를 만들고(이미 있으면 그대로) 도착 RDS 보안 그룹 규칙 둘(중계기에서 들어오기·Cloud SQL 공개 IP 로 나가기)을 달고 끝점 두 줄을 쓴다.
 *  다시 불러도 된다 (작업 재시도·다시 계획). 관리자 ≠ 앱이면 도착 앱 로그인 역할도 맞춘다 */
export async function provisionGcpAwsRelayStep(j: Job, m: MigrationRow, g: Extract<GcpAwsRelayGate, { kind: "go" }>, out: TfOutputs,
  deps: Omit<GcpAwsRelayDeps, "facts" | "readSource"> = {}): Promise<RelayStepOutcome> {
  const env = deps.env ?? process.env;
  const identifier = rdsIdentifierOfAddress(out.db_address);
  if (!identifier) return { kind: "failed", failureCode: "RELAY_TARGET_DB_UNKNOWN", reason: "terraform 출력에 도착 RDS 주소(db_address)가 없거나 RDS 엔드포인트 모양이 아니다",
    detail: { missing: ["terraform output: db_address"], hint: "명세에 postgres 가 하나인지(aws/root 는 하나일 때만 db_address 를 낸다) 확인한 뒤 다시 계획한다" } };
  const t = targetAdminOf(out);
  const keys = [...new Set([t.passwordKey, ...(t.admin !== t.app ? ["db_password" as const] : [])])];
  const tf = readTfFacts(j.migrationId, env);
  const noSecret = keys.filter((k) => !tf[k]);
  if (noSecret.length)
    return { kind: "failed", failureCode: "RELAY_TARGET_DB_UNKNOWN", reason: `이전 작업 폴더 db-secret.json 에 도착 DB 비밀번호(${noSecret.join("·")})가 없다 (apply 의 비밀 꺼내기 실패)`,
      detail: { missing: noSecret.map((k) => `db-secret.json: ${k}`), hint: TARGET_FIX.db_secret.hint } };
  const cloudSql: CloudSqlPeer = { publicIp: g.cloudSql.publicIp ?? "", outgoingIp: g.cloudSql.outgoingIp ?? "" };
  const borrow = deps.borrow ?? (<T>(fn: (r: StepRoles) => Promise<T>) => withStepRoles("relay_target", j, m, fn));
  return borrow(async (roles): Promise<RelayStepOutcome> => {
    const cred = roles.awsEnv?.target;
    if (!cred) return { kind: "failed", failureCode: "RELAY_ROLE_DENIED", reason: roles.denied.length
      ? `도착 실행 역할(중계기 세션 정책)을 못 빌렸다: ${roles.denied.map((x) => x.code).join(",")} (infra/permissions/aws-relay-statements.json 을 도착 svc-operate 에 붙였는지)`
      : "도착 실행 역할 자격이 없다 (도착 환경이 AWS 인지, 연결이 끝났는지)",
      detail: { ...(roles.denied.length ? TARGET_FIX.role_denied : TARGET_FIX.no_cred) } };
    const d: RelayAwsDeps = { env: envFor(cred, env), region: g.region, ...(roles.signal ? { signal: roles.signal } : {}), ...deps.aws };
    let rds: RelaySource, subnetId: string, res: Awaited<ReturnType<typeof provisionRelay>>;
    try {
      rds = await discoverRelaySource(d, identifier);
      if (rds.endpoint !== out.db_address)
        throw new RelayError("RELAY_TARGET_DB_UNKNOWN", `도착 RDS ${identifier} 의 엔드포인트가 terraform 출력과 다르다`);
      const [net, ami] = await Promise.all([discoverRelayNetwork(d, rds.vpcId), resolveRelayAmi(d)]);
      subnetId = net.subnetId;
      res = await provisionRelay(d, buildRelayPlan({ kind: "gcp-aws", migrationId: j.migrationId, rds, network: net, ami, platformEgressCidrs: g.platformCidrs, cloudSql }));
    } catch (e) { return failure(e, { rdsIdentifier: identifier }); }
    const existing = deps.existing ?? await withTenant(j.tenantId, (tx) => replicationEndpointsFor(tx, j.migrationId));
    let rows: [ReplicationEndpoint, ReplicationEndpoint];
    try {
      rows = gcpAwsEndpointRows({ tenantId: j.tenantId, migrationId: j.migrationId, sourceEnvId: m.sourceEnvId, cloudSql: g.cloudSql, db: g.db, appUser: g.user,
        rds, publicIp: res.publicIp, out, existing });
    } catch (e) { return failure(e); }
    await (deps.save ?? ((r) => saveEndpointRows(j.tenantId, r)))(rows);
    // 관리자와 앱 계정이 나뉜 도착(db_admin_username)이면 앱 로그인 역할을 SQL 로 맞춘다 (aws-gcp 와 같음). 같으면(RDS 마스터 = 앱) 손대지 않는다:
    //   그 계정은 rds_superuser 라 sync 첫 점검 DB-08 이 REPL_APP_ROLE_UNFENCEABLE 로 멈춘다 (롤백 울타리가 안 먹음을 숨기지 않는다)
    let appLogin: string = "same_as_admin";
    if (t.admin !== t.app) {
      try { appLogin = await (deps.appLogin ?? ensureTargetAppLogin)(rows[1]); }
      catch (e) {
        return { kind: "failed", failureCode: "TARGET_APP_LOGIN_FAILED", reason: `도착 앱 로그인 역할을 못 맞췄다: ${((e as Error)?.message ?? String(e)).slice(0, 300)}`,
          detail: { missing: ["워커 → 중계 공개 IP:15432 → 도착 RDS:5432"], hint: "PLATFORM_EGRESS_CIDRS·중계 보안 그룹·도착 RDS 보안 그룹(중계기에서 들어오기)·db-secret.json 관리자 비밀을 확인한 뒤 다시 승인한다" } };
      }
    }
    // 감사 detail: 번호·주소만 (비밀번호 없음). 자원의 진실은 태그다
    return { kind: "ok", detail: { kind: "gcp-aws", instanceId: res.instanceId, securityGroupId: res.securityGroupId, publicIp: res.publicIp, privateIp: res.privateIp, subnetId,
      rdsIdentifier: rds.identifier, rdsSecurityGroupId: rds.securityGroupIds[0],
      dbIngressRuleId: res.dbIngressRuleId, ...(res.dbIngressCoveredBy ? { dbIngressCoveredBy: res.dbIngressCoveredBy } : {}),
      dbEgressRuleId: res.dbEgressRuleId, ...(res.dbEgressCoveredBy ? { dbEgressCoveredBy: res.dbEgressCoveredBy } : {}),
      created: res.created, reused: res.reused, region: g.region, entryPort: RELAY_SOURCE_PORT,
      cloudSql: { instance: g.cloudSql.instance, publicIp: g.cloudSql.publicIp, outgoingIp: g.cloudSql.outgoingIp },
      appLogin, ...(t.admin === t.app ? { targetAppRoleIsAdmin: true } : {}), sourceTls: rows[0].sslmode, endpointRows: ["source", "target"] } };
  });
}

// ── 사전 점검 (승인 전) ─────────────────────────────────────────────────────────────────

export interface GcpAwsPrecheckItem { id: string; level: "block" | "warn" | "info"; message: string; fix?: string }
export interface GcpAwsPrecheckDeps {
  facts?: RelayFacts;
  exec?: Exec;
  /** 도착 VPC 번호 (TF_FACT_VPC_ID 또는 실자원 읽기 targetFacts.vpcId). 모르면 NAT 를 못 본다 */
  targetVpcId?: string | null;
}
const item = (p: SourceProblem): GcpAwsPrecheckItem => ({ id: p.id, level: p.level,
  message: `${p.level === "block" ? "FAIL" : "WARN"} ${p.message} — 빠진 것: ${p.missing.join(", ")}`.slice(0, 1000), fix: p.hint });

/** 도착 VPC 의 쓸 수 있는 NAT 게이트웨이 공인 IP (빌린 도착 관찰 역할, ec2:DescribeNatGateways). 못 읽으면 null */
export async function readTargetNatIps(vpcId: string, env: NodeJS.ProcessEnv, region: string, exec: Exec = spawnExec): Promise<string[] | null> {
  if (!/^vpc-[0-9a-f]+$/.test(vpcId)) return null;
  const r = await exec(env.AWS_BIN ?? "aws", ["ec2", "describe-nat-gateways", "--filter", `Name=vpc-id,Values=${vpcId}`, "Name=state,Values=available",
    "--region", region, "--output", "json"], { cwd: tmpdir(), env, timeoutMs: 30_000 });
  if (r.code !== 0) return null;
  try {
    const j = JSON.parse(r.stdout) as { NatGateways?: { NatGatewayAddresses?: { PublicIp?: string }[] }[] };
    return [...new Set((j.NatGateways ?? []).flatMap((n) => (n.NatGatewayAddresses ?? []).map((a) => a.PublicIp ?? "")).filter(isIpv4))].sort();
  } catch { return null; }
}

/** 승인 전에 GCP 출발 → AWS 도착 중계기 길을 본다 (짝이 다르거나 흉내 자격이면 []).
 *  막는 것: 플랫폼 대역 없음 · Cloud SQL 못 찾음·못 읽음 · 공개 IP·나가는 IP 없음 · 승인된 네트워크에 플랫폼 대역·도착 NAT IP 없음 · 논리 디코딩 꺼짐 · 클라이언트 인증서 요구 · 출발 비밀번호 env 없음 */
export async function gcpAwsRelayPrecheck(j: Job, m: Pick<MigrationRow, "id" | "sourceEnvId" | "targetEnvId">, roles: Pick<StepRoles, "awsEnv" | "gcpToken"> | undefined,
  env: NodeJS.ProcessEnv, deps: GcpAwsPrecheckDeps = {}): Promise<GcpAwsPrecheckItem[]> {
  const facts = deps.facts ?? await withTenant(j.tenantId, (tx) => readRelayFacts(tx, j.tenantId, m, env));
  if (relayKindOf(facts.sourceProvider, facts.targetProvider) !== "gcp-aws") return [];
  const g = gcpAwsRelayGate(facts, env);
  if (g.kind === "skip") return [];
  if (g.kind === "fail")
    return [{ id: "PC-RELAY-GCP-AWS", level: "block", message: `FAIL ${g.reason}${g.missing ? ` — 빠진 것: ${g.missing.join(", ")}` : ""}`.slice(0, 1000), ...(g.hint ? { fix: g.hint } : {}) }];
  const out: GcpAwsPrecheckItem[] = [];
  const pw = gcpSourcePasswordRef(facts.existing, m.sourceEnvId, j.migrationId);
  if (pw.envName && !env[pw.envName])
    out.push({ id: "PC-RELAY-SQL-SECRET", level: "block", message: `FAIL 출발 Cloud SQL 관리자 비밀번호가 워커에 없다 — 빠진 것: ${pw.envName}`, fix: secretHint(pw.envName) });
  const token = roles?.gcpToken?.source;
  if (!token) {
    out.push({ id: "PC-RELAY-SQL-READ", level: "block", message: `FAIL 출발 GCP 관찰 토큰이 없어 Cloud SQL ${g.ref.instance} 을 못 읽었다 — 빠진 것: gcp: svc-observe`,
      fix: "출발 GCP 연결(gcp-connect.sh, svc-observe)이 끝났는지 확인한 뒤 다시 점검한다" });
    return out;
  }
  let sql: CloudSqlSource;
  try { sql = await readCloudSqlSource(g.ref, gcpEnvFor(token, g.ref.project, env), deps.exec); }
  catch (e) {
    if (!(e instanceof RelayError)) throw e;
    out.push({ id: "PC-RELAY-SQL-READ", level: "block", message: `FAIL ${e.message} — 빠진 것: gcp: Cloud SQL ${g.ref.instance} (cloudsql.instances.get)`.slice(0, 1000),
      fix: "출발 GCP 연결(svc-observe)이 살아 있는지, 인스턴스 이름·프로젝트가 명세와 같은지 확인한 뒤 다시 점검한다" });
    return out;
  }
  const awsEnv = roles?.awsEnv?.target;
  const natIps = awsEnv && deps.targetVpcId ? await readTargetNatIps(deps.targetVpcId, envFor(awsEnv, env), g.region, deps.exec) : null;
  return [...out, ...cloudSqlSourceProblems(sql, { platformCidrs: g.platformCidrs, natIps }).map(item)];
}
