// GCP ↔ 온프레 DB 복제 중계기 (gcp-onprem, onprem-gcp). AWS ↔ 온프레 중계기(relay-step aws-onprem, onprem-aws)와 같은 모양을 GCE VM 하나로 세운다.
//   모양이 같은 것: sshd 설정(tunnel 계정, PermitOpen <DB>:5432, PermitListen 0.0.0.0:5432), 플랫폼 입구 :15432(forwarder), 호스트 키 파생, 끝점 두 줄의 칸
//   GCP 라서 다른 것:
//     ① 중계기는 Cloud SQL 이 붙은 VPC(사설 서비스 연결, PSA) 안의 GCE VM. Cloud SQL 은 사설 IP 만 있어도 된다 (공개 IP·승인된 네트워크를 고객이 열 필요 없음)
//     ② 보안 그룹 대신 VPC 방화벽 규칙 셋 (네트워크 태그 svc-relay-<이전>): 22 ← 온프레 나가는 IP/32, 15432 ← 플랫폼 대역, 5432 ← 플랫폼 대역 + PSA 대역(Cloud SQL 구독)
//     ③ 태그 대신 라벨(managed-by=platform, svc-migration=<이전>)과 정해진 이름으로 찾고 지운다
//     ④ 서버 인증서에 IP 이름이 없다 → 워커 → Cloud SQL 은 verify-ca (서버 CA = instances.describe serverCaCert). 진짜 DB 주소(사설 IP)는 tls_servername 칸에 둔다
//        (온프레 정방향 터널 목적지 = replication-delivery forwardTarget = tls_servername)
//   자격: GCP 토큰은 범위를 못 좁힌다 → 실행 역할(svc-operate) 토큰을 그대로 쓴다 (security STEP_ROLES relay_gcp·relay_gcp_target)
// 길 (gcp-onprem, 중계기 = 출발 Cloud SQL 의 VPC):
//   워커 → 출발 Cloud SQL: 중계 공개 IP:15432 → Cloud SQL 사설 IP:5432
//   워커 → 도착 온프레 CNPG: 중계 공개 IP:5432 (온프레 터널 -R)
//   온프레 CNPG → 출발 Cloud SQL (정방향 구독): 터널 -L → 중계 → Cloud SQL 사설 IP:5432
//   출발 Cloud SQL → 온프레 CNPG (롤백 창 역방향 구독): 중계 사설 IP:5432 → 터널 -R
// 길 (onprem-gcp, 중계기 = 도착 Cloud SQL 의 VPC, 이전 전용 프로젝트): 위와 거울 (Cloud SQL 이 도착)
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gcpEnvFor, spawnExec, type Exec } from "@svc/adapters";
import type { ReplicationEndpoint, TfOutputs } from "@svc/contracts";
import { deriveReplPassword, readTfFacts } from "@svc/replication";
import { replicationEndpointsFor, withTenant } from "@svc/core";
import { withStepRoles, type StepRoles } from "../jobs/_roles.js";
import type { MigrationRow } from "../jobs/_step.js";
import type { StopHint } from "../jobs/_stop-hint.js";
import { deriveSshHostKey, deriveSshKeypair, knownHostsLine, MIN_MASTER_KEY_LENGTH, type SshKeypair } from "../gitops/migration-secrets.js";
import { isIpv4, platformEgressCidrs, relayUserData, RelayError, PG_PORT, RELAY_SOURCE_PORT } from "./aws-relay.js";
import {
  ensureTargetAppLogin, readRelayFacts, relayApplies, relayKindOf, saveEndpointRows, GCP_TARGET_PASSWORD_REF, RELAY_TARGET_PASSWORD_REF, RELAY_TARGET_USER,
  type CloudSqlInstanceRef, type RelayFacts, type RelayStepOutcome,
} from "./relay-step.js";
import { gcpSourcePasswordRef, targetAdminOf } from "./gcp-aws.js";

export type GcpRelayKind = "gcp-onprem" | "onprem-gcp";
export const isGcpRelayKind = (k: string | null | undefined): k is GcpRelayKind => k === "gcp-onprem" || k === "onprem-gcp";

// DRAFT(ai): 가장 작은 공유 코어 e2-micro + Debian 12 (python3·OpenSSH 9 이 들어 있다). 터널 몇 개만 나르는 중계라 충분하다 【추정, 실측 전】
export const GCP_RELAY_MACHINE_TYPE = "e2-micro";
export const GCP_RELAY_IMAGE = { family: "debian-12", project: "debian-cloud" } as const;
export const GCP_RELAY_LABEL = { managedBy: "managed-by", migration: "svc-migration", role: "svc-role" } as const;
/** 다시 돌 때 VM 의 목적지(Cloud SQL 사설 IP)가 지금과 같은지 보는 메타데이터 키 */
export const GCP_RELAY_TARGET_KEY = "svc-relay-target";
const PROJECT = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const UUID = /^[0-9a-f-]{36}$/;
const GCLOUD_TIMEOUT_MS = 180_000;

type Job = { tenantId: string; migrationId: string };
type Failed = Extract<RelayStepOutcome, { kind: "failed" }>;

export const gcpRelayName = (migrationId: string) => `svc-relay-${migrationId}`;

// 출발 Cloud SQL 이전 전용 복제 계정 (gcp-onprem). 사람이 postgres 비밀번호를 워커 env 에 넣지 않게 워커가 직접 만든다.
//   비밀번호 = derive:cloudsql_repl (REPL_SECRET_MASTER_KEY 로 회사·이전·쪽마다 파생, 줄에는 참조만). 정리 때 지운다
// DRAFT(ai): Cloud SQL API 로 만든 계정은 cloudsqlsuperuser (기본 postgres 계정과 같은 권한). REPLICATION 은 복제 단계가 준다 (replication ensureReplicationAttr)
export const GCP_REPL_PURPOSE = "cloudsql_repl";
export const gcpReplUser = (migrationId: string) => `svc_repl_${migrationId.replace(/-/g, "").slice(0, 8)}`;

// ── 1. Cloud SQL 사설 사실 (순수) ───────────────────────────────────────────────────────

export interface CloudSqlPrivate {
  project: string; instance: string;
  /** 사설 IP (ipAddresses type PRIVATE). 중계기가 이 주소로 붙는다 */
  privateIp: string | null;
  /** settings.ipConfiguration.privateNetwork = projects/<p>/global/networks/<n> */
  network: string | null;
  region: string | null; zone: string | null;
  serverCaPem: string | null;
  logicalDecoding: boolean;
  /** 클라이언트 인증서를 요구하면 true (터널 구독·워커는 서버 인증서 TLS 만 쓴다) */
  clientCertRequired: boolean;
  /** 지금 DB 플래그 전부 (patch --database-flags 는 목록을 통째 덮어써서 켤 때 같이 준다). 없으면 빈 목록 */
  flags?: { name: string; value: string }[];
  /** RUNNABLE 등. 플래그를 켠 뒤 재시작이 끝났나 볼 때 쓴다 */
  state?: string | null;
}
type RawSql = {
  state?: string;
  region?: string; gceZone?: string;
  ipAddresses?: { type?: string; ipAddress?: string }[];
  settings?: { ipConfiguration?: { privateNetwork?: string; sslMode?: string; requireSsl?: boolean }; databaseFlags?: { name?: string; value?: string }[] };
  serverCaCert?: { cert?: string };
};
export function cloudSqlPrivateOf(ref: CloudSqlInstanceRef, raw: unknown): CloudSqlPrivate {
  const it = (raw ?? {}) as RawSql;
  const ip = it.ipAddresses?.find((a) => a.type === "PRIVATE")?.ipAddress ?? "";
  const net = it.settings?.ipConfiguration?.privateNetwork ?? "";
  const cert = it.serverCaCert?.cert ?? "";
  const ipc = it.settings?.ipConfiguration;
  return {
    project: ref.project, instance: ref.instance,
    privateIp: isIpv4(ip) ? ip : null,
    network: /^projects\/[a-z][a-z0-9-]{4,28}[a-z0-9]\/global\/networks\/[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/.test(net) ? net : null,
    region: /^[a-z]+-[a-z]+\d+$/.test(it.region ?? "") ? it.region! : null,
    zone: /^[a-z]+-[a-z]+\d+-[a-z]$/.test(it.gceZone ?? "") ? it.gceZone! : null,
    serverCaPem: /-----BEGIN CERTIFICATE-----/.test(cert) && !/PRIVATE KEY/.test(cert) ? cert.trim() : null,
    logicalDecoding: (it.settings?.databaseFlags ?? []).some((f) => f.name === "cloudsql.logical_decoding" && String(f.value ?? "").toLowerCase() === "on"),
    clientCertRequired: ipc?.sslMode === "TRUSTED_CLIENT_CERTIFICATE_REQUIRED" || (ipc?.sslMode === undefined && ipc?.requireSsl === true),
    flags: (it.settings?.databaseFlags ?? []).filter((f) => typeof f.name === "string").map((f) => ({ name: f.name!, value: String(f.value ?? "") })),
    state: typeof it.state === "string" ? it.state : null,
  };
}

export interface PrivateProblem extends StopHint { id: string; message: string }
/** 이 중계기 길로 쓸 수 있는 Cloud SQL 인가. side = 출발이면 논리 디코딩도 본다 */
export function cloudSqlPrivateProblems(sql: CloudSqlPrivate, side: "source" | "target"): PrivateProblem[] {
  const out: PrivateProblem[] = [];
  const patch = `gcloud sql instances patch ${sql.instance} --project=${sql.project}`;
  if (!sql.privateIp || !sql.network)
    out.push({ id: "PC-RELAY-SQL-PRIVATE", message: `Cloud SQL ${sql.instance} 에 사설 IP(사설 서비스 연결)가 없다 (중계기가 같은 VPC 에서 붙을 주소가 없음)`,
      missing: [`gcp: Cloud SQL ${sql.instance} 사설 IP (ipConfiguration.privateNetwork)`],
      hint: `VPC 에 사설 서비스 연결(PSA)을 만들고 ${patch} --network=<VPC> 로 사설 IP 를 켠 뒤 다시 계획한다` });
  if (side === "source" && !sql.logicalDecoding)
    out.push({ id: "PC-RELAY-SQL-DECODING", message: `출발 Cloud SQL ${sql.instance} 의 DB 플래그 cloudsql.logical_decoding 이 on 이 아니다 (논리 복제 발행 불가)`,
      missing: [`gcp: Cloud SQL ${sql.instance} 플래그 cloudsql.logical_decoding=on`],
      hint: `${patch} --database-flags=<지금 플래그>,cloudsql.logical_decoding=on (재시작, 플래그 목록 통째 덮어쓰기라 지금 값을 같이 준다)` });
  if (sql.clientCertRequired)
    out.push({ id: "PC-RELAY-SQL-TLS", message: `Cloud SQL ${sql.instance} 이 클라이언트 인증서를 요구한다 (워커·구독은 서버 인증서 TLS 만 쓴다)`,
      missing: [`gcp: Cloud SQL ${sql.instance} sslMode=ENCRYPTED_ONLY`], hint: `${patch} --ssl-mode=ENCRYPTED_ONLY` });
  return out;
}

/** terraform 출력 db_connection_name(<프로젝트>:<지역>:<인스턴스>) → 인스턴스 참조 */
export function cloudSqlRefOfConnectionName(name: string | undefined): CloudSqlInstanceRef | null {
  const m = /^([a-z][a-z0-9-]{4,28}[a-z0-9]):[a-z]+-[a-z]+\d+:([a-z][a-z0-9-]{0,97})$/.exec(name ?? "");
  return m ? { project: m[1]!, instance: m[2]! } : null;
}

// ── 2. 계획 (순수) ────────────────────────────────────────────────────────────────

export interface GcpFirewallRule { name: string; port: number; sources: string[]; description: string }
export interface GcpRelayPlan {
  kind: GcpRelayKind; migrationId: string;
  project: string; zone: string; networkUrl: string; subnetUrl: string;
  instanceName: string; networkTag: string; labels: Record<string, string>;
  /** VM 이 터널·입구로 나르는 DB 주소 (Cloud SQL 사설 IP) */
  dbHost: string;
  startupScript: string;
  firewalls: GcpFirewallRule[];
  hostPublicKey: string;
}

const CIDR = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/;
const cidrOk = (c: string, minPrefix: number) => { const m = CIDR.exec(c); return !!m && isIpv4(m[1]!) && Number(m[2]) >= minPrefix && Number(m[2]) <= 32; };
const uniqSorted = (xs: string[]) => [...new Set(xs)].sort();

/** GCE 시작 스크립트 = AWS 중계기 user-data(relayUserData) + Debian·GCE 차이 몇 줄.
 *  GCE 손님 에이전트가 호스트 키를 다시 만들지 않게 하고(set_host_keys=false), sshd 권한 분리 폴더를 만들고, python3 가 없으면 깐다 */
export function gceRelayStartupScript(i: { migrationId: string; dbHost: string; tunnelPublicKey: string; hostKey: SshKeypair }): string {
  const base = relayUserData({ migrationId: i.migrationId, rdsEndpoint: i.dbHost, tunnelPublicKey: i.tunnelPublicKey, hostKey: i.hostKey });
  const debian = [
    "# GCE (Debian 12): 손님 에이전트가 호스트 키를 바꾸지 않게, sshd 설정 검사용 폴더, forwarder 용 python3",
    "mkdir -p /etc/default",
    "printf '[InstanceSetup]\\nset_host_keys = false\\n' > /etc/default/instance_configs.cfg",
    "chmod 644 /etc/default/instance_configs.cfg",
    "mkdir -p /run/sshd",
    "command -v python3 >/dev/null 2>&1 || { apt-get update -y && DEBIAN_FRONTEND=noninteractive apt-get install -y python3-minimal; }",
  ];
  if (!base.includes("\numask 077\n")) throw new RelayError("RELAY_PROVISION_FAILED", "중계기 시작 스크립트 모양이 바뀌었다 (umask 줄 없음)");
  return base.replace("\numask 077\n", `\numask 077\n${debian.join("\n")}\n`);
}

/** 방화벽 규칙 셋. 22 = 온프레 나가는 IP/32 만, 15432 = 플랫폼 대역만, 5432 = 플랫폼 대역(워커 → 역방향 터널) + PSA 대역(Cloud SQL → 역방향 터널) */
export function gcpRelayFirewalls(i: { migrationId: string; onpremEgressIp: string; platformEgressCidrs: string[]; psaRanges: string[]; dbHost: string }): GcpFirewallRule[] {
  if (!isIpv4(i.onpremEgressIp)) throw new RelayError("RELAY_PROVISION_FAILED", "온프레 나가는 IP 가 IPv4 가 아니다");
  if (!i.platformEgressCidrs.length || i.platformEgressCidrs.some((c) => !cidrOk(c, 24))) throw new RelayError("RELAY_CONFIG_MISSING", "플랫폼 나가는 대역이 비었거나 틀렸다");
  // DRAFT(ai): Cloud SQL(PSA 쪽)이 중계 사설 IP 로 붙을 때 출처 = PSA 할당 대역. 못 읽으면 Cloud SQL 사설 IP/32 만 (실측에서 막히면 PSA 대역을 확인)
  const psa = i.psaRanges.filter((c) => cidrOk(c, 8));
  const sqlSources = psa.length ? psa : [`${i.dbHost}/32`];
  const name = gcpRelayName(i.migrationId);
  const desc = (what: string) => `svc relay ${what} for migration ${i.migrationId} (managed-by platform)`;
  return [
    { name: `${name}-ssh`, port: 22, sources: [`${i.onpremEgressIp}/32`], description: desc("ssh tunnel from on-prem egress") },
    { name: `${name}-entry`, port: RELAY_SOURCE_PORT, sources: uniqSorted(i.platformEgressCidrs), description: desc("db entry for platform worker") },
    { name: `${name}-pg`, port: PG_PORT, sources: uniqSorted([...i.platformEgressCidrs, ...sqlSources]), description: desc("reverse tunnel for worker and Cloud SQL") },
  ];
}

export function buildGcpRelayPlan(i: {
  kind: GcpRelayKind; migrationId: string; sql: CloudSqlPrivate; subnetUrl: string; psaRanges: string[];
  onpremEgressIp: string; platformEgressCidrs: string[]; tunnelPublicKey: string; hostKey: SshKeypair;
}): GcpRelayPlan {
  if (!UUID.test(i.migrationId)) throw new RelayError("RELAY_PROVISION_FAILED", "이전 번호가 uuid 가 아니다");
  const dbCode = i.kind === "gcp-onprem" ? "RELAY_SOURCE_DB_UNKNOWN" : "RELAY_TARGET_DB_UNKNOWN";
  if (!i.sql.privateIp || !i.sql.network) throw new RelayError(dbCode, `Cloud SQL ${i.sql.instance} 에 사설 IP·VPC 가 없다`);
  const netProject = i.sql.network.split("/")[1]!;
  // TODO(human): 공유 VPC(네트워크가 다른 호스트 프로젝트)는 아직 안 받는다. 중계 VM·방화벽을 어느 프로젝트에 둘지(호스트·서비스) 정해야 한다
  if (netProject !== i.sql.project)
    throw new RelayError(dbCode, `Cloud SQL ${i.sql.instance} 의 VPC 가 다른 프로젝트(${netProject})에 있다 (공유 VPC 는 아직 중계기 자동 생성 밖)`);
  if (!/^https:\/\/www\.googleapis\.com\/compute\/v1\/projects\/[a-z0-9-]+\/regions\/[a-z0-9-]+\/subnetworks\/[a-z0-9-]+$/.test(i.subnetUrl))
    throw new RelayError("RELAY_PROVISION_FAILED", "서브넷 주소 모양이 틀렸다");
  const zone = i.sql.zone ?? (i.sql.region ? `${i.sql.region}-a` : null);
  if (!zone) throw new RelayError(dbCode, `Cloud SQL ${i.sql.instance} 의 지역·영역을 모른다`);
  const name = gcpRelayName(i.migrationId);
  return {
    kind: i.kind, migrationId: i.migrationId, project: i.sql.project, zone,
    networkUrl: `https://www.googleapis.com/compute/v1/${i.sql.network}`, subnetUrl: i.subnetUrl,
    instanceName: name, networkTag: name,
    labels: { [GCP_RELAY_LABEL.managedBy]: "platform", [GCP_RELAY_LABEL.migration]: i.migrationId, [GCP_RELAY_LABEL.role]: "relay" },
    dbHost: i.sql.privateIp,
    startupScript: gceRelayStartupScript({ migrationId: i.migrationId, dbHost: i.sql.privateIp, tunnelPublicKey: i.tunnelPublicKey, hostKey: i.hostKey }),
    firewalls: gcpRelayFirewalls({ migrationId: i.migrationId, onpremEgressIp: i.onpremEgressIp, platformEgressCidrs: i.platformEgressCidrs, psaRanges: i.psaRanges, dbHost: i.sql.privateIp }),
    hostPublicKey: i.hostKey.publicKeyLine.trim(),
  };
}

// ── 3. 실행기 (gcloud) ────────────────────────────────────────────────────────────

export interface RelayGcpDeps {
  /** 빌린 토큰 env (gcpEnvFor). 시험은 아무 값이나 */
  env: NodeJS.ProcessEnv;
  exec?: Exec;
  signal?: AbortSignal;
}
type GcloudOut = { ok: true; json: unknown } | { ok: false; notFound: boolean; why: string };
const NOT_FOUND = /NOT_FOUND|was not found|could not be found|notFound|does not exist/i;

async function gcloud(d: RelayGcpDeps, args: string[]): Promise<GcloudOut> {
  const r = await (d.exec ?? spawnExec)(d.env.GCLOUD_BIN ?? "gcloud", [...args, "--format=json", "--quiet"],
    { cwd: tmpdir(), env: d.env, timeoutMs: GCLOUD_TIMEOUT_MS, ...(d.signal ? { signal: d.signal } : {}) });
  if (r.code !== 0) {
    const why = r.code === 127 ? "gcloud 가 없다 (워커 이미지 확인)" : r.stderr.replace(/\s+/g, " ").trim().slice(-300);
    return { ok: false, notFound: NOT_FOUND.test(r.stderr), why };
  }
  try { return { ok: true, json: r.stdout.trim() ? JSON.parse(r.stdout) : null }; }
  catch { return { ok: false, notFound: false, why: "gcloud 응답이 JSON 이 아니다" }; }
}
const must = (o: GcloudOut, code: "RELAY_PROVISION_FAILED" | "RELAY_TEARDOWN_FAILED" | "RELAY_SOURCE_DB_UNKNOWN" | "RELAY_TARGET_DB_UNKNOWN", what: string): unknown => {
  if (!o.ok) throw new RelayError(code, `${what} 실패: ${o.why}`);
  return o.json;
};

/** Cloud SQL 하나 읽기 (사설 IP·VPC·지역·서버 CA·플래그) */
export async function describeCloudSqlPrivate(d: RelayGcpDeps, ref: CloudSqlInstanceRef, code: "RELAY_SOURCE_DB_UNKNOWN" | "RELAY_TARGET_DB_UNKNOWN"): Promise<CloudSqlPrivate> {
  const raw = must(await gcloud(d, ["sql", "instances", "describe", ref.instance, `--project=${ref.project}`]), code, `Cloud SQL ${ref.instance} 읽기`);
  return cloudSqlPrivateOf(ref, raw);
}

/** 출발 Cloud SQL 에 이전 전용 복제 계정을 만든다 (있으면 비밀번호만 맞춘다). 비밀번호는 0600 임시 파일 없이 gcloud 인자로 넘긴다:
 *  DRAFT(ai): 인자는 워커 컨테이너 안 프로세스 목록에만 잠깐 보인다 (로그·감사에는 안 남김). REST 직접 호출로 바꾸면 이 노출도 없어진다 */
export async function ensureCloudSqlReplUser(d: RelayGcpDeps, sql: Pick<CloudSqlPrivate, "project" | "instance">, user: string, password: string): Promise<"created" | "updated"> {
  if (!/^svc_repl_[0-9a-f]{8}$/.test(user)) throw new RelayError("RELAY_PROVISION_FAILED", "복제 계정 이름 모양이 틀렸다");
  const base = [`--instance=${sql.instance}`, `--project=${sql.project}`, `--password=${password}`];
  const c = await gcloud(d, ["sql", "users", "create", user, ...base]);
  if (c.ok) return "created";
  if (!/already exists|ALREADY_EXISTS|409/i.test(c.why)) throw new RelayError("RELAY_SOURCE_DB_UNKNOWN", `출발 Cloud SQL ${sql.instance} 에 복제 계정 만들기 실패: ${c.why.replace(password, "***")}`);
  must(await gcloud(d, ["sql", "users", "set-password", user, ...base]), "RELAY_SOURCE_DB_UNKNOWN", `출발 Cloud SQL ${sql.instance} 복제 계정 비밀번호 맞추기`);
  return "updated";
}

/** 출발 Cloud SQL 논리 디코딩 자동 켜기 (env RELAY_AUTO_DB_FLAGS=0 이면 끔 → 사전 점검이 막고 사람이 켠다)
 *  DRAFT(ai): 기본 켬 (2026-11-06 "일단 다 주고 되면 뺀다" 결정). 플래그 바꾸기는 Cloud SQL 을 한 번 재시작한다 → 출발 앱이 잠깐(보통 1~3분) DB 를 못 쓴다.
 *  TODO(human): 고객 운영 DB 재시작을 고객 동의(승인 화면 문구) 없이 해도 되는지 정한다 */
export const autoDbFlags = (env: NodeJS.ProcessEnv) => env.RELAY_AUTO_DB_FLAGS !== "0";
const DECODING = "cloudsql.logical_decoding";
// DRAFT(ai): 재시작 기다림 15분, 15초마다 describe (gcloud 한 번 부르기 시간 제한 180초를 넘을 수 있어 --async + 다시 읽기로 기다린다)
const FLAG_WAIT_MS = 15 * 60_000, FLAG_POLL_MS = 15_000;
export interface FlagWait { sleep?: (ms: number) => Promise<void>; maxWaitMs?: number; pollMs?: number }

/** 지금 플래그 + cloudsql.logical_decoding=on 으로 patch (재시작) → 켜지고 RUNNABLE 이 될 때까지 다시 읽는다. 이미 켜져 있으면 그대로 */
export async function enableCloudSqlLogicalDecoding(d: RelayGcpDeps, sql: CloudSqlPrivate, w: FlagWait = {}): Promise<CloudSqlPrivate> {
  if (sql.logicalDecoding) return sql;
  const keep = (sql.flags ?? []).filter((f) => f.name !== DECODING);
  // 쉼표가 든 값은 --database-flags 목록을 깨뜨린다 → 덮어써서 다른 플래그를 잃느니 멈춘다
  if (keep.some((f) => /[,=]/.test(f.value) || /[,=]/.test(f.name)))
    throw new RelayError("RELAY_SOURCE_DB_UNKNOWN", `출발 Cloud SQL ${sql.instance} 의 다른 플래그 값에 쉼표·= 가 있어 자동으로 못 켠다 (손으로 ${DECODING}=on)`);
  const flags = [...keep.map((f) => `${f.name}=${f.value}`), `${DECODING}=on`].join(",");
  must(await gcloud(d, ["sql", "instances", "patch", sql.instance, `--project=${sql.project}`, `--database-flags=${flags}`, "--async"]),
    "RELAY_SOURCE_DB_UNKNOWN", `출발 Cloud SQL ${sql.instance} 에 ${DECODING}=on 켜기`);
  const sleep = w.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const until = Date.now() + (w.maxWaitMs ?? FLAG_WAIT_MS);
  for (;;) {
    const now = await describeCloudSqlPrivate(d, sql, "RELAY_SOURCE_DB_UNKNOWN");
    if (now.logicalDecoding && (now.state ?? "RUNNABLE") === "RUNNABLE") return now;
    if (Date.now() >= until) throw new RelayError("RELAY_SOURCE_DB_UNKNOWN", `출발 Cloud SQL ${sql.instance} 이 ${DECODING}=on 재시작을 시간 안에 끝내지 못했다 (상태 ${now.state ?? "?"})`);
    if (d.signal?.aborted) throw new RelayError("RELAY_SOURCE_DB_UNKNOWN", "플래그 켜기 기다리다 작업이 멈췄다");
    await sleep(w.pollMs ?? FLAG_POLL_MS);
  }
}

/** 복제 계정 지우기. 없으면 그대로 */
export async function dropCloudSqlReplUser(d: RelayGcpDeps, sql: Pick<CloudSqlPrivate, "project" | "instance">, user: string): Promise<boolean> {
  const r = await gcloud(d, ["sql", "users", "delete", user, `--instance=${sql.instance}`, `--project=${sql.project}`]);
  if (r.ok) return true;
  if (r.notFound) return false;
  throw new RelayError("RELAY_TEARDOWN_FAILED", `출발 Cloud SQL ${sql.instance} 복제 계정 지우기 실패: ${r.why}`);
}

/** Cloud SQL 의 VPC 에서 그 지역 서브넷 하나 (이름순 첫 번째) + PSA 할당 대역 */
export async function discoverGcpRelayNetwork(d: RelayGcpDeps, sql: CloudSqlPrivate): Promise<{ subnetUrl: string; psaRanges: string[] }> {
  if (!sql.network || !sql.region) throw new RelayError("RELAY_PROVISION_FAILED", `Cloud SQL ${sql.instance} 의 VPC·지역을 모른다`);
  const netUrl = `https://www.googleapis.com/compute/v1/${sql.network}`;
  // gcloud subnets list --network 는 이름만 비교한다 (주소를 주면 늘 0개 → 2026-11-07 실측 RELAY_PROVISION_FAILED). 공유 VPC 는 plan 이 막으니 이름으로 충분
  const netName = sql.network.split("/").pop()!;
  const subs = must(await gcloud(d, ["compute", "networks", "subnets", "list", `--project=${sql.project}`, `--network=${netName}`, `--regions=${sql.region}`]),
    "RELAY_PROVISION_FAILED", "서브넷 목록") as { selfLink?: string; stackType?: string }[] | null;
  const subnetUrl = (subs ?? []).map((s) => s.selfLink ?? "").filter(Boolean).sort()[0];
  if (!subnetUrl) throw new RelayError("RELAY_PROVISION_FAILED", `VPC ${sql.network} 에 ${sql.region} 서브넷이 없다 (중계 VM 을 둘 곳이 없음)`);
  // PSA 대역은 못 읽어도 멈추지 않는다 (방화벽이 Cloud SQL 사설 IP/32 로 좁아질 뿐)
  const addrs = await gcloud(d, ["compute", "addresses", "list", `--project=${sql.project}`, "--global", "--filter=purpose=VPC_PEERING"]);
  const psaRanges = addrs.ok ? uniqSorted(((addrs.json ?? []) as { address?: string; prefixLength?: number; network?: string }[])
    .filter((a) => (a.network ?? "").endsWith(`/${sql.network}`) && isIpv4(a.address ?? "") && Number.isInteger(a.prefixLength))
    .map((a) => `${a.address}/${a.prefixLength}`)) : [];
  return { subnetUrl, psaRanges };
}

export interface GcpRelayResources {
  instanceName: string; zone: string; project: string; publicIp: string; privateIp: string;
  firewalls: string[]; created: string[]; reused: string[];
}
type RawInstance = { name?: string; status?: string; labels?: Record<string, string>; zone?: string;
  metadata?: { items?: { key?: string; value?: string }[] };
  networkInterfaces?: { networkIP?: string; accessConfigs?: { natIP?: string }[] }[] };
const ipsOf = (it: RawInstance) => ({ publicIp: it.networkInterfaces?.[0]?.accessConfigs?.[0]?.natIP ?? "", privateIp: it.networkInterfaces?.[0]?.networkIP ?? "" });
const ownedBy = (it: RawInstance, migrationId: string) =>
  it.labels?.[GCP_RELAY_LABEL.managedBy] === "platform" && it.labels?.[GCP_RELAY_LABEL.migration] === migrationId;

/** 방화벽 셋 → VM. 이미 있으면 그대로 (출처가 바뀐 규칙은 고치고, 목적지가 바뀐 VM 은 새로). 다시 불러도 된다 */
export async function provisionGcpRelay(d: RelayGcpDeps, plan: GcpRelayPlan): Promise<GcpRelayResources> {
  const P = `--project=${plan.project}`;
  const created: string[] = [], reused: string[] = [];
  for (const fw of plan.firewalls) {
    const cur = await gcloud(d, ["compute", "firewall-rules", "describe", fw.name, P]);
    if (cur.ok) {
      const raw = cur.json as { sourceRanges?: string[]; description?: string; targetTags?: string[] };
      if (!(raw.description ?? "").includes(plan.migrationId))
        throw new RelayError("RELAY_PROVISION_FAILED", `방화벽 규칙 ${fw.name} 이 이미 있는데 이 이전 것이 아니다`);
      if (uniqSorted(raw.sourceRanges ?? []).join(",") !== fw.sources.join(",") || !(raw.targetTags ?? []).includes(plan.networkTag)) {
        must(await gcloud(d, ["compute", "firewall-rules", "update", fw.name, P, `--source-ranges=${fw.sources.join(",")}`, `--target-tags=${plan.networkTag}`]),
          "RELAY_PROVISION_FAILED", `방화벽 규칙 ${fw.name} 고치기`);
      }
      reused.push(fw.name);
      continue;
    }
    if (!cur.notFound) throw new RelayError("RELAY_PROVISION_FAILED", `방화벽 규칙 ${fw.name} 읽기 실패: ${cur.why}`);
    must(await gcloud(d, ["compute", "firewall-rules", "create", fw.name, P, `--network=${plan.networkUrl}`, "--direction=INGRESS", "--action=ALLOW",
      `--rules=tcp:${fw.port}`, `--source-ranges=${fw.sources.join(",")}`, `--target-tags=${plan.networkTag}`, `--description=${fw.description}`]),
      "RELAY_PROVISION_FAILED", `방화벽 규칙 ${fw.name} 만들기`);
    created.push(fw.name);
  }
  const Z = `--zone=${plan.zone}`;
  const cur = await gcloud(d, ["compute", "instances", "describe", plan.instanceName, P, Z]);
  if (cur.ok) {
    const it = cur.json as RawInstance;
    if (!ownedBy(it, plan.migrationId)) throw new RelayError("RELAY_PROVISION_FAILED", `VM ${plan.instanceName} 이 이미 있는데 이 이전 라벨이 아니다`);
    const target = it.metadata?.items?.find((x) => x.key === GCP_RELAY_TARGET_KEY)?.value;
    const ips = ipsOf(it);
    if (target === plan.dbHost && it.status === "RUNNING" && isIpv4(ips.publicIp) && isIpv4(ips.privateIp)) {
      reused.push(plan.instanceName);
      return { instanceName: plan.instanceName, zone: plan.zone, project: plan.project, ...ips, firewalls: plan.firewalls.map((f) => f.name), created, reused };
    }
    // 목적지가 바뀌었거나(Cloud SQL 을 다시 만듦) 멈춘 VM → 지우고 새로 (시작 스크립트·공개 IP 를 다시 맞춘다)
    must(await gcloud(d, ["compute", "instances", "delete", plan.instanceName, P, Z]), "RELAY_PROVISION_FAILED", `옛 VM ${plan.instanceName} 지우기`);
  } else if (!cur.notFound) throw new RelayError("RELAY_PROVISION_FAILED", `VM ${plan.instanceName} 읽기 실패: ${cur.why}`);
  // 시작 스크립트에는 파생 호스트 개인 키가 들어 있다 → 0600 임시 파일로만 넘기고 바로 지운다 (인자·로그에 안 남김)
  const dir = await mkdtemp(join(tmpdir(), "svc-gce-relay-"));
  try {
    const file = join(dir, "startup.sh");
    await writeFile(file, plan.startupScript, { mode: 0o600 });
    const labels = Object.entries(plan.labels).map(([k, v]) => `${k}=${v}`).join(",");
    const out = must(await gcloud(d, ["compute", "instances", "create", plan.instanceName, P, Z,
      `--machine-type=${GCP_RELAY_MACHINE_TYPE}`, `--image-family=${GCP_RELAY_IMAGE.family}`, `--image-project=${GCP_RELAY_IMAGE.project}`,
      `--subnet=${plan.subnetUrl}`, `--tags=${plan.networkTag}`, `--labels=${labels}`,
      // 프로젝트 공용 SSH 키로 이 VM 에 들어오지 못하게. 서비스 계정 없음 (VM 이 클라우드 API 를 부를 일이 없다)
      `--metadata=${GCP_RELAY_TARGET_KEY}=${plan.dbHost},block-project-ssh-keys=TRUE`, `--metadata-from-file=startup-script=${file}`,
      "--no-service-account", "--no-scopes", "--shielded-secure-boot"]), "RELAY_PROVISION_FAILED", `VM ${plan.instanceName} 만들기`);
    const it = (Array.isArray(out) ? out[0] : out) as RawInstance | undefined;
    const ips = ipsOf(it ?? {});
    if (!isIpv4(ips.publicIp) || !isIpv4(ips.privateIp))
      throw new RelayError("RELAY_PROVISION_FAILED", `VM ${plan.instanceName} 에 공개·사설 IP 가 없다 (조직 정책 compute.vmExternalIpAccess 가 공개 IP 를 막는지 확인)`);
    created.push(plan.instanceName);
    return { instanceName: plan.instanceName, zone: plan.zone, project: plan.project, ...ips, firewalls: plan.firewalls.map((f) => f.name), created, reused };
  } finally { await rm(dir, { recursive: true, force: true }); }
}

/** 이 이전 라벨이 달린 VM 과 정해진 이름의 방화벽 셋을 지운다. 없으면 그대로 (여러 번 불러도 된다) */
export async function teardownGcpRelay(d: RelayGcpDeps, project: string, migrationId: string): Promise<{ removed: string[] }> {
  if (!PROJECT.test(project) || !UUID.test(migrationId)) throw new RelayError("RELAY_TEARDOWN_FAILED", "프로젝트·이전 번호 모양이 틀렸다");
  const P = `--project=${project}`;
  const removed: string[] = [];
  const list = must(await gcloud(d, ["compute", "instances", "list", P, `--filter=labels.${GCP_RELAY_LABEL.migration}=${migrationId}`]),
    "RELAY_TEARDOWN_FAILED", "중계 VM 찾기") as RawInstance[] | null;
  for (const it of list ?? []) {
    if (!ownedBy(it, migrationId) || !it.name) continue;
    const zone = (it.zone ?? "").split("/").pop() ?? "";
    const r = await gcloud(d, ["compute", "instances", "delete", it.name, P, `--zone=${zone}`]);
    if (!r.ok && !r.notFound) throw new RelayError("RELAY_TEARDOWN_FAILED", `VM ${it.name} 지우기 실패: ${r.why}`);
    removed.push(it.name);
  }
  for (const suffix of ["ssh", "entry", "pg"]) {
    const name = `${gcpRelayName(migrationId)}-${suffix}`;
    const cur = await gcloud(d, ["compute", "firewall-rules", "describe", name, P]);
    if (!cur.ok) { if (cur.notFound) continue; throw new RelayError("RELAY_TEARDOWN_FAILED", `방화벽 규칙 ${name} 읽기 실패: ${cur.why}`); }
    // 같은 이름이라도 이 이전 설명이 아니면 손대지 않는다
    if (!((cur.json as { description?: string }).description ?? "").includes(migrationId)) continue;
    const r = await gcloud(d, ["compute", "firewall-rules", "delete", name, P]);
    if (!r.ok && !r.notFound) throw new RelayError("RELAY_TEARDOWN_FAILED", `방화벽 규칙 ${name} 지우기 실패: ${r.why}`);
    removed.push(name);
  }
  return { removed };
}

// ── 4. 끝점 두 줄 (순수) ───────────────────────────────────────────────────────────

const id8Of = (migrationId: string) => migrationId.replace(/-/g, "").slice(0, 8);

/** 온프레 CNPG 줄 (gcp-onprem 의 도착, onprem-gcp 의 출발). 워커 → 중계 공개 IP:5432 (역방향 터널), Cloud SQL 구독은 중계 사설 IP:5432.
 *  배달(deploy)이 채우는 칸(ca_pem·tls_servername·sslmode)은 같은 중계기면 그대로 둔다 (relay-step relayEndpointRows 와 같은 규칙) */
function cnpgRow(i: { tenantId: string; migrationId: string; side: "source" | "target"; db: string; appUser: string; publicIp: string; privateIp: string;
  knownHosts: string; existing: readonly ReplicationEndpoint[] }): ReplicationEndpoint {
  const old = i.existing.find((e) => e.side === i.side && e.provider === "cnpg");
  const same = old?.relayHost === i.publicIp;
  return {
    tenantId: i.tenantId, migrationId: i.migrationId, side: i.side, label: `onprem-cnpg${i.side === "source" ? "-src" : ""}-${id8Of(i.migrationId)}`, provider: "cnpg",
    host: i.publicIp, port: PG_PORT, dbname: i.db, username: RELAY_TARGET_USER, passwordRef: RELAY_TARGET_PASSWORD_REF,
    peerHost: i.privateIp, peerPort: PG_PORT,
    appRole: i.appUser, fenceRoles: old?.fenceRoles ?? [], schemaName: old?.schemaName ?? null,
    sslmode: same ? old?.sslmode ?? "require" : "require",
    tlsServername: same ? old?.tlsServername ?? null : null, caPem: same ? old?.caPem ?? null : null,
    relayHost: i.publicIp, relayKnownHosts: i.knownHosts, relayPort: 22,
  };
}

/** Cloud SQL 줄: 워커 → 중계 공개 IP:15432 → Cloud SQL 사설 IP:5432 (TCP 그대로, TLS 는 워커↔Cloud SQL 끝까지 verify-ca).
 *  진짜 주소(사설 IP)는 tls_servername: 온프레 정방향 터널 목적지(forwardTarget)이고 중계 sshd PermitOpen 과 같은 값이다.
 *  peer 는 배달이 터널 Service 로 채운다 (온프레 CNPG 가 -L 로 이 DB 에 붙는 길). 운영자가 넣은 계정·비밀번호 참조는 그대로 */
function cloudSqlRow(i: { tenantId: string; migrationId: string; side: "source" | "target"; label: string; db: string; username: string; passwordRef: string; appRole: string;
  privateIp: string; serverCaPem: string | null; publicIp: string; existing: readonly ReplicationEndpoint[] }): ReplicationEndpoint {
  const old = i.existing.find((e) => e.side === i.side && e.provider === "cloudsql");
  const ca = old?.caPem ?? i.serverCaPem;
  return {
    tenantId: i.tenantId, migrationId: i.migrationId, side: i.side, label: i.label, provider: "cloudsql",
    host: i.publicIp, port: RELAY_SOURCE_PORT, dbname: i.db, username: old?.username ?? i.username, passwordRef: old?.passwordRef ?? i.passwordRef,
    peerHost: old?.peerHost ?? null, peerPort: old?.peerPort ?? null,
    appRole: i.appRole, fenceRoles: old?.fenceRoles ?? [], schemaName: old?.schemaName ?? null,
    // DRAFT(ai): 서버 인증서에 사설 IP 이름이 없을 수 있어 verify-ca (gcp-aws 와 같은 판단). servername 에 IP 가 들어가 Node 가 SNI 경고를 낼 수 있다 (확인만 끔)
    sslmode: old?.sslmode ?? (ca ? "verify-ca" : "require"), tlsServername: i.privateIp, caPem: ca,
    relayHost: null, relayKnownHosts: null, relayPort: 22,
  };
}

export function gcpOnpremEndpointRows(i: { tenantId: string; migrationId: string; sourceEnvId: string; sql: CloudSqlPrivate; db: string; appUser: string;
  publicIp: string; privateIp: string; knownHosts: string; existing: readonly ReplicationEndpoint[] }): [ReplicationEndpoint, ReplicationEndpoint] {
  if (!i.sql.privateIp) throw new RelayError("RELAY_SOURCE_DB_UNKNOWN", `출발 Cloud SQL ${i.sql.instance} 에 사설 IP 가 없다`);
  const source = cloudSqlRow({ tenantId: i.tenantId, migrationId: i.migrationId, side: "source", label: `cloudsql-src-${id8Of(i.migrationId)}`, db: i.db,
    // 출발 계정 = 워커가 만든 이전 전용 복제 계정, 비밀번호 = 파생 (사람 입력 없음). 운영자가 넣은 줄이 있으면 그 계정·참조 그대로 (cloudSqlRow)
    username: gcpReplUser(i.migrationId), passwordRef: `derive:${GCP_REPL_PURPOSE}`, appRole: i.appUser,
    privateIp: i.sql.privateIp, serverCaPem: i.sql.serverCaPem, publicIp: i.publicIp, existing: i.existing });
  const target = cnpgRow({ ...i, side: "target" });
  return [source, target];
}

export function onpremGcpEndpointRows(i: { tenantId: string; migrationId: string; sql: CloudSqlPrivate; out: TfOutputs; db: string; appUser: string;
  publicIp: string; privateIp: string; knownHosts: string; existing: readonly ReplicationEndpoint[] }): [ReplicationEndpoint, ReplicationEndpoint] {
  if (!i.sql.privateIp) throw new RelayError("RELAY_TARGET_DB_UNKNOWN", `도착 Cloud SQL ${i.sql.instance} 에 사설 IP 가 없다`);
  const admin = i.out.db_admin_username;
  if (!admin) throw new RelayError("RELAY_TARGET_DB_UNKNOWN", "terraform 출력에 도착 관리자 계정(db_admin_username)이 없다 (gcp/root 모듈이 옛 판)");
  const source = cnpgRow({ ...i, side: "source" });
  const target = cloudSqlRow({ tenantId: i.tenantId, migrationId: i.migrationId, side: "target", label: `cloudsql-tgt-${id8Of(i.migrationId)}`, db: i.out.db_name || i.db,
    username: admin, passwordRef: GCP_TARGET_PASSWORD_REF, appRole: i.out.db_username || i.appUser,
    privateIp: i.sql.privateIp, serverCaPem: i.sql.serverCaPem ?? (i.out.db_server_ca_cert || null), publicIp: i.publicIp, existing: i.existing });
  return [source, target];
}

// ── 5. 문 (순수) ──────────────────────────────────────────────────────────────────

export type GcpOnpremGate =
  | { kind: "skip"; reason: string }
  | ({ kind: "fail"; failureCode: string; reason: string } & Partial<StopHint>)
  | { kind: "go"; relayKind: GcpRelayKind; ref: CloudSqlInstanceRef | null; egressIp: string; platformCidrs: string[]; masterKey: string; db: string; user: string };

/** gcp-onprem·onprem-gcp 공통 문. AWS 쪽 relayGate·onpremAwsRelayGate 와 같은 앞 조건 (pull 모드, 온프레 나가는 IP, 마스터 키, 플랫폼 대역) */
export function gcpOnpremGate(f: RelayFacts, env: NodeJS.ProcessEnv): GcpOnpremGate {
  const kind = relayKindOf(f.sourceProvider, f.targetProvider);
  if (!isGcpRelayKind(kind)) return { kind: "skip", reason: "not_gcp_onprem_relay" };
  if (env.ONPREM_FLOOR_VIA_GIT === "0") return { kind: "skip", reason: "not_pull_mode" };
  const no = relayApplies(f, env);
  if (no) return { kind: "skip", reason: no };
  if (!f.postgres.length) return { kind: "skip", reason: "no_postgres" };
  if (f.postgres.length !== 1) return { kind: "fail", failureCode: "RELAY_SOURCE_DB_UNKNOWN", reason: `명세에 postgres 가 ${f.postgres.length}개다 (중계기·끝점 줄은 이전마다 하나)` };
  // 22 를 세상에 열지 않는다: 온프레 나가는 IP 를 모르면 만들지 않는다
  if (!f.onpremEgressIp || !isIpv4(f.onpremEgressIp))
    return { kind: "fail", failureCode: "ONPREM_EGRESS_UNKNOWN",
      reason: "온프레 클러스터의 나가는 공인 IP 를 모른다 (Agent facts 보고에 egressIp 가 없거나 오래됨): 중계기 SSH(22)를 세상에 열지 않으려고 멈췄다",
      missing: ["onprem: Agent facts egressIp"], hint: "고객 서버에서 kubectl -n svc-agent logs deploy/onprem-agent 로 facts 보고를 확인하고, facts 가 다시 온 뒤 다시 계획·승인한다" };
  if (kind === "gcp-onprem" && !f.cloudSql)
    return { kind: "fail", failureCode: "RELAY_SOURCE_DB_UNKNOWN", reason: "명세의 postgres 에 출발 Cloud SQL 인스턴스가 없다 (spec_v2.ids 의 selfLink)",
      missing: ["spec_v2.ids: Cloud SQL selfLink"], hint: "출발 GCP 환경을 다시 가져와 명세에 Cloud SQL 이 잡히게 하거나 RELAY_AUTO=0 으로 사람이 끝점 줄을 넣는다" };
  const masterKey = env.REPL_SECRET_MASTER_KEY;
  if (!masterKey || masterKey.length < MIN_MASTER_KEY_LENGTH)
    return { kind: "fail", failureCode: "REPL_SECRET_UNRESOLVED", reason: `REPL_SECRET_MASTER_KEY 가 없거나 ${MIN_MASTER_KEY_LENGTH}자보다 짧다: 터널·호스트 키를 파생할 수 없다`,
      missing: ["REPL_SECRET_MASTER_KEY"] };
  let platformCidrs: string[];
  try { platformCidrs = platformEgressCidrs(env.PLATFORM_EGRESS_CIDRS); }
  catch (e) { return { kind: "fail", failureCode: (e as RelayError).code ?? "RELAY_CONFIG_MISSING", reason: (e as Error).message, missing: ["PLATFORM_EGRESS_CIDRS"] }; }
  const pg = f.postgres[0]!;
  return { kind: "go", relayKind: kind, ref: f.cloudSql ?? null, egressIp: f.onpremEgressIp, platformCidrs, masterKey, db: pg.db, user: pg.user };
}

/** 출발 Cloud SQL 관리자 비밀번호 env 가 워커에 있나 (gcp-onprem). 없으면 이름 */
//   기본은 워커가 만든 복제 계정(derive:)이라 env 가 필요 없다. 운영자가 env: 참조로 출발 줄을 넣어 둔 경우만 본다
export function missingSourceSecret(f: Pick<RelayFacts, "existing">, m: Pick<MigrationRow, "sourceEnvId">, migrationId: string, env: NodeJS.ProcessEnv): string | null {
  if (!f.existing.some((e) => e.side === "source" && e.provider === "cloudsql")) return null;
  const pw = gcpSourcePasswordRef(f.existing, m.sourceEnvId, migrationId);
  return pw.envName && !env[pw.envName] ? pw.envName : null;
}

// ── 6. 단계 ───────────────────────────────────────────────────────────────────────

export interface GcpOnpremDeps {
  env?: NodeJS.ProcessEnv;
  facts?: RelayFacts;
  /** 중계기 쪽 실행 역할 빌리기 (시험이 바꾼다). 기본 withStepRoles(relay_gcp | relay_gcp_target) */
  borrow?: <T>(fn: (r: Pick<StepRoles, "gcpToken" | "denied" | "signal">) => Promise<T>) => Promise<T>;
  /** 출발 Cloud SQL 읽기 (gcp-onprem, 시험이 바꾼다). 기본 = 출발 관찰 역할(relay_source_read)로 gcloud */
  readSource?: (ref: CloudSqlInstanceRef) => Promise<CloudSqlPrivate>;
  exec?: Exec;
  existing?: readonly ReplicationEndpoint[];
  save?: (rows: ReplicationEndpoint[]) => Promise<void>;
  appLogin?: (target: ReplicationEndpoint) => Promise<"created" | "updated" | "privileged">;
  /** 논리 디코딩 켠 뒤 재시작 기다리기 (시험이 sleep 을 바꾼다) */
  flagWait?: FlagWait;
}

const TAG_HINT = "만든 자원(VM·방화벽 규칙)은 라벨 managed-by=platform, svc-migration=<이전> 과 이름 svc-relay-<이전> 으로 남는다. 원인을 고친 뒤 다시 계획·승인하면 이어 간다. 취소하면 repl-cleanup 이 지운다";
const ROLE_FIX: StopHint = { missing: ["gcp: svc-operate 에 중계기 역할 platform_relay (infra/permissions/gcp-relay-custom-role.yaml)"],
  hint: "중계기 쪽 GCP 프로젝트에서 플랫폼 실행 SA(svc-operate)에 platform_relay 역할이 붙어 있는지 확인한다. 예전 연결 스크립트로 붙은 고객은 콘솔의 GCP 연결 스크립트(gcp-connect.sh)를 다시 실행하면 붙는다. 그 뒤 다시 계획·승인한다" };
function failure(e: unknown, extra: Record<string, unknown> = {}): Failed {
  if (!(e instanceof RelayError)) throw e;
  const denied = /PERMISSION_DENIED|does not have|forbidden|403/i.test(e.message);
  return { kind: "failed", failureCode: e.code, reason: e.message,
    detail: { ...extra, ...(denied ? { missing: ROLE_FIX.missing } : {}), hint: denied ? `${ROLE_FIX.hint} / ${TAG_HINT}` : TAG_HINT } };
}
const gateFail = (g: Extract<GcpOnpremGate, { kind: "fail" }>): Failed =>
  ({ kind: "failed", failureCode: g.failureCode, reason: g.reason, ...(g.missing || g.hint ? { detail: { ...(g.missing ? { missing: g.missing } : {}), ...(g.hint ? { hint: g.hint } : {}) } } : {}) });

async function readSourceBorrowed(j: Job, m: MigrationRow, ref: CloudSqlInstanceRef, env: NodeJS.ProcessEnv, exec?: Exec): Promise<CloudSqlPrivate> {
  return withStepRoles("relay_source_read", j, m, async (roles) => {
    const token = roles.gcpToken?.source;
    if (!token) throw new RelayError("RELAY_SOURCE_DB_UNKNOWN", roles.denied.length
      ? `출발 GCP 관찰 역할을 못 빌렸다: ${roles.denied.map((x) => x.code).join(",")}` : "출발 GCP 관찰 역할 토큰이 없다 (출발 환경이 GCP 인지, 연결이 끝났는지)");
    return describeCloudSqlPrivate({ env: gcpEnvFor(token, ref.project, env), ...(exec ? { exec } : {}) }, ref, "RELAY_SOURCE_DB_UNKNOWN");
  });
}

/** 중계기 쪽 토큰 빌려 VM·방화벽 만들기 → 호스트 키 줄. 두 방향 공통 */
async function provisionWithToken(j: Job, m: MigrationRow, side: "source" | "target", g: Extract<GcpOnpremGate, { kind: "go" }>, deps: GcpOnpremDeps,
  sqlOf: (d: RelayGcpDeps) => Promise<CloudSqlPrivate>): Promise<Failed | { kind: "ok"; res: GcpRelayResources; sql: CloudSqlPrivate; knownHosts: string; psaRanges: string[]; replUser?: string; logicalDecoding?: string }> {
  const env = deps.env ?? process.env;
  const step = side === "source" ? "relay_gcp" as const : "relay_gcp_target" as const;
  const borrow = deps.borrow ?? (<T>(fn: (r: StepRoles) => Promise<T>) => withStepRoles(step, j, m, fn));
  return borrow(async (roles) => {
    const token = roles.gcpToken?.[side];
    const sideName = side === "source" ? "출발" : "도착";
    if (!token) return { kind: "failed", failureCode: "RELAY_ROLE_DENIED", reason: roles.denied.length
      ? `${sideName} GCP 실행 역할을 못 빌렸다: ${roles.denied.map((x) => x.code).join(",")}` : `${sideName} GCP 실행 역할 토큰이 없다 (환경이 GCP 인지, 연결이 끝났는지)`,
      detail: { ...ROLE_FIX } } satisfies Failed;
    try {
      // 프로젝트는 아래에서 Cloud SQL 의 것으로 다시 넣는다 (gcloud 는 --project 를 따로 받는다)
      const base: RelayGcpDeps = { env: gcpEnvFor(token, "", env), ...(deps.exec ? { exec: deps.exec } : {}), ...(roles.signal ? { signal: roles.signal } : {}) };
      delete base.env.CLOUDSDK_CORE_PROJECT;
      let sql = await sqlOf(base);
      const d: RelayGcpDeps = { ...base, env: { ...base.env, CLOUDSDK_CORE_PROJECT: sql.project } };
      // gcp-onprem: 출발 논리 디코딩이 꺼져 있으면 워커가 켠다 (재시작). 다른 문제는 아래가 막는다
      let decoding: string | undefined;
      if (side === "source" && !sql.logicalDecoding && autoDbFlags(env)) { sql = await enableCloudSqlLogicalDecoding(d, sql, deps.flagWait); decoding = "enabled"; }
      const bad = cloudSqlPrivateProblems(sql, side);
      if (bad.length) return { kind: "failed", failureCode: side === "source" ? "RELAY_SOURCE_DB_UNKNOWN" : "RELAY_TARGET_DB_UNKNOWN",
        reason: bad.map((p) => p.message).join(" / "), detail: { missing: bad.flatMap((p) => p.missing), hint: bad.map((p) => p.hint).join(" / ") } } satisfies Failed;
      // gcp-onprem: 출발 Cloud SQL 에 이전 전용 복제 계정 (운영자가 출발 줄을 넣어 둔 경우는 그 계정을 쓰고 안 만든다)
      let replUser: string | undefined;
      if (side === "source" && !(deps.existing ?? []).some((e) => e.side === "source" && e.provider === "cloudsql")) {
        const name = gcpReplUser(j.migrationId);
        replUser = `${name}:${await ensureCloudSqlReplUser(d, sql, name, deriveReplPassword(g.masterKey, { tenantId: j.tenantId, migrationId: j.migrationId, side: "source" }, GCP_REPL_PURPOSE))}`;
      }
      const net = await discoverGcpRelayNetwork(d, sql);
      const hostKey = deriveSshHostKey(g.masterKey, j.tenantId, j.migrationId);
      const plan = buildGcpRelayPlan({ kind: g.relayKind, migrationId: j.migrationId, sql, subnetUrl: net.subnetUrl, psaRanges: net.psaRanges,
        onpremEgressIp: g.egressIp, platformEgressCidrs: g.platformCidrs, tunnelPublicKey: deriveSshKeypair(g.masterKey, j.tenantId, j.migrationId).publicKeyLine, hostKey });
      const res = await provisionGcpRelay(d, plan);
      return { kind: "ok" as const, res, sql, knownHosts: knownHostsLine(res.publicIp, plan.hostPublicKey), psaRanges: net.psaRanges, ...(replUser ? { replUser } : {}), ...(decoding ? { logicalDecoding: decoding } : {}) };
    } catch (e) { return failure(e); }
  });
}

const okDetail = (kind: GcpRelayKind, x: { res: GcpRelayResources; sql: CloudSqlPrivate; psaRanges: string[]; replUser?: string; logicalDecoding?: string }, extra: Record<string, unknown> = {}) => ({
  kind, project: x.res.project, zone: x.res.zone, instanceName: x.res.instanceName, firewalls: x.res.firewalls,
  publicIp: x.res.publicIp, privateIp: x.res.privateIp, created: x.res.created, reused: x.res.reused, entryPort: RELAY_SOURCE_PORT,
  cloudSql: { instance: x.sql.instance, privateIp: x.sql.privateIp, network: x.sql.network }, psaRanges: x.psaRanges, ...(x.replUser ? { replUser: x.replUser } : {}), ...(x.logicalDecoding ? { logicalDecoding: x.logicalDecoding } : {}), endpointRows: ["source", "target"], ...extra });

/** GCP 출발 → 온프레 도착 (apply 의 온프레 분기, pull 모드). 출발 Cloud SQL VPC 에 중계 VM + 끝점 두 줄. 다시 불러도 된다 */
export async function provisionGcpOnpremRelayStep(j: Job, m: MigrationRow, deps: GcpOnpremDeps = {}): Promise<RelayStepOutcome> {
  const env = deps.env ?? process.env;
  const facts = deps.facts ?? await withTenant(j.tenantId, (tx) => readRelayFacts(tx, j.tenantId, m, env));
  const g = gcpOnpremGate(facts, env);
  if (g.kind === "skip") return { kind: "skipped", reason: g.reason };
  if (g.kind === "fail") return gateFail(g);
  if (g.relayKind !== "gcp-onprem" || !g.ref) return { kind: "skipped", reason: "not_gcp_onprem_relay" };
  const secret = missingSourceSecret(facts, m, j.migrationId, env);
  if (secret) return { kind: "failed", failureCode: "REPL_SECRET_UNRESOLVED", reason: `출발 Cloud SQL 관리자 비밀번호 env ${secret} 가 워커에 없다`,
    detail: { missing: [secret], hint: `운영자가 넣은 출발 줄이 env 참조다: worker-env 비밀에 ${secret} 를 넣거나, 그 줄을 지우고(npm run repl:endpoint) 다시 계획하면 워커가 복제 계정을 만든다` } };
  const ref = g.ref;
  // 출발 Cloud SQL 은 출발 관찰 역할로 읽는다 (실행 역할 SA 는 출발 프로젝트에 Cloud SQL 읽기가 없을 수 있다)
  let sql: CloudSqlPrivate;
  try { sql = await (deps.readSource ?? ((r) => readSourceBorrowed(j, m, r, env, deps.exec)))(ref); }
  catch (e) { return failure(e, { cloudSql: ref.instance }); }
  const existing = deps.existing ?? facts.existing;
  const p = await provisionWithToken(j, m, "source", g, { ...deps, existing }, async () => sql);
  if (p.kind === "failed") return p;
  let rows: [ReplicationEndpoint, ReplicationEndpoint];
  try {
    rows = gcpOnpremEndpointRows({ tenantId: j.tenantId, migrationId: j.migrationId, sourceEnvId: m.sourceEnvId, sql: p.sql, db: g.db, appUser: g.user,
      publicIp: p.res.publicIp, privateIp: p.res.privateIp, knownHosts: p.knownHosts, existing });
  } catch (e) { return failure(e); }
  await (deps.save ?? ((r) => saveEndpointRows(j.tenantId, r)))(rows);
  return { kind: "ok", detail: okDetail("gcp-onprem", p, { sourceTls: rows[0].sslmode }) };
}

/** 온프레 출발 → GCP 도착, terraform 앞: 문만 본다. 짝이 onprem->gcp 가 아니면 null (예전 그대로) */
export async function prepareOnpremGcpRelayStep(j: Job, m: MigrationRow, deps: Pick<GcpOnpremDeps, "env" | "facts"> = {}): Promise<GcpOnpremGate | null> {
  const env = deps.env ?? process.env;
  const facts = deps.facts ?? await withTenant(j.tenantId, (tx) => readRelayFacts(tx, j.tenantId, m, env));
  if (relayKindOf(facts.sourceProvider, facts.targetProvider) !== "onprem-gcp") return null;
  return gcpOnpremGate(facts, env);
}

/** 온프레 출발 → GCP 도착, terraform 뒤: 도착 Cloud SQL VPC 에 중계 VM + 끝점 두 줄 + (관리자 ≠ 앱이면) 도착 앱 로그인 역할 */
export async function provisionOnpremGcpRelayStep(j: Job, m: MigrationRow, g: Extract<GcpOnpremGate, { kind: "go" }>, out: TfOutputs,
  deps: Omit<GcpOnpremDeps, "facts" | "readSource"> = {}): Promise<RelayStepOutcome> {
  const env = deps.env ?? process.env;
  const ref = cloudSqlRefOfConnectionName(out.db_connection_name);
  if (!ref || !isIpv4(out.db_private_ip ?? ""))
    return { kind: "failed", failureCode: "RELAY_TARGET_DB_UNKNOWN", reason: "terraform 출력에 도착 Cloud SQL 연결 이름(db_connection_name)·사설 IP(db_private_ip)가 없다",
      detail: { missing: ["terraform output: db_connection_name", "terraform output: db_private_ip"], hint: "명세에 postgres 가 하나인지(gcp/root 는 하나일 때만 낸다) 확인한 뒤 다시 계획한다" } };
  const t = targetAdminOf(out);
  const keys = [...new Set(["db_admin_password" as const, ...(t.admin !== t.app ? ["db_password" as const] : [])])];
  const tf = readTfFacts(j.migrationId, env);
  const noSecret = keys.filter((k) => !tf[k]);
  if (noSecret.length)
    return { kind: "failed", failureCode: "RELAY_TARGET_DB_UNKNOWN", reason: `이전 작업 폴더 db-secret.json 에 도착 DB 비밀번호(${noSecret.join("·")})가 없다 (apply 의 비밀 꺼내기 실패)`,
      detail: { missing: noSecret.map((k) => `db-secret.json: ${k}`) } };
  const p = await provisionWithToken(j, m, "target", g, deps, (d) => describeCloudSqlPrivate(d, ref, "RELAY_TARGET_DB_UNKNOWN"));
  if (p.kind === "failed") return p;
  if (p.sql.privateIp !== out.db_private_ip)
    return failure(new RelayError("RELAY_TARGET_DB_UNKNOWN", `도착 Cloud SQL ${ref.instance} 의 사설 IP 가 terraform 출력과 다르다`));
  const existing = deps.existing ?? await withTenant(j.tenantId, (tx) => replicationEndpointsFor(tx, j.migrationId));
  let rows: [ReplicationEndpoint, ReplicationEndpoint];
  try {
    rows = onpremGcpEndpointRows({ tenantId: j.tenantId, migrationId: j.migrationId, sql: p.sql, out, db: g.db, appUser: g.user,
      publicIp: p.res.publicIp, privateIp: p.res.privateIp, knownHosts: p.knownHosts, existing });
  } catch (e) { return failure(e); }
  await (deps.save ?? ((r) => saveEndpointRows(j.tenantId, r)))(rows);
  // Cloud SQL API 로 만든 앱 계정은 cloudsqlsuperuser 라 울타리가 안 먹는다 → 관리자로 앱 로그인 역할을 SQL 로 맞춘다 (aws-gcp·gcp-aws 와 같음)
  let appLogin: string = "same_as_admin";
  if (t.admin !== t.app) {
    try { appLogin = await (deps.appLogin ?? ensureTargetAppLogin)(rows[1]); }
    catch (e) {
      return { kind: "failed", failureCode: "TARGET_APP_LOGIN_FAILED", reason: `도착 앱 로그인 역할을 못 맞췄다: ${((e as Error)?.message ?? String(e)).slice(0, 300)}`,
        detail: { missing: ["워커 → 중계 공개 IP:15432 → 도착 Cloud SQL 사설 IP:5432"], hint: "PLATFORM_EGRESS_CIDRS·방화벽 규칙 svc-relay-<이전>-entry·중계 VM 시작 스크립트(svc-relay-fwd)를 확인한 뒤 다시 승인한다" } };
    }
  }
  return { kind: "ok", detail: okDetail("onprem-gcp", p, { appLogin, targetTls: rows[1].sslmode }) };
}

/** 정리 (relay-step teardownRelayStep 이 GCP 짝일 때 부른다). 던지지 않는다 */
export async function teardownGcpRelayStep(j: Job, m: Pick<MigrationRow, "id" | "sourceEnvId" | "targetEnvId">, facts: RelayFacts, kind: GcpRelayKind,
  deps: Pick<GcpOnpremDeps, "env" | "borrow" | "exec"> = {}): Promise<RelayStepOutcome> {
  const env = deps.env ?? process.env;
  const side = kind === "gcp-onprem" ? "source" as const : "target" as const;
  // 만들 때와 같은 프로젝트: gcp-onprem = 출발 Cloud SQL 프로젝트(명세), onprem-gcp = 도착 이전 전용 프로젝트
  const project = side === "source" ? facts.cloudSql?.project ?? facts.sourceAccountId ?? null : facts.targetAccountId ?? null;
  if (!project || !PROJECT.test(project)) return { kind: "skipped", reason: `${side}_project_unknown` };
  const borrow = deps.borrow ?? (<T>(fn: (r: StepRoles) => Promise<T>) => withStepRoles(side === "source" ? "relay_gcp" : "relay_gcp_target", j, m as MigrationRow, fn));
  return borrow(async (roles): Promise<RelayStepOutcome> => {
    const token = roles.gcpToken?.[side];
    if (!token) return roles.denied.length
      ? { kind: "failed", failureCode: "RELAY_TEARDOWN_FAILED", reason: `GCP 실행 역할을 못 빌려 중계기를 못 지웠다: ${roles.denied.map((x) => x.code).join(",")}` }
      : { kind: "skipped", reason: `${side}_creds_mock` };
    try {
      const d: RelayGcpDeps = { env: gcpEnvFor(token, project, env), ...(deps.exec ? { exec: deps.exec } : {}), ...(roles.signal ? { signal: roles.signal } : {}) };
      const r = await teardownGcpRelay(d, project, j.migrationId);
      // gcp-onprem: 워커가 만든 복제 계정도 지운다 (복제 걷기 뒤라 슬롯·발행은 이미 없다). 못 지우면 정리를 멈추지 않고 detail 에 남긴다
      let replUser: string | undefined;
      if (side === "source" && facts.cloudSql) {
        try { replUser = (await dropCloudSqlReplUser(d, facts.cloudSql, gcpReplUser(j.migrationId))) ? "removed" : "absent"; }
        catch (e) { replUser = `failed: ${((e as Error).message ?? "").slice(0, 200)}`; }
      }
      return { kind: "ok", detail: { kind, project, removed: r.removed, ...(replUser ? { replUser } : {}) } };
    } catch (e) { return failure(e); }
  });
}

// ── 7. 사전 점검 (승인 전) ─────────────────────────────────────────────────────────

export interface GcpOnpremPrecheckItem { id: string; level: "block" | "warn"; message: string; fix?: string }
/** gcp-onprem: 출발 Cloud SQL 이 사설 IP 길을 받을 수 있나 + 출발 비밀번호 env. onprem-gcp: 문만 (도착 Cloud SQL 은 아직 없다).
 *  짝이 다르거나 흉내 자격이면 [] */
export async function gcpOnpremRelayPrecheck(j: Job, m: Pick<MigrationRow, "id" | "sourceEnvId" | "targetEnvId">, roles: Pick<StepRoles, "gcpToken"> | undefined,
  env: NodeJS.ProcessEnv, deps: { facts?: RelayFacts; exec?: Exec } = {}): Promise<GcpOnpremPrecheckItem[]> {
  const facts = deps.facts ?? await withTenant(j.tenantId, (tx) => readRelayFacts(tx, j.tenantId, m, env));
  const g = gcpOnpremGate(facts, env);
  if (g.kind === "skip") return [];
  const fmt = (message: string, missing?: string[]) => `FAIL ${message}${missing?.length ? ` — 빠진 것: ${missing.join(", ")}` : ""}`.slice(0, 1000);
  if (g.kind === "fail") return [{ id: "PC-RELAY-GCP-ONPREM", level: "block", message: fmt(g.reason, g.missing), ...(g.hint ? { fix: g.hint } : {}) }];
  if (g.relayKind !== "gcp-onprem" || !g.ref) return [];
  const out: GcpOnpremPrecheckItem[] = [];
  const secret = missingSourceSecret(facts, m, j.migrationId, env);
  if (secret) out.push({ id: "PC-RELAY-SQL-SECRET", level: "block", message: fmt("출발 Cloud SQL 관리자 비밀번호가 워커에 없다", [secret]),
    fix: `worker-env 비밀에 ${secret} 를 넣고 워커를 다시 띄운다` });
  const token = roles?.gcpToken?.source;
  if (!token) return [...out, { id: "PC-RELAY-SQL-READ", level: "warn", message: `출발 GCP 관찰 토큰이 없어 Cloud SQL ${g.ref.instance} 을 못 읽었다 (apply 가 다시 본다)` }];
  try {
    const sql = await describeCloudSqlPrivate({ env: gcpEnvFor(token, g.ref.project, env), ...(deps.exec ? { exec: deps.exec } : {}) }, g.ref, "RELAY_SOURCE_DB_UNKNOWN");
    // 논리 디코딩은 apply 가 켠다(재시작) → 막지 않고 알린다. 자동을 끈 배포만 막는다
    const auto = autoDbFlags(env);
    return [...out, ...cloudSqlPrivateProblems(sql, "source").map((p) => p.id === "PC-RELAY-SQL-DECODING" && auto
      ? { id: p.id, level: "warn" as const, message: `${p.message} → apply 가 자동으로 켠다 (Cloud SQL 이 한 번 재시작된다)`, fix: p.hint }
      : { id: p.id, level: "block" as const, message: fmt(p.message, p.missing), fix: p.hint })];
  } catch (e) {
    if (!(e instanceof RelayError)) throw e;
    return [...out, { id: "PC-RELAY-SQL-READ", level: "block", message: fmt(e.message, [`gcp: Cloud SQL ${g.ref.instance} (cloudsql.instances.get)`]),
      fix: "출발 GCP 연결(svc-observe)이 살아 있는지, 인스턴스 이름·프로젝트가 명세와 같은지 확인한 뒤 다시 점검한다" }];
  }
}
