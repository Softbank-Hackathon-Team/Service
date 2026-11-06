// 온프레 출발 → AWS 도착 중계기 (ADR-031 R4, 2026-11-07 보안·온프레 영역 결정).
//   중계기는 도착 AWS 계정에 산다 (gcp-aws 와 같은 자리, 빌리는 역할 = 도착 실행 역할 relay_target).
//   모양(sshd·보안 그룹 규칙·플랫폼 입구 :15432)은 aws-onprem 과 같다. 다른 점은 RDS 가 도착이라는 것 하나:
//     정방향: 온프레 터널 -R → 중계 :5432 ← 도착 RDS 가 구독 (RDS 보안 그룹 나가기 → 중계 사설 IP/32)
//     롤백 창: 온프레 CNPG 가 터널 -L → 중계 → 도착 RDS:5432 를 구독
//     워커: 출발(온프레) = 중계 공개 IP:5432 (역방향 터널), 도착(RDS) = 중계 공개 IP:15432 (입구)
//   플랫폼은 온프레 VM 에 들어가지 않는다: 연결은 전부 온프레 터널 파드가 밖으로 연다 (정방향 AWS → 온프레와 같은 원칙)
// 흐름: apply 의 terraform 앞 = prepareOnpremAwsRelayStep (문: 나가는 IP·마스터 키·플랫폼 대역), terraform 뒤 = provisionOnpremAwsRelayStep (도착 RDS 로 중계기 + 끝점 두 줄)
import { envFor } from "@svc/adapters";
import type { ReplicationEndpoint, TfOutputs } from "@svc/contracts";
import { readTfFacts } from "@svc/replication";
import { replicationEndpointsFor, withTenant } from "@svc/core";
import { withStepRoles, type StepRoles } from "../jobs/_roles.js";
import type { MigrationRow } from "../jobs/_step.js";
import { deriveSshHostKey, deriveSshKeypair, knownHostsLine, MIN_MASTER_KEY_LENGTH } from "../gitops/migration-secrets.js";
import {
  buildRelayPlan, discoverRelayNetwork, discoverRelaySource, platformEgressCidrs, provisionRelay, RelayError, resolveRelayAmi,
  RELAY_SOURCE_PORT, type RelayAwsDeps, type RelaySource,
} from "./aws-relay.js";
import {
  ensureTargetAppLogin, hostKeyFromConsoleOn, readRelayFacts, relayApplies, relayKindOf, saveEndpointRows, RELAY_TARGET_PASSWORD_REF, RELAY_TARGET_USER,
  type RelayFacts, type RelayStepOutcome,
} from "./relay-step.js";
import { rdsIdentifierOfAddress, targetAdminOf } from "./gcp-aws.js";

type Job = { tenantId: string; migrationId: string };
const PG_PORT = 5432;
const DEFAULT_REGION = "ap-northeast-2";
const isIpv4 = (s: string) => /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/.test(s);

export type OnpremAwsRelayGate =
  | { kind: "skip"; reason: string }
  | { kind: "fail"; failureCode: string; reason: string }
  | { kind: "go"; egressIp: string; platformCidrs: string[]; masterKey: string; region: string; db: string; user: string };

/** 순수: 사실 → 문. 실패는 도착 RDS 를 만들기 전에 낸다 */
export function onpremAwsRelayGate(f: RelayFacts, env: NodeJS.ProcessEnv): OnpremAwsRelayGate {
  if (env.ONPREM_FLOOR_VIA_GIT === "0") return { kind: "skip", reason: "not_pull_mode" };
  const no = relayApplies(f, env);
  if (no) return { kind: "skip", reason: no };
  if (relayKindOf(f.sourceProvider, f.targetProvider) !== "onprem-aws") return { kind: "skip", reason: "not_onprem_aws_relay" };
  if (!f.postgres.length) return { kind: "skip", reason: "no_postgres" };
  if (f.postgres.length !== 1) return { kind: "fail", failureCode: "RELAY_SOURCE_DB_UNKNOWN", reason: `명세에 postgres 가 ${f.postgres.length}개다 (중계기·끝점 줄은 이전마다 하나)` };
  // 22 를 세상에 열지 않는다: 온프레(출발) 나가는 IP 를 모르면 만들지 않는다 (aws-onprem relayGate 와 같은 규칙)
  if (!f.onpremEgressIp || !isIpv4(f.onpremEgressIp))
    return { kind: "fail", failureCode: "ONPREM_EGRESS_UNKNOWN",
      reason: "출발 온프레 클러스터의 나가는 공인 IP 를 모른다 (Agent facts 보고에 egressIp 가 없거나 오래됨): 중계기 SSH(22)를 세상에 열지 않으려고 멈췄다. "
        + "고객 서버에서 kubectl -n svc-agent logs deploy/onprem-agent 로 facts 보고를 확인하고 다시 계획·승인한다" };
  const masterKey = env.REPL_SECRET_MASTER_KEY;
  if (!masterKey || masterKey.length < MIN_MASTER_KEY_LENGTH)
    return { kind: "fail", failureCode: "REPL_SECRET_UNRESOLVED", reason: `REPL_SECRET_MASTER_KEY 가 없거나 ${MIN_MASTER_KEY_LENGTH}자보다 짧다: 터널·호스트 키·이전 역할 비밀번호를 파생할 수 없다` };
  let platformCidrs: string[];
  try { platformCidrs = platformEgressCidrs(env.PLATFORM_EGRESS_CIDRS); }
  catch (e) { return { kind: "fail", failureCode: (e as RelayError).code ?? "RELAY_CONFIG_MISSING", reason: (e as Error).message }; }
  const pg = f.postgres[0]!;
  return { kind: "go", egressIp: f.onpremEgressIp, platformCidrs, masterKey, region: f.targetRegion || DEFAULT_REGION, db: pg.db, user: pg.user };
}

export interface OnpremAwsRelayDeps {
  env?: NodeJS.ProcessEnv;
  facts?: RelayFacts;
  borrow?: <T>(fn: (r: Pick<StepRoles, "awsEnv" | "denied" | "signal">) => Promise<T>) => Promise<T>;
  aws?: Partial<Pick<RelayAwsDeps, "exec" | "sleep" | "pollMs" | "pollTries">>;
  existing?: readonly ReplicationEndpoint[];
  save?: (rows: ReplicationEndpoint[]) => Promise<void>;
  appLogin?: (target: ReplicationEndpoint) => Promise<"created" | "updated" | "privileged">;
}

/** apply 의 terraform 앞. 짝이 onprem->aws 가 아니면 null (예전 그대로) */
export async function prepareOnpremAwsRelayStep(j: Job, m: MigrationRow, deps: Pick<OnpremAwsRelayDeps, "env" | "facts"> = {}): Promise<OnpremAwsRelayGate | null> {
  const env = deps.env ?? process.env;
  const facts = deps.facts ?? await withTenant(j.tenantId, (tx) => readRelayFacts(tx, j.tenantId, m, env));
  if (relayKindOf(facts.sourceProvider, facts.targetProvider) !== "onprem-aws") return null;
  return onpremAwsRelayGate(facts, env);
}

/** 끝점 두 줄 (순수). 온프레 출발 줄 = 중계기 칸·이전 역할(svc_migrate, derive:migrate), 도착 RDS 줄 = 입구 :15432 + 진짜 RDS 이름.
 *  배달(deploy)이 채우는 칸(온프레 줄 ca_pem·tls_servername·sslmode·봉인 값, 도착 줄 peer = 온프레 터널 Service)은 같은 중계기면 그대로 둔다 */
export function onpremAwsEndpointRows(i: {
  tenantId: string; migrationId: string; db: string; appUser: string; rds: RelaySource; out: TfOutputs;
  publicIp: string; privateIp: string; knownHosts: string; existing: readonly ReplicationEndpoint[];
}): [ReplicationEndpoint, ReplicationEndpoint] {
  const id8 = i.migrationId.replace(/-/g, "").slice(0, 8);
  const t = targetAdminOf(i.out);
  if (!t.admin) throw new RelayError("RELAY_TARGET_DB_UNKNOWN", "terraform 출력에 도착 RDS 계정(db_username)이 없다 (aws/root 모듈이 옛 판)");
  const oldS = i.existing.find((e) => e.side === "source" && e.provider === "cnpg");
  const oldT = i.existing.find((e) => e.side === "target" && e.provider === "rds");
  const sameRelay = oldS?.relayHost === i.publicIp;
  const source: ReplicationEndpoint = {
    tenantId: i.tenantId, migrationId: i.migrationId, side: "source", label: `onprem-cnpg-src-${id8}`, provider: "cnpg",
    // 워커 → 중계 공개 IP:5432 (역방향 터널) → 온프레 CNPG. 도착 RDS(정방향 구독)는 중계 사설 IP:5432 로 붙는다
    host: i.publicIp, port: PG_PORT, dbname: i.db, username: RELAY_TARGET_USER, passwordRef: RELAY_TARGET_PASSWORD_REF,
    peerHost: i.privateIp, peerPort: PG_PORT,
    appRole: i.appUser, fenceRoles: oldS?.fenceRoles ?? [], schemaName: oldS?.schemaName ?? null,
    sslmode: sameRelay ? oldS?.sslmode ?? "require" : "require",
    tlsServername: sameRelay ? oldS?.tlsServername ?? null : null, caPem: sameRelay ? oldS?.caPem ?? null : null,
    relayHost: i.publicIp, relayKnownHosts: i.knownHosts, relayPort: 22,
  };
  const target: ReplicationEndpoint = {
    tenantId: i.tenantId, migrationId: i.migrationId, side: "target", label: `rds-tgt-${id8}`, provider: "rds",
    // 워커는 사설 RDS 에 직접 못 닿는다 → 중계 입구(공개 IP:15432, TCP 그대로). 진짜 RDS 이름은 tls_servername (온프레 -L 목적지도 이 이름)
    host: i.publicIp, port: RELAY_SOURCE_PORT, dbname: i.out.db_name || i.db,
    username: t.admin, passwordRef: `tf:${t.passwordKey}`,
    // 롤백 창: 온프레 CNPG 가 터널 Service(-L) 로 도착 RDS 를 구독한다 → 배달이 peer = db-tunnel.<ns>.svc:5432 로 채운다 (비어 있을 때만)
    peerHost: oldT?.peerHost ?? null, peerPort: oldT?.peerPort ?? null,
    appRole: t.app ?? i.appUser, fenceRoles: oldT?.fenceRoles ?? [], schemaName: oldT?.schemaName ?? null,
    sslmode: oldT?.sslmode ?? "require", tlsServername: i.rds.endpoint, caPem: oldT?.caPem ?? null,
    relayHost: null, relayKnownHosts: null, relayPort: 22,
  };
  return [source, target];
}

function failure(e: unknown, extra: Record<string, unknown> = {}): Extract<RelayStepOutcome, { kind: "failed" }> {
  if (!(e instanceof RelayError)) throw e;
  const tag = "만든 자원은 태그(managed-by=platform, svc:migration=<이전>)를 단 채 도착 계정에 남는다. 원인을 고친 뒤 다시 계획·승인하면 태그로 찾아 이어 간다. 취소하면 repl-cleanup 이 태그로 지운다";
  return { kind: "failed", failureCode: e.code, reason: e.message, detail: { ...extra, ...(e.awsCode ? { awsCode: e.awsCode } : {}), hint: tag } };
}

/** terraform 뒤: 도착 계정에 중계기(이미 있으면 그대로) + 도착 RDS 보안 그룹 규칙 둘 + 끝점 두 줄 + (관리자 ≠ 앱이면) 도착 앱 로그인 역할. 다시 불러도 된다 */
export async function provisionOnpremAwsRelayStep(j: Job, m: MigrationRow, g: Extract<OnpremAwsRelayGate, { kind: "go" }>, out: TfOutputs,
  deps: Omit<OnpremAwsRelayDeps, "facts"> = {}): Promise<RelayStepOutcome> {
  const env = deps.env ?? process.env;
  const identifier = rdsIdentifierOfAddress(out.db_address);
  if (!identifier) return { kind: "failed", failureCode: "RELAY_TARGET_DB_UNKNOWN", reason: "terraform 출력에 도착 RDS 주소(db_address)가 없거나 RDS 엔드포인트 모양이 아니다",
    detail: { missing: ["terraform output: db_address"], hint: "명세에 postgres 가 하나인지 확인한 뒤 다시 계획한다" } };
  const t = targetAdminOf(out);
  const keys = [...new Set([t.passwordKey, ...(t.admin !== t.app ? ["db_password" as const] : [])])];
  const tf = readTfFacts(j.migrationId, env);
  const noSecret = keys.filter((k) => !tf[k]);
  if (noSecret.length)
    return { kind: "failed", failureCode: "RELAY_TARGET_DB_UNKNOWN", reason: `이전 작업 폴더 db-secret.json 에 도착 DB 비밀번호(${noSecret.join("·")})가 없다 (apply 의 비밀 꺼내기 실패)`,
      detail: { missing: noSecret.map((k) => `db-secret.json: ${k}`) } };
  const borrow = deps.borrow ?? (<T>(fn: (r: StepRoles) => Promise<T>) => withStepRoles("relay_target", j, m, fn));
  return borrow(async (roles): Promise<RelayStepOutcome> => {
    const cred = roles.awsEnv?.target;
    if (!cred) return { kind: "failed", failureCode: "RELAY_ROLE_DENIED", reason: roles.denied.length
      ? `도착 실행 역할(중계기 세션 정책)을 못 빌렸다: ${roles.denied.map((x) => x.code).join(",")} (도착 svc-operate 에 중계기 정책 relay 가 있는지)`
      : "도착 실행 역할 자격이 없다 (도착 환경이 AWS 인지, 연결이 끝났는지)" };
    const d: RelayAwsDeps = { env: envFor(cred, env), region: g.region, ...(roles.signal ? { signal: roles.signal } : {}), ...deps.aws };
    let rds: RelaySource, subnetId: string, res: Awaited<ReturnType<typeof provisionRelay>>;
    try {
      rds = await discoverRelaySource(d, identifier);
      if (rds.endpoint !== out.db_address) throw new RelayError("RELAY_TARGET_DB_UNKNOWN", `도착 RDS ${identifier} 의 엔드포인트가 terraform 출력과 다르다`);
      const [net, ami] = await Promise.all([discoverRelayNetwork(d, rds.vpcId), resolveRelayAmi(d)]);
      subnetId = net.subnetId;
      res = await provisionRelay(d, buildRelayPlan({ kind: "onprem-aws", migrationId: j.migrationId, rds, network: net, ami,
        platformEgressCidrs: g.platformCidrs, onpremEgressIp: g.egressIp,
        tunnelPublicKey: deriveSshKeypair(g.masterKey, j.tenantId, j.migrationId).publicKeyLine,
        hostKey: hostKeyFromConsoleOn(env) ? null : deriveSshHostKey(g.masterKey, j.tenantId, j.migrationId) }));
    } catch (e) { return failure(e, { rdsIdentifier: identifier }); }
    const hostPub = res.hostPublicKey ?? deriveSshHostKey(g.masterKey, j.tenantId, j.migrationId).publicKeyLine;
    const existing = deps.existing ?? await withTenant(j.tenantId, (tx) => replicationEndpointsFor(tx, j.migrationId));
    let rows: [ReplicationEndpoint, ReplicationEndpoint];
    try {
      rows = onpremAwsEndpointRows({ tenantId: j.tenantId, migrationId: j.migrationId, db: g.db, appUser: g.user, rds, out,
        publicIp: res.publicIp, privateIp: res.privateIp, knownHosts: knownHostsLine(res.publicIp, hostPub), existing });
    } catch (e) { return failure(e); }
    await (deps.save ?? ((r) => saveEndpointRows(j.tenantId, r)))(rows);
    // 관리자와 앱 계정이 나뉜 도착(db_admin_username)이면 앱 로그인 역할을 맞춘다 (gcp-aws 와 같음)
    let appLogin: string = "same_as_admin";
    if (t.admin !== t.app) {
      try { appLogin = await (deps.appLogin ?? ensureTargetAppLogin)(rows[1]); }
      catch (e) {
        return { kind: "failed", failureCode: "TARGET_APP_LOGIN_FAILED", reason: `도착 앱 로그인 역할을 못 맞췄다: ${((e as Error)?.message ?? String(e)).slice(0, 300)}`,
          detail: { missing: ["워커 → 중계 공개 IP:15432 → 도착 RDS:5432"] } };
      }
    }
    return { kind: "ok", detail: { kind: "onprem-aws", instanceId: res.instanceId, securityGroupId: res.securityGroupId, publicIp: res.publicIp, privateIp: res.privateIp, subnetId,
      rdsIdentifier: rds.identifier, rdsSecurityGroupId: rds.securityGroupIds[0], dbIngressRuleId: res.dbIngressRuleId, dbEgressRuleId: res.dbEgressRuleId,
      created: res.created, reused: res.reused, region: g.region, entryPort: RELAY_SOURCE_PORT, hostKeyFromConsole: !!res.hostPublicKey,
      appLogin, endpointRows: ["source", "target"] } };
  });
}
