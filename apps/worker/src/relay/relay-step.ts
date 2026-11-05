// 이전 흐름에 중계기 넣기: apply(자원 생성)가 출발 AWS 계정에 중계기를 만들고 복제 끝점 두 줄을 채운다.
//   정리(cleanup·롤백 걷기·repl-cleanup)가 복제 걷기와 gitops 정리 커밋(터널 걷음) 뒤에 중계기를 지운다.
// 이 파일은 "언제·누구 자격으로·무엇을 줄에 쓰나"만 정한다. 클라우드 호출은 aws-relay.ts
// 자격: 출발 환경 실행 역할(svc-operate)을 빌리고, 세션 정책은 중계기 동작만 (security STEP_ROLES.relay, policy relay)
// 건너뜀(아무것도 안 함): 도착이 온프레 pull 이 아님 / 출발이 AWS 아님 / 명세에 postgres 없음 / 출발 자격이 흉내(시드 환경·REAL_STS=0) / RELAY_AUTO=0
//   → 로컬 데모·시드 환경은 예전 그대로 (끝점 줄은 사람이 tools/onprem-relay.sh 로 넣는다)
import type { AppSpecV2, ReplicationEndpoint } from "@svc/contracts";
import { envFor, dbIdentityFor, specV2ForPlan } from "@svc/adapters";
import { latestAcceptedSpecV2, replicationEndpointsFor, upsertReplicationEndpoint, withTenant, type Tx } from "@svc/core";
import { deriveSshHostKey, deriveSshKeypair, knownHostsLine, MIN_MASTER_KEY_LENGTH } from "../gitops/migration-secrets.js";
import { withStepRoles, type StepRoles } from "../jobs/_roles.js";
import type { MigrationRow } from "../jobs/_step.js";
import { realStsEnabled } from "../platform.js";
import { latestOnpremEgressIp } from "./onprem-egress.js";
import {
  buildRelayPlan, discoverRelayNetwork, discoverRelaySource, isIpv4, platformEgressCidrs, provisionRelay, RelayError, resolveRelayAmi, teardownRelay,
  PG_PORT, type RelayAwsDeps, type RelayResources, type RelaySource,
} from "./aws-relay.js";

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
  const e = await tx.query<{ id: string; provider: string; region: string | null; external_id: string | null }>(
    `SELECT id, provider, region, external_id FROM environments WHERE id = ANY($1::uuid[])`, [[m.sourceEnvId, m.targetEnvId]]);
  const src = e.rows.find((r) => r.id === m.sourceEnvId), dst = e.rows.find((r) => r.id === m.targetEnvId);
  const row = await latestAcceptedSpecV2(tx, m.id);
  const spec: AppSpecV2 | null = row ? specV2ForPlan(row) : null;
  const postgres = (spec?.components ?? []).flatMap((c) => c.kind === "postgres" ? [{ id: c.id, ...pick(dbIdentityFor(spec!, c)) }] : []);
  let rdsIdentifier: string | null = null;
  if (row && postgres.length === 1) {
    const ids = (await tx.query<{ ids: Record<string, unknown> | null }>(
      `SELECT to_jsonb(s)->'spec_v2'->'ids' AS ids FROM spec_versions s WHERE s.migration_id = $1 AND s.version = $2`, [m.id, row.version])).rows[0]?.ids;
    rdsIdentifier = rdsIdentifierFromIds(ids, postgres[0]!.id);
  }
  const egress = dst?.provider === "onprem" ? await latestOnpremEgressIp(tx, tenantId, m.targetEnvId, env) : undefined;
  return { sourceProvider: src?.provider ?? null, sourceRegion: src?.region ?? null, sourceExternalId: src?.external_id ?? null,
           targetProvider: dst?.provider ?? null, postgres, rdsIdentifier, onpremEgressIp: egress?.ip ?? null,
           existing: await replicationEndpointsFor(tx, m.id) };
}
const pick = (x: { db: string; user: string }) => ({ db: x.db, user: x.user });

/** 중계기를 다룰 이전인가 (만들기·지우기 공통). 아니면 건너뛸 이유 */
export function relayApplies(f: Pick<RelayFacts, "sourceProvider" | "sourceExternalId" | "targetProvider">, env: NodeJS.ProcessEnv): string | null {
  if (f.targetProvider !== "onprem") return "target_not_onprem";
  if (f.sourceProvider !== "aws") return "source_not_aws";
  // DRAFT(ai): RELAY_AUTO=0 = 운영자가 중계기를 직접 다룬다 (tools/onprem-relay.sh). 기본 켬
  if (env.RELAY_AUTO === "0") return "relay_auto_off";
  // 흉내 자격(시드 환경 = external_id 없음, 또는 REAL_STS=0)으로는 고객 계정을 못 부른다 (platform.ts awsIssuer·perEnvAwsIssuer 와 같은 기준)
  if (!realStsEnabled(env) || !f.sourceExternalId) return "source_creds_mock";
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

/** 끝점 두 줄 (순수). 배달(deploy)이 채우는 칸(도착 ca_pem·tls_servername·sslmode, 출발 peer)은 같은 중계기면 그대로 둔다 */
export function relayEndpointRows(i: {
  tenantId: string; migrationId: string; rds: RelaySource; db: string; appUser: string;
  publicIp: string; privateIp: string; knownHosts: string; existing: readonly ReplicationEndpoint[];
}): [ReplicationEndpoint, ReplicationEndpoint] {
  const id8 = i.migrationId.replace(/-/g, "").slice(0, 8);
  const oldS = i.existing.find((e) => e.side === "source"), oldT = i.existing.find((e) => e.side === "target");
  const sameRelay = oldT?.relayHost === i.publicIp;
  const source: ReplicationEndpoint = {
    tenantId: i.tenantId, migrationId: i.migrationId, side: "source", label: `rds-src-${id8}`, provider: "rds",
    host: i.rds.endpoint, port: i.rds.port, dbname: i.db,
    // 마스터 사용자 (RDS 에서 복제 슬롯·발행을 만들 권한). 못 읽었으면 앱 계정
    username: i.rds.masterUsername ?? i.appUser,
    // TODO(human): 운영에서는 RDS 가 관리하는 마스터 비밀(rds!…, RelaySource.masterSecretArn)을 빌린 역할로 풀어야 한다
    //   (새 password_ref 문법·secretsmanager:GetSecretValue 권한·워커 메모리에만 두기를 사람이 정한다). 지금은 예전과 같은 env: 참조이고,
    //   값은 운영자가 워커 env REPL_SECRET_SRC_<id8> 에 넣는다 (tools/onprem-relay.sh register 와 같은 이름). 운영자가 바꾼 참조는 그대로 둔다
    passwordRef: oldS?.passwordRef ?? `env:REPL_SECRET_SRC_${id8.toUpperCase()}`,
    peerHost: oldS?.peerHost ?? null, peerPort: oldS?.peerPort ?? null,
    appRole: i.appUser, fenceRoles: oldS?.fenceRoles ?? [], schemaName: oldS?.schemaName ?? null,
    sslmode: oldS?.sslmode ?? "require", tlsServername: oldS?.tlsServername ?? null, caPem: oldS?.caPem ?? null,
    relayHost: null, relayKnownHosts: null, relayPort: 22,
  };
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
      const plan = buildRelayPlan({ migrationId: j.migrationId, rds, network: net, ami, platformEgressCidrs: g.platformCidrs, onpremEgressIp: g.egressIp,
        tunnelPublicKey: deriveSshKeypair(g.masterKey, j.tenantId, j.migrationId).publicKeyLine,
        hostKey: deriveSshHostKey(g.masterKey, j.tenantId, j.migrationId) });
      res = await provisionRelay(d, plan);
    } catch (e) { return relayFailure(e, { rdsIdentifier: g.identifier }); }
    const knownHosts = knownHostsLine(res.publicIp, deriveSshHostKey(g.masterKey, j.tenantId, j.migrationId).publicKeyLine);
    const rows = relayEndpointRows({ tenantId: j.tenantId, migrationId: j.migrationId, rds, db: g.db, appUser: g.user,
      publicIp: res.publicIp, privateIp: res.privateIp, knownHosts, existing: facts.existing });
    await (deps.save ?? ((r) => withTenant(j.tenantId, async (tx) => { for (const x of r) await upsertReplicationEndpoint(tx, x); })))(rows);
    // 감사 detail: 번호·주소만 (키·비밀번호 없음). 자원의 진실은 태그다 (이 detail 은 사람이 찾기 쉽게)
    return { kind: "ok", detail: { instanceId: res.instanceId, securityGroupId: res.securityGroupId, dbEgressRuleId: res.dbEgressRuleId,
      publicIp: res.publicIp, privateIp: res.privateIp, subnetId, rdsIdentifier: rds.identifier, rdsSecurityGroupId: rds.securityGroupIds[0],
      created: res.created, reused: res.reused, region: g.region, endpointRows: ["source", "target"] } };
  });
}

/** 정리: 이 이전 태그가 달린 중계기 자원을 지운다 (RDS 나가기 규칙 → EC2 → 보안 그룹). 던지지 않는다 (실패는 failed 로) */
export async function teardownRelayStep(j: Job, m: Pick<MigrationRow, "id" | "sourceEnvId" | "targetEnvId">, deps: RelayStepDeps = {}): Promise<RelayStepOutcome> {
  const env = deps.env ?? process.env;
  try {
    const facts = deps.facts ?? await withTenant(j.tenantId, (tx) => readRelayFacts(tx, j.tenantId, m, env));
    const no = relayApplies(facts, env) ?? (facts.postgres.length ? null : "no_postgres");
    if (no) return { kind: "skipped", reason: no };
    const borrow = deps.borrow ?? (<T>(fn: (r: StepRoles) => Promise<T>) => withStepRoles("relay", j, m as MigrationRow, fn));
    return await borrow(async (roles) => {
      const cred = roles.awsEnv?.source;
      if (!cred) return roles.denied.length
        ? { kind: "failed", failureCode: "RELAY_TEARDOWN_FAILED", reason: `출발 실행 역할(중계기 세션 정책)을 못 빌려 중계기를 못 지웠다: ${roles.denied.map((x) => x.code).join(",")}` }
        : { kind: "skipped", reason: "source_creds_mock" };
      const d: RelayAwsDeps = { env: envFor(cred, env), region: facts.sourceRegion || DEFAULT_REGION, ...(roles.signal ? { signal: roles.signal } : {}), ...deps.aws };
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
