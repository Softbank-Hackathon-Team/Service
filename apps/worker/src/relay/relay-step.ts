// 이전 흐름에 중계기 넣기: apply(자원 생성)가 출발 AWS 계정에 중계기를 만들고 복제 끝점 두 줄을 채운다.
//   정리(cleanup·롤백 걷기·repl-cleanup)가 복제 걷기와 gitops 정리 커밋(터널 걷음) 뒤에 중계기를 지운다.
// 이 파일은 "언제·누구 자격으로·무엇을 줄에 쓰나"만 정한다. 클라우드 호출은 aws-relay.ts
// 자격: 출발 환경 실행 역할(svc-operate)을 빌리고, 세션 정책은 중계기 동작만 (security STEP_ROLES.relay, policy relay)
// 건너뜀(아무것도 안 함): (출발, 도착) 짝이 RELAY_ROUTES 에 없음 / 온프레 도착이 pull 이 아님 / 명세에 postgres 없음 / 출발 자격이 흉내(시드 환경·REAL_STS=0) / RELAY_AUTO=0
//   → 로컬 데모·시드 환경은 예전 그대로 (끝점 줄은 사람이 tools/onprem-relay.sh 로 넣는다)
// GCP 도착(aws-gcp): apply 가 terraform 앞에서 도착 DB 공개 길(repl-network.json)을 정하고, terraform 뒤에 Cloud SQL 주소로 중계기를 만든다.
//   중계 공개 IP 가 새로 생겼으면 apply 가 terraform 을 한 번 더 돌려 Cloud SQL 허용 주소에 넣는다. 그다음 끝점 두 줄·도착 앱 로그인 역할 (apply.ts)
// GCP 출발(gcp-aws, relay/gcp-aws.ts): 중계기는 도착 AWS 계정에 산다 → 도착 실행 역할을 빌린다 (security STEP_ROLES.relay_target). 지우기도 이 파일 teardownRelayStep 이 같은 표로 고른다
import { PASSWORD_REF_RE, type AppSpecV2, type ReplicationEndpoint, type TfOutputs } from "@svc/contracts";
import { envFor, dbIdentityFor, specV2ForPlan } from "@svc/adapters";
import { endpointFromRecord, ensureLoginRole, readTfFacts, withClient } from "@svc/replication";
import { latestAcceptedSpecV2, replicationEndpointsFor, upsertReplicationEndpoint, withTenant, type Tx } from "@svc/core";
import { deriveSshHostKey, deriveSshKeypair, knownHostsLine, MIN_MASTER_KEY_LENGTH } from "../gitops/migration-secrets.js";
import { withStepRoles, type StepRoles } from "../jobs/_roles.js";
import type { MigrationRow } from "../jobs/_step.js";
import type { StopHint } from "../jobs/_stop-hint.js";
import { realStsEnabled } from "../platform.js";
import { latestOnpremEgressIp } from "./onprem-egress.js";
import {
  buildRelayPlan, discoverRelayNetwork, discoverRelaySource, isIpv4, platformEgressCidrs, provisionRelay, RelayError, resolveRelayAmi, teardownRelay,
  PG_PORT, RELAY_SOURCE_PORT, type CloudSqlPeer, type RelayAwsDeps, type RelayKind, type RelayResources, type RelaySource,
} from "./aws-relay.js";
import { loadReplNetwork, saveReplNetwork } from "../repl-network.js";
import { tenantSlug } from "../gitops/bundle.js";

// 차트 이전 역할 (adapters target/onprem.ts replication.role, gitops replication-delivery 기본값과 같은 글자)
export const RELAY_TARGET_USER = "svc_migrate";
export const RELAY_TARGET_PASSWORD_REF = "derive:migrate";
// DRAFT(ai): 서울. 환경 행에 region 이 없을 때 (_roles.ts awsCredFiles 와 같은 기본값)
const DEFAULT_REGION = "ap-northeast-2";

export type RelayStepOutcome =
  | { kind: "skipped"; reason: string }
  | { kind: "ok"; detail: Record<string, unknown> }
  | { kind: "failed"; failureCode: string; reason: string; detail?: Record<string, unknown> };

// ── 사실 읽기 · 문 (순수) ─────────────────────────────────────────────────────────────

export interface RelayFacts {
  sourceProvider: string | null; sourceRegion: string | null; sourceExternalId: string | null;
  targetProvider: string | null;
  /** 도착 환경 지역·연결 번호 (gcp-aws: 중계기가 도착 계정에 산다). 없으면 출발 쪽만 보는 예전 중계기 */
  targetRegion?: string | null; targetExternalId?: string | null;
  /** gcp-aws: 명세 postgres 의 출발 Cloud SQL (spec_v2.ids 의 selfLink 에서). 못 찾으면 null */
  cloudSql?: CloudSqlInstanceRef | null;
  /** 명세의 postgres 구성요소 (id · 앱 DB · 앱 계정) */
  postgres: { id: string; db: string; user: string }[];
  /** 그 postgres 의 출발 RDS 인스턴스 이름 (spec_v2.ids 의 벤더 키에서). 못 찾으면 null */
  rdsIdentifier: string | null;
  onpremEgressIp: string | null;
  existing: ReplicationEndpoint[];
}

/** spec_v2.ids(벤더 키 → 구성요소 id)에서 RDS 인스턴스 이름. 키 = DBInstanceArn 또는 "rds.dbInstance/<범위>/<ns>/<이름>" (import ids.ts nativeKey) */
export function rdsIdentifierFromIds(ids: Record<string, unknown> | null | undefined, componentId: string): string | null {
  for (const [k, v] of Object.entries(ids ?? {})) {
    if (v !== componentId) continue;
    const arn = /^arn:aws[a-z-]*:rds:[a-z0-9-]+:\d{12}:db:([A-Za-z][A-Za-z0-9-]{0,62})$/.exec(k);
    if (arn) return arn[1]!;
    const nk = /^rds\.dbInstance\/.*\/([A-Za-z][A-Za-z0-9-]{0,62})$/.exec(k);
    if (nk) return nk[1]!;
  }
  return null;
}

export async function readRelayFacts(tx: Tx, tenantId: string, m: Pick<MigrationRow, "id" | "sourceEnvId" | "targetEnvId">,
  env: NodeJS.ProcessEnv = process.env): Promise<RelayFacts> {
  const e = await tx.query<{ id: string; provider: string; region: string | null; external_id: string | null; account_id: string | null }>(
    `SELECT id, provider, region, external_id, account_id FROM environments WHERE id = ANY($1::uuid[])`, [[m.sourceEnvId, m.targetEnvId]]);
  const src = e.rows.find((r) => r.id === m.sourceEnvId), dst = e.rows.find((r) => r.id === m.targetEnvId);
  const row = await latestAcceptedSpecV2(tx, m.id);
  const spec: AppSpecV2 | null = row ? specV2ForPlan(row) : null;
  const postgres = (spec?.components ?? []).flatMap((c) => c.kind === "postgres" ? [{ id: c.id, ...pick(dbIdentityFor(spec!, c)) }] : []);
  let rdsIdentifier: string | null = null, cloudSql: CloudSqlInstanceRef | null = null;
  if (row && postgres.length === 1) {
    const ids = (await tx.query<{ ids: Record<string, unknown> | null }>(
      `SELECT to_jsonb(s)->'spec_v2'->'ids' AS ids FROM spec_versions s WHERE s.migration_id = $1 AND s.version = $2`, [m.id, row.version])).rows[0]?.ids;
    rdsIdentifier = rdsIdentifierFromIds(ids, postgres[0]!.id);
    // GCP 출발: selfLink 에 프로젝트가 없으면(nativeKey 꼴) 출발 환경의 프로젝트(account_id)
    if (src?.provider === "gcp") cloudSql = cloudSqlInstanceFromIds(ids, postgres[0]!.id, src.account_id);
  }
  const egress = dst?.provider === "onprem" ? await latestOnpremEgressIp(tx, tenantId, m.targetEnvId, env) : undefined;
  return { sourceProvider: src?.provider ?? null, sourceRegion: src?.region ?? null, sourceExternalId: src?.external_id ?? null,
           targetProvider: dst?.provider ?? null, targetRegion: dst?.region ?? null, targetExternalId: dst?.external_id ?? null,
           postgres, rdsIdentifier, cloudSql, onpremEgressIp: egress?.ip ?? null,
           existing: await replicationEndpointsFor(tx, m.id) };
}

/** 출발 Cloud SQL 인스턴스 (프로젝트·이름) */
export interface CloudSqlInstanceRef { project: string; instance: string }
/** spec_v2.ids(벤더 키 → 구성요소 id)에서 Cloud SQL 인스턴스. 키 = selfLink(…/projects/<p>/instances/<이름>) 또는 "cloudsql.instance/<범위>/<ns>/<이름>" (import ids.ts nativeKey).
 *  nativeKey 꼴은 범위가 프로젝트가 아닐 수 있어 출발 환경 프로젝트(fallbackProject)를 쓴다 */
export function cloudSqlInstanceFromIds(ids: Record<string, unknown> | null | undefined, componentId: string, fallbackProject: string | null = null): CloudSqlInstanceRef | null {
  const PROJECT = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/, NAME = /^[a-z][a-z0-9-]{0,97}$/;
  for (const [k, v] of Object.entries(ids ?? {})) {
    if (v !== componentId) continue;
    const self = /^https:\/\/(?:sqladmin|www)\.googleapis\.com\/sql\/v1(?:beta4)?\/projects\/([^/]+)\/instances\/([^/?#]+)$/.exec(k);
    if (self && PROJECT.test(self[1]!) && NAME.test(self[2]!)) return { project: self[1]!, instance: self[2]! };
    const nk = /^cloudsql\.instance\/.*\/([a-z][a-z0-9-]{0,97})$/.exec(k);
    if (nk && fallbackProject && PROJECT.test(fallbackProject)) return { project: fallbackProject, instance: nk[1]! };
  }
  return null;
}
const pick = (x: { db: string; user: string }) => ({ db: x.db, user: x.user });

/** 중계기 종류 = 출발 계정의 중계기가 무엇을 나르나.
 *  aws-onprem: 출발 AWS 에 SSH 터널(온프레 Agent) + 워커 출발 입구. aws-gcp: 출발 AWS 에 워커·Cloud SQL 출발 입구 + Cloud SQL 로 가는 역방향 입구 */
export type { RelayKind };
// (출발, 도착) → 중계기 종류. 표에 없는 짝은 중계기 없음 (사람이 tools/onprem-relay.sh·DB_PUBLIC 으로 길을 낸다)
export const RELAY_ROUTES: Readonly<Record<string, RelayKind>> = {
  "aws->onprem": "aws-onprem",
  "aws->gcp": "aws-gcp",
  // 중계기는 도착 AWS 계정에 (relay/gcp-aws.ts). 빌리는 역할 = 도착 실행 역할 (relayHome)
  "gcp->aws": "gcp-aws",
};
/** 중계기가 사는 쪽 (그 쪽 환경의 실행 역할을 빌린다) */
export const relayHome = (kind: RelayKind): "source" | "target" => (kind === "gcp-aws" ? "target" : "source");
/** 중계기를 다루는 단계 역할 (security STEP_ROLES): 출발 계정이면 relay, 도착 계정이면 relay_target */
export const relayRoleStep = (kind: RelayKind) => (relayHome(kind) === "target" ? "relay_target" as const : "relay" as const);
export const relayKindOf = (sourceProvider: string | null, targetProvider: string | null): RelayKind | null =>
  RELAY_ROUTES[`${sourceProvider}->${targetProvider}`] ?? null;

/** 중계기를 다룰 이전인가 (만들기·지우기 공통). 아니면 건너뛸 이유 */
export function relayApplies(f: Pick<RelayFacts, "sourceProvider" | "sourceExternalId" | "targetProvider"> & Pick<Partial<RelayFacts>, "targetExternalId">,
  env: NodeJS.ProcessEnv): string | null {
  const kind = relayKindOf(f.sourceProvider, f.targetProvider);
  if (!kind) return "no_relay_route";
  // DRAFT(ai): RELAY_AUTO=0 = 운영자가 중계기를 직접 다룬다 (tools/onprem-relay.sh). 기본 켬
  if (env.RELAY_AUTO === "0") return "relay_auto_off";
  // 흉내 자격(시드 환경 = external_id 없음, 또는 REAL_STS=0)으로는 고객 계정을 못 부른다 (platform.ts awsIssuer·perEnvAwsIssuer 와 같은 기준).
  //   중계기가 사는 쪽(relayHome)의 AWS 환경을 본다
  const home = relayHome(kind);
  if (!realStsEnabled(env) || !(home === "target" ? f.targetExternalId : f.sourceExternalId)) return `${home}_creds_mock`;
  return null;
}

export type RelayGate =
  | { kind: "skip"; reason: string }
  | { kind: "fail"; failureCode: string; reason: string }
  | { kind: "go"; identifier: string; egressIp: string; platformCidrs: string[]; masterKey: string; region: string; db: string; user: string };

/** 만들기 전에 정할 것 전부 (순수). 실패는 클라우드를 부르기 전에 낸다 */
export function relayGate(f: RelayFacts, env: NodeJS.ProcessEnv): RelayGate {
  if (env.ONPREM_FLOOR_VIA_GIT === "0") return { kind: "skip", reason: "not_pull_mode" };
  const no = relayApplies(f, env);
  if (no) return { kind: "skip", reason: no };
  if (relayKindOf(f.sourceProvider, f.targetProvider) !== "aws-onprem") return { kind: "skip", reason: "not_onprem_relay" };
  if (!f.postgres.length) return { kind: "skip", reason: "no_postgres" };
  // 22 를 세상에 열지 않는다: 온프레 나가는 IP 를 모르면 만들지 않는다
  if (!f.onpremEgressIp || !isIpv4(f.onpremEgressIp))
    return { kind: "fail", failureCode: "ONPREM_EGRESS_UNKNOWN",
      reason: "온프레 클러스터의 나가는 공인 IP 를 모른다 (Agent facts 보고에 egressIp 가 없거나 오래됨): 중계기 SSH(22)를 세상에 열지 않으려고 멈췄다. "
        + "고객 서버에서 kubectl -n svc-agent logs deploy/onprem-agent 로 facts 보고와 EGRESS_IP_URL(기본 https://checkip.amazonaws.com) 접속을 확인하고, "
        + "facts 가 다시 온 뒤(AGENT_FACTS_MAX_AGE_SEC 안) 다시 계획·승인한다" };
  if (f.postgres.length !== 1) return { kind: "fail", failureCode: "RELAY_SOURCE_DB_UNKNOWN", reason: `명세에 postgres 가 ${f.postgres.length}개다 (중계기·끝점 줄은 이전마다 하나)` };
  if (!f.rdsIdentifier) return { kind: "fail", failureCode: "RELAY_SOURCE_DB_UNKNOWN", reason: "명세의 postgres 에 출발 RDS 인스턴스 이름이 없다 (spec_v2.ids). 가져오기를 다시 하거나 RELAY_AUTO=0 으로 사람이 중계기를 세운다" };
  const masterKey = env.REPL_SECRET_MASTER_KEY;
  if (!masterKey || masterKey.length < MIN_MASTER_KEY_LENGTH)
    return { kind: "fail", failureCode: "REPL_SECRET_UNRESOLVED", reason: `REPL_SECRET_MASTER_KEY 가 없거나 ${MIN_MASTER_KEY_LENGTH}자보다 짧다: 터널·호스트 키를 파생할 수 없다` };
  let platformCidrs: string[];
  try { platformCidrs = platformEgressCidrs(env.PLATFORM_EGRESS_CIDRS); }
  catch (e) { return { kind: "fail", failureCode: (e as RelayError).code ?? "RELAY_CONFIG_MISSING", reason: (e as Error).message }; }
  const pg = f.postgres[0]!;
  return { kind: "go", identifier: f.rdsIdentifier, egressIp: f.onpremEgressIp, platformCidrs, masterKey,
           region: f.sourceRegion || DEFAULT_REGION, db: pg.db, user: pg.user };
}

/** 출발 줄의 비밀번호 참조 (순수). RDS 관리 비밀 ARN 이 계약 모양이면 aws-sm:, 아니면 출발 환경 기준 env: */
export function sourcePasswordRef(masterSecretArn: string | null, sourceEnvId: string, id8: string): string {
  const sm = masterSecretArn ? `aws-sm:${masterSecretArn}` : null;
  if (sm && PASSWORD_REF_RE.test(sm)) return sm;
  return `env:REPL_SECRET_SRC_${(sourceEnvId.replace(/[^A-Za-z0-9]/g, "").slice(0, 8) || id8).toUpperCase()}`;
}

/** 끝점 두 줄 (순수). 배달(deploy)이 채우는 칸(도착 ca_pem·tls_servername·sslmode, 출발 peer)은 같은 중계기면 그대로 둔다 */
export function relayEndpointRows(i: {
  tenantId: string; migrationId: string; sourceEnvId: string; rds: RelaySource; db: string; appUser: string;
  publicIp: string; privateIp: string; knownHosts: string; existing: readonly ReplicationEndpoint[];
}): [ReplicationEndpoint, ReplicationEndpoint] {
  const id8 = i.migrationId.replace(/-/g, "").slice(0, 8);
  const oldT = i.existing.find((e) => e.side === "target");
  const sameRelay = oldT?.relayHost === i.publicIp;
  const source = relaySourceRow(i);
  const target: ReplicationEndpoint = {
    tenantId: i.tenantId, migrationId: i.migrationId, side: "target", label: `onprem-cnpg-${id8}`, provider: "cnpg",
    // 워커 → 중계 공개 IP:5432 (역방향 터널) → 온프레 CNPG. RDS(롤백 창 역복제)는 중계 사설 IP:5432 로 붙는다
    host: i.publicIp, port: PG_PORT, dbname: i.db, username: RELAY_TARGET_USER, passwordRef: RELAY_TARGET_PASSWORD_REF,
    peerHost: i.privateIp, peerPort: PG_PORT,
    appRole: i.appUser, fenceRoles: oldT?.fenceRoles ?? [], schemaName: oldT?.schemaName ?? null,
    sslmode: sameRelay ? oldT?.sslmode ?? "require" : "require",
    tlsServername: sameRelay ? oldT?.tlsServername ?? null : null, caPem: sameRelay ? oldT?.caPem ?? null : null,
    relayHost: i.publicIp, relayKnownHosts: i.knownHosts, relayPort: 22,
  };
  return [source, target];
}

/** 출발 줄 (순수, 온프레·GCP 중계기 공통): 워커와 상대 DB 가 중계 공개 IP:15432(출발 입구)로 RDS 에 붙는다 */
function relaySourceRow(i: { tenantId: string; migrationId: string; sourceEnvId: string; rds: RelaySource; db: string; appUser: string;
  publicIp: string; existing: readonly ReplicationEndpoint[] }): ReplicationEndpoint {
  const id8 = i.migrationId.replace(/-/g, "").slice(0, 8);
  const oldS = i.existing.find((e) => e.side === "source");
  // DRAFT(ai): 워커는 출발 RDS 에 직접 못 닿는다 (비공개 RDS·다른 VPC, 2026-11-06 실측 TIMEOUT) → 중계기 출발 입구(공개 IP:15432, TCP 그대로)로 붙는다.
  //   진짜 RDS 이름은 tls_servername 에 둔다: 서버 인증서 이름이고, 온프레 정방향 터널 목적지(replication-delivery forwardTarget)도 이 이름이다.
  //   (relay_* 칸은 DB 검사 replication_endpoints_relay_side 가 도착 줄에만 허용해서 출발 줄에는 못 쓴다)
  return {
    tenantId: i.tenantId, migrationId: i.migrationId, side: "source", label: `rds-src-${id8}`, provider: "rds",
    host: i.publicIp, port: RELAY_SOURCE_PORT, dbname: i.db,
    // 마스터 사용자 (RDS 에서 복제 슬롯·발행을 만들 권한). 못 읽었으면 앱 계정
    username: i.rds.masterUsername ?? i.appUser,
    // DECISION(team): 출발 관리자 비밀번호는 RDS 가 관리하는 마스터 비밀(rds!db-…)을 빌린 역할로 읽는다 (2026-11-06, 보안·온프레 영역 제안 +
    //   연결 템플릿 영역 동의). RDS 에 관리 비밀이 있으면 aws-sm:<ARN> (워커가 단계마다 읽어 메모리에만, relay/source-secret.ts).
    //   없으면(고객이 비밀 관리를 안 켬) 예전 env: 참조로 남는다 = 운영자가 워커 env REPL_SECRET_SRC_<출발 환경 id8> 에 넣어야 한다. 운영자가 바꾼 참조는 그대로 둔다
    // DRAFT(ai): env 이름은 이전이 아니라 출발 환경 기준 (REPL_SECRET_SRC_<출발 환경 앞 8자>). 같은 출발 RDS 로 이전을 다시 만들 때마다
    //   워커 env 키를 새로 넣고 다시 배포하던 일을 없앤다 (2026-11-06 실측: 이전마다 platform/app 키 + secretKeys + helm). 값은 같은 DB 의 같은 비밀번호다
    passwordRef: oldS?.passwordRef ?? sourcePasswordRef(i.rds.masterSecretArn, i.sourceEnvId, id8),
    peerHost: oldS?.peerHost ?? null, peerPort: oldS?.peerPort ?? null,
    appRole: i.appUser, fenceRoles: oldS?.fenceRoles ?? [], schemaName: oldS?.schemaName ?? null,
    sslmode: oldS?.sslmode ?? "require", tlsServername: i.rds.endpoint, caPem: oldS?.caPem ?? null,
    relayHost: null, relayKnownHosts: null, relayPort: 22,
  };
}

// ── 단계 ──────────────────────────────────────────────────────────────────────────

export interface RelayStepDeps {
  env?: NodeJS.ProcessEnv;
  facts?: RelayFacts;
  /** 출발 중계기 역할 빌리기 (시험이 바꾼다). 기본 withStepRoles("relay") */
  borrow?: <T>(fn: (r: Pick<StepRoles, "awsEnv" | "denied" | "signal">) => Promise<T>) => Promise<T>;
  aws?: Partial<Pick<RelayAwsDeps, "exec" | "sleep" | "pollMs" | "pollTries">>;
  /** 끝점 줄 쓰기 (기본 withTenant upsert) */
  save?: (rows: ReplicationEndpoint[]) => Promise<void>;
}
type Job = { tenantId: string; migrationId: string };

function relayFailure(e: unknown, extra: Record<string, unknown> = {}): RelayStepOutcome {
  if (e instanceof RelayError)
    return { kind: "failed", failureCode: e.code, reason: e.message,
      detail: { ...extra, ...(e.awsCode ? { awsCode: e.awsCode } : {}),
        hint: "만든 자원은 태그(managed-by=platform, svc:migration=<이전>)를 단 채 남는다. 원인을 고친 뒤 다시 계획·승인하면 태그로 찾아 이어 간다. 취소하면 repl-cleanup 이 태그로 지운다" } };
  throw e;
}

/** apply: 출발 계정에 중계기를 만들고(이미 있으면 그대로) 끝점 두 줄을 쓴다. 다시 불러도 된다 (작업 재시도·다시 계획) */
export async function provisionRelayStep(j: Job, m: MigrationRow, deps: RelayStepDeps = {}): Promise<RelayStepOutcome> {
  const env = deps.env ?? process.env;
  const facts = deps.facts ?? await withTenant(j.tenantId, (tx) => readRelayFacts(tx, j.tenantId, m, env));
  const g = relayGate(facts, env);
  if (g.kind === "skip") return { kind: "skipped", reason: g.reason };
  if (g.kind === "fail") return { kind: "failed", failureCode: g.failureCode, reason: g.reason };
  const borrow = deps.borrow ?? (<T>(fn: (r: StepRoles) => Promise<T>) => withStepRoles("relay", j, m, fn));
  return borrow(async (roles) => {
    const cred = roles.awsEnv?.source;
    if (!cred) return roles.denied.length
      ? { kind: "failed", failureCode: "RELAY_ROLE_DENIED", reason: `출발 실행 역할(중계기 세션 정책)을 못 빌렸다: ${roles.denied.map((x) => x.code).join(",")} (infra/permissions/aws-relay-statements.json 을 svc-operate 에 붙였는지)` }
      : { kind: "skipped", reason: "source_creds_mock" };
    const d: RelayAwsDeps = { env: envFor(cred, env), region: g.region, ...(roles.signal ? { signal: roles.signal } : {}), ...deps.aws };
    let res: RelayResources, rds: RelaySource, subnetId: string;
    try {
      rds = await discoverRelaySource(d, g.identifier);
      const [net, ami] = await Promise.all([discoverRelayNetwork(d, rds.vpcId), resolveRelayAmi(d)]);
      subnetId = net.subnetId;
      const plan = buildRelayPlan({ kind: "aws-onprem", migrationId: j.migrationId, rds, network: net, ami, platformEgressCidrs: g.platformCidrs, onpremEgressIp: g.egressIp,
        tunnelPublicKey: deriveSshKeypair(g.masterKey, j.tenantId, j.migrationId).publicKeyLine,
        hostKey: deriveSshHostKey(g.masterKey, j.tenantId, j.migrationId) });
      res = await provisionRelay(d, plan);
    } catch (e) { return relayFailure(e, { rdsIdentifier: g.identifier }); }
    const knownHosts = knownHostsLine(res.publicIp, deriveSshHostKey(g.masterKey, j.tenantId, j.migrationId).publicKeyLine);
    const rows = relayEndpointRows({ tenantId: j.tenantId, migrationId: j.migrationId, sourceEnvId: m.sourceEnvId, rds, db: g.db, appUser: g.user,
      publicIp: res.publicIp, privateIp: res.privateIp, knownHosts, existing: facts.existing });
    await (deps.save ?? ((r) => withTenant(j.tenantId, async (tx) => { for (const x of r) await upsertReplicationEndpoint(tx, x); })))(rows);
    // 감사 detail: 번호·주소만 (키·비밀번호 없음). 자원의 진실은 태그다 (이 detail 은 사람이 찾기 쉽게)
    return { kind: "ok", detail: { instanceId: res.instanceId, securityGroupId: res.securityGroupId, dbEgressRuleId: res.dbEgressRuleId, ...(res.dbEgressCoveredBy ? { dbEgressCoveredBy: res.dbEgressCoveredBy } : {}),
      dbIngressRuleId: res.dbIngressRuleId, ...(res.dbIngressCoveredBy ? { dbIngressCoveredBy: res.dbIngressCoveredBy } : {}), sourceEntryPort: RELAY_SOURCE_PORT,
      publicIp: res.publicIp, privateIp: res.privateIp, subnetId, rdsIdentifier: rds.identifier, rdsSecurityGroupId: rds.securityGroupIds[0],
      created: res.created, reused: res.reused, region: g.region, endpointRows: ["source", "target"] } };
  });
}

/** 정리: 이 이전 태그가 달린 중계기 자원을 지운다 (RDS 나가기 규칙 → EC2 → 보안 그룹). 던지지 않는다 (실패는 failed 로).
 *  중계기가 사는 계정(relayHome: aws-onprem·aws-gcp = 출발, gcp-aws = 도착)의 실행 역할을 빌린다. 부르는 쪽(cleanup·롤백·repl-cleanup)은 짝을 몰라도 된다 */
export async function teardownRelayStep(j: Job, m: Pick<MigrationRow, "id" | "sourceEnvId" | "targetEnvId">, deps: RelayStepDeps = {}): Promise<RelayStepOutcome> {
  const env = deps.env ?? process.env;
  try {
    const facts = deps.facts ?? await withTenant(j.tenantId, (tx) => readRelayFacts(tx, j.tenantId, m, env));
    const no = relayApplies(facts, env) ?? (facts.postgres.length ? null : "no_postgres");
    if (no) return { kind: "skipped", reason: no };
    const kind = relayKindOf(facts.sourceProvider, facts.targetProvider)!;
    const home = relayHome(kind), sideName = home === "target" ? "도착" : "출발";
    const borrow = deps.borrow ?? (<T>(fn: (r: StepRoles) => Promise<T>) => withStepRoles(relayRoleStep(kind), j, m as MigrationRow, fn));
    return await borrow(async (roles) => {
      const cred = roles.awsEnv?.[home];
      if (!cred) return roles.denied.length
        ? { kind: "failed", failureCode: "RELAY_TEARDOWN_FAILED", reason: `${sideName} 실행 역할(중계기 세션 정책)을 못 빌려 중계기를 못 지웠다: ${roles.denied.map((x) => x.code).join(",")}` }
        : { kind: "skipped", reason: `${home}_creds_mock` };
      const region = (home === "target" ? facts.targetRegion : facts.sourceRegion) || DEFAULT_REGION;
      const d: RelayAwsDeps = { env: envFor(cred, env), region, ...(roles.signal ? { signal: roles.signal } : {}), ...deps.aws };
      try {
        const r = await teardownRelay(d, j.migrationId);
        return { kind: "ok", detail: { removed: r.removed } };
      } catch (e) { return relayFailure(e); }
    });
  } catch (e) {
    // 역할 빌리기·DB 읽기 실패도 정리 실패로 (정리 단계가 paused·경고로 남긴다). 자원은 태그를 단 채 남는다
    if (e instanceof RelayError) return relayFailure(e);
    return { kind: "failed", failureCode: "RELAY_TEARDOWN_FAILED", reason: `중계기 정리 실패: ${((e as Error)?.message ?? String(e)).slice(0, 300)}` };
  }
}

// ── GCP 도착 (aws-gcp) ──────────────────────────────────────────────────────────────

// 도착 관리자 비밀번호 = 실행기가 Secret Manager 에서 꺼내 이전 작업 폴더 db-secret.json 에 둔 값 (real-runner fetchSecret)
export const GCP_TARGET_PASSWORD_REF = "tf:db_admin_password";

// fail 의 missing·hint: 설정이 모자라 멈춘 경우의 고칠 자리 (apply 가 detail 에 펼친다. 지금 apply.ts 는 reason 만 쓰므로 reason 글에도 같은 안내를 넣는다)
export type GcpRelayGate =
  | { kind: "skip"; reason: string }
  | ({ kind: "fail"; failureCode: string; reason: string } & Partial<StopHint>)
  | { kind: "go"; identifier: string; platformCidrs: string[]; region: string; db: string; user: string };

// ── GCP 도착 중계기의 고칠 자리 (실패 코드마다 하나). 설정·권한이 모자란 경우만 ──
const GCP_RELAY_FIX: Record<"egress" | "role_denied" | "no_cred" | "aws_denied" | "db_egress" | "db_ingress", StopHint> = {
  egress: { missing: ["PLATFORM_EGRESS_CIDRS"],
    hint: "worker-env 비밀(Secrets Manager platform/app JSON 의 PLATFORM_EGRESS_CIDRS, 차트 components.worker.secretKeys)에 워커 NAT 공인 IP 대역(/24 이상 좁게, 쉼표 목록)을 넣고 워커를 다시 띄운 뒤 다시 계획한다" },
  role_denied: { missing: ["aws: svc-operate 인라인 정책 relay"],
    hint: "출발 AWS 연결 스택(CloudFormation svc-connect-*)을 새 템플릿으로 업데이트해 svc-operate 에 중계기 정책(relay = infra/permissions/aws-relay-statements.json)을 붙이고, worker 이미지의 권한 파일에 같은 파일이 있는지 확인한 뒤 다시 계획·승인한다" },
  no_cred: { missing: ["aws: svc-operate"],
    hint: "출발 AWS 환경을 연결 링크(CloudFormation 연결 스택, ExternalId)로 연결했는지 확인한 뒤 다시 계획·승인한다" },
  aws_denied: { missing: ["aws: svc-operate 인라인 정책 relay"],
    hint: "출발 AWS 연결 스택을 새 템플릿으로 업데이트해 svc-operate 의 중계기 정책(relay)을 지금 판으로 맞춘 뒤 다시 계획·승인한다" },
  db_egress: { missing: ["aws: 연결 스택 입력값 SourceDbSecurityGroupId"],
    hint: "출발 AWS 연결 스택을 업데이트해 SourceDbSecurityGroupId 에 출발 RDS 보안 그룹을 넣거나, 고객이 그 보안 그룹에 중계기로 나가는 TCP 5432 를 직접 연 뒤 다시 계획·승인한다" },
  db_ingress: { missing: ["aws: 연결 스택 입력값 SourceDbSecurityGroupId"],
    hint: "출발 AWS 연결 스택을 새 템플릿으로 업데이트해 SourceDbSecurityGroupId 에 출발 RDS 보안 그룹을 넣거나, 고객이 그 보안 그룹에 중계기 VPC 대역에서 들어오는 TCP 5432 를 직접 연 뒤 다시 계획·승인한다" },
};
// db-secret.json 이 비었을 때 (missing 은 빠진 키에 따라 provisionGcpRelayStep 이 채운다)
const DB_SECRET_HINT = "terraform apply 뒤 Secret Manager 에서 도착 DB 비밀번호를 못 꺼냈다(감사 terraform.secretFetched): 도착 svc-operate 에 DB 비밀 읽기 권한(gcp: secretmanager.versions.access, 고객이 infra/onboarding/gcp-connect.sh 재실행)이 있는지, 워커 TF_FETCH_DB_SECRET 을 끄지 않았는지 확인한 뒤 다시 계획·승인한다";
const AWS_DENIED = /^(UnauthorizedOperation|AccessDenied)/;
/** provisionGcpRelayStep 의 실패에 고칠 자리를 더한다 (apply 가 detail.relay 로 펼친다). 원래 detail.hint(태그 안내)는 뒤에 붙여 남긴다 */
function withGcpRelayFix(f: Extract<RelayStepOutcome, { kind: "failed" }>, fix: StopHint | undefined): Extract<RelayStepOutcome, { kind: "failed" }> {
  if (!fix) return f;
  const before = typeof f.detail?.hint === "string" ? f.detail.hint : null;
  return { ...f, detail: { ...f.detail, missing: fix.missing, hint: before ? `${fix.hint} / ${before}` : fix.hint } };
}
const relayErrorFix = (code: string, awsCode: unknown): StopHint | undefined =>
  code === "RELAY_DB_EGRESS_DENIED" ? GCP_RELAY_FIX.db_egress
    : code === "RELAY_DB_INGRESS_DENIED" ? GCP_RELAY_FIX.db_ingress
    : AWS_DENIED.test(typeof awsCode === "string" ? awsCode : "") ? GCP_RELAY_FIX.aws_denied : undefined;

/** GCP 도착 중계기를 만들 이전인가 (순수). 온프레 문(relayGate)과 같은 앞 조건, SSH·온프레 IP·마스터 키는 안 본다 */
export function gcpRelayGate(f: RelayFacts, env: NodeJS.ProcessEnv): GcpRelayGate {
  const no = relayApplies(f, env);
  if (no) return { kind: "skip", reason: no };
  if (relayKindOf(f.sourceProvider, f.targetProvider) !== "aws-gcp") return { kind: "skip", reason: "not_gcp_relay" };
  if (!f.postgres.length) return { kind: "skip", reason: "no_postgres" };
  if (f.postgres.length !== 1) return { kind: "fail", failureCode: "RELAY_SOURCE_DB_UNKNOWN", reason: `명세에 postgres 가 ${f.postgres.length}개다 (중계기·끝점 줄은 이전마다 하나)` };
  if (!f.rdsIdentifier) return { kind: "fail", failureCode: "RELAY_SOURCE_DB_UNKNOWN", reason: "명세의 postgres 에 출발 RDS 인스턴스 이름이 없다 (spec_v2.ids). 가져오기를 다시 하거나 RELAY_AUTO=0 으로 사람이 길을 낸다" };
  let platformCidrs: string[];
  try { platformCidrs = platformEgressCidrs(env.PLATFORM_EGRESS_CIDRS); }
  catch (e) {
    // apply.ts 는 이 문의 reason 만 detail.error 로 남긴다 → 고칠 자리를 reason 글에도 붙인다 (missing·hint 칸은 apply 가 펼치면 보인다)
    const fix = GCP_RELAY_FIX.egress;
    return { kind: "fail", failureCode: (e as RelayError).code ?? "RELAY_CONFIG_MISSING", reason: `${(e as Error).message} → ${fix.hint}`, ...fix };
  }
  const pg = f.postgres[0]!;
  return { kind: "go", identifier: f.rdsIdentifier, platformCidrs, region: f.sourceRegion || DEFAULT_REGION, db: pg.db, user: pg.user };
}

/** apply 의 terraform 앞: 문을 보고, 도착 DB 공개 길(플랫폼 나가는 대역 + 앞 실행에서 넣은 중계 IP, 앱 로그인은 SQL)을 작업 폴더에 둔다.
 *  apply-real prepare 가 이 파일을 postgres_json 에 덧씌운다 (계획 지문 밖, 감사 detail.replicationNetwork) */
export async function prepareGcpRelayStep(j: Job, m: MigrationRow, deps: Pick<RelayStepDeps, "env" | "facts"> = {}): Promise<GcpRelayGate> {
  const env = deps.env ?? process.env;
  const facts = deps.facts ?? await withTenant(j.tenantId, (tx) => readRelayFacts(tx, j.tenantId, m, env));
  const g = gcpRelayGate(facts, env);
  if (g.kind !== "go") return g;
  const tenant = tenantSlug(j.tenantId);
  // 중계 IP 는 앞 실행 값을 그대로 품는다 (재시도의 첫 terraform 이 Cloud SQL 허용 주소에서 중계 IP 를 뺐다 넣지 않게)
  saveReplNetwork(env, tenant, j.migrationId, { platformCidrs: g.platformCidrs, relayIp: loadReplNetwork(env, tenant, j.migrationId)?.relayIp ?? null, appLoginSql: true });
  return g;
}

/** terraform 출력 → Cloud SQL 공개 주소 둘. 없으면(공개가 안 켜짐) null */
export function cloudSqlPeerOf(out: TfOutputs): CloudSqlPeer | null {
  const publicIp = out.db_public_ip ?? "", outgoingIp = out.db_outgoing_ip ?? "";
  return isIpv4(publicIp) && isIpv4(outgoingIp) ? { publicIp, outgoingIp } : null;
}

export type GcpRelayProvisioned = { kind: "ok"; res: RelayResources; rds: RelaySource; subnetId: string } | Extract<RelayStepOutcome, { kind: "failed" }>;

/** apply 의 terraform 뒤: 출발 계정에 GCP 도착 중계기를 만든다(이미 있으면 그대로, Cloud SQL 이 바뀌었으면 새로). 끝점 줄은 아직 안 쓴다 */
export async function provisionGcpRelayStep(j: Job, m: MigrationRow, g: Extract<GcpRelayGate, { kind: "go" }>, cloudSql: CloudSqlPeer,
  deps: Omit<RelayStepDeps, "facts" | "save"> = {}): Promise<GcpRelayProvisioned> {
  const env = deps.env ?? process.env;
  // 도착 DB 비밀번호 둘(앱 로그인 역할 = db_password, 워커가 붙는 관리자 = db_admin_password)은 terraform apply 가 db-secret.json 에 꺼내 둔다.
  //   예전엔 끝점 줄을 쓰고 ensureTargetAppLogin 에서야 없음을 알았고, apply.ts 가 그걸 TARGET_APP_LOGIN_FAILED(네트워크 안내)로 남겼다.
  //   중계기를 만들기 전에 RELAY_TARGET_DB_UNKNOWN 으로 멈춘다 (apply.ts 는 relay.failureCode 를 그대로 쓴다)
  const facts = readTfFacts(j.migrationId, env);
  const noSecret = (["db_password", "db_admin_password"] as const).filter((k) => !facts[k]);
  if (noSecret.length)
    return { kind: "failed", failureCode: "RELAY_TARGET_DB_UNKNOWN",
      reason: `이전 작업 폴더 db-secret.json 에 도착 DB 비밀번호(${noSecret.join("·")})가 없다 (apply 의 비밀 꺼내기 실패)`,
      detail: { missing: noSecret.map((k) => `db-secret.json: ${k}`), hint: DB_SECRET_HINT } satisfies StopHint };
  const borrow = deps.borrow ?? (<T>(fn: (r: StepRoles) => Promise<T>) => withStepRoles("relay", j, m, fn));
  return borrow(async (roles): Promise<GcpRelayProvisioned> => {
    const cred = roles.awsEnv?.source;
    if (!cred) return { kind: "failed", failureCode: "RELAY_ROLE_DENIED", reason: roles.denied.length
      ? `출발 실행 역할(중계기 세션 정책)을 못 빌렸다: ${roles.denied.map((x) => x.code).join(",")} (infra/permissions/aws-relay-statements.json 을 svc-operate 에 붙였는지)`
      : "출발 실행 역할 자격이 없다 (출발 환경이 AWS 인지, 연결이 끝났는지)",
      detail: { ...(roles.denied.length ? GCP_RELAY_FIX.role_denied : GCP_RELAY_FIX.no_cred) } };
    const d: RelayAwsDeps = { env: envFor(cred, env), region: g.region, ...(roles.signal ? { signal: roles.signal } : {}), ...deps.aws };
    try {
      const rds = await discoverRelaySource(d, g.identifier);
      const [net, ami] = await Promise.all([discoverRelayNetwork(d, rds.vpcId), resolveRelayAmi(d)]);
      const res = await provisionRelay(d, buildRelayPlan({ kind: "aws-gcp", migrationId: j.migrationId, rds, network: net, ami, platformEgressCidrs: g.platformCidrs, cloudSql }));
      return { kind: "ok", res, rds, subnetId: net.subnetId };
    } catch (e) {
      const f = relayFailure(e, { rdsIdentifier: g.identifier }) as Extract<RelayStepOutcome, { kind: "failed" }>;
      return withGcpRelayFix(f, relayErrorFix(f.failureCode, f.detail?.awsCode));
    }
  });
}

/** 중계 공개 IP 를 도착 DB 복제 길에 둔다 (바뀌었으면 옛 IP 는 빠진다). 바뀌었으면 true (apply 가 terraform 을 한 번 더 돌려 Cloud SQL 허용 주소를 맞춘다) */
export function addRelayPeer(j: Job, publicIp: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const tenant = tenantSlug(j.tenantId);
  const before = loadReplNetwork(env, tenant, j.migrationId);
  if (before?.relayIp === publicIp) return false;
  saveReplNetwork(env, tenant, j.migrationId, { platformCidrs: before?.platformCidrs ?? [], appLoginSql: true, relayIp: publicIp });
  return true;
}

/** GCP 도착 끝점 두 줄 (순수). 출발 = 중계 출발 입구(온프레와 같은 줄). 도착 = Cloud SQL 공개 IP(워커, verify-ca) + 중계 사설 IP:5432(RDS 역방향 구독) */
export function gcpEndpointRows(i: {
  tenantId: string; migrationId: string; sourceEnvId: string; rds: RelaySource; db: string; appUser: string;
  publicIp: string; privateIp: string; cloudSql: CloudSqlPeer; out: TfOutputs; existing: readonly ReplicationEndpoint[];
}): [ReplicationEndpoint, ReplicationEndpoint] {
  const id8 = i.migrationId.replace(/-/g, "").slice(0, 8);
  const oldT = i.existing.find((e) => e.side === "target");
  const ca = /-----BEGIN CERTIFICATE-----/.test(i.out.db_server_ca_cert ?? "") && !/PRIVATE KEY/.test(i.out.db_server_ca_cert ?? "") ? i.out.db_server_ca_cert! : null;
  const admin = i.out.db_admin_username;
  if (!admin) throw new RelayError("RELAY_TARGET_DB_UNKNOWN", "terraform 출력에 도착 관리자 계정(db_admin_username)이 없다 (gcp/root 모듈이 옛 판)");
  const target: ReplicationEndpoint = {
    tenantId: i.tenantId, migrationId: i.migrationId, side: "target", label: `cloudsql-tgt-${id8}`, provider: "cloudsql",
    host: i.cloudSql.publicIp, port: PG_PORT, dbname: i.out.db_name || i.db, username: admin, passwordRef: GCP_TARGET_PASSWORD_REF,
    // RDS 는 사설 VPC 라 Cloud SQL 공개 IP 로 바로 못 나간다 → 중계 사설 IP:5432(역방향 입구) → Cloud SQL 공개 IP:5432 (온프레 역방향 터널과 같은 자리)
    peerHost: i.privateIp, peerPort: PG_PORT,
    appRole: i.out.db_username || i.appUser, fenceRoles: oldT?.fenceRoles ?? [], schemaName: oldT?.schemaName ?? null,
    // 워커 → Cloud SQL 은 서버 CA 로 확인 (인증서에 공개 IP 이름이 없어 verify-full 대신 verify-ca). 상대(RDS)가 붙을 때는 require (endpoint.ts peerTlsProblem)
    sslmode: ca ? "verify-ca" : "require", tlsServername: null, caPem: ca,
    relayHost: null, relayKnownHosts: null, relayPort: 22,
  };
  return [relaySourceRow(i), target];
}

/** 도착 앱 로그인 역할을 관리자로 맞춘다 (Cloud SQL API 사용자는 cloudsqlsuperuser 라 울타리가 안 먹음 → app_login_sql). 비밀번호 = 앱 비밀 그릇 값 */
export async function ensureTargetAppLogin(target: ReplicationEndpoint, env: NodeJS.ProcessEnv = process.env): Promise<"created" | "updated" | "privileged"> {
  const appPassword = readTfFacts(target.migrationId, env).db_password;
  if (!appPassword) throw new RelayError("RELAY_TARGET_DB_UNKNOWN", "이전 작업 폴더 db-secret.json 에 앱 비밀번호(db_password)가 없다 (apply 의 비밀 꺼내기 실패)");
  return withClient(endpointFromRecord(target, env), (c) => ensureLoginRole(c, target.appRole, appPassword));
}

export async function saveEndpointRows(tenantId: string, rows: ReplicationEndpoint[]): Promise<void> {
  await withTenant(tenantId, async (tx) => { for (const x of rows) await upsertReplicationEndpoint(tx, x); });
}
