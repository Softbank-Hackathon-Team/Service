import { randomUUID } from "node:crypto";
import { AgentReport, envNumber, MigrationJob, PrecheckItem, QUEUES, SourceDbFacts, type AppSpecV2, type Provider } from "@svc/contracts";
import { latestAcceptedSpecV2, replicationEndpointsFor, withTenant, type Tx } from "@svc/core";
import { iacMockEnabled, terraformRuntimeOf, specV2ForPlan, envFor, gcpEnvFor, v2PrecheckItems, runCloudPrecheck, toPrecheckItems, spawnExec, resolveSpecV2, targetFactsV2, sourceFactsV2, sourceDbsV2, appEnvV2, workloadSecurityV2,
  type AgentFacts, type EnvSide, type PrecheckEnvInfo, type PrecheckInput, type PrecheckDeps, type CloudProvider } from "@svc/adapters";
import { evaluatePortabilityV2, PORTABILITY_RULES, toSecurityPrecheckItems } from "@svc/security";
import { endpointFromEnv, precheckSource, resolveTfRefs, withClient } from "@svc/replication";
import { runStep } from "./_step.js";
import { appLinkMeans } from "../app-link.js";
import { specHasPostgres } from "./_repl.js";
import { withStepRoles, type StepRoles } from "./_roles.js";
import type { MigrationRow } from "./_step.js";
import { TARGET_ACCOUNT_SQL } from "./target-account.js";
import { agentStaleSec } from "./verify-connection.js";
import { relayApplies, relayKindOf } from "../relay/relay-step.js";
import { gcpAwsRelayPrecheck } from "../relay/gcp-aws.js";
import { chooseEnvLayerSource, readInventoryFacts, type InventoryFacts } from "../env-layer.js";
import { permissionPrecheck } from "../permission-gate.js";

// 사전 점검: 이전해도 되는지 본다. block(FAIL)이 하나라도 있으면 명세 검토로 되돌린다
// Z97: STUB(고정 "확인됨")을 실조회로 바꿨다 — 자격(STS·tokeninfo·kubectl)·도착 API·결제·할당량·DB 버전·TCP·디스크.
//   규칙·명령은 @svc/adapters precheck/cloud-precheck.ts 한 곳. 흉내는 MOCK_PRECHECK=1 (시험 전용)일 때만

/** 시험 고정값 (계획서 시험 등에서 쓰는 모양 견본). 실제 단계는 쓰지 않는다 */
export function stubPrecheck(): PrecheckItem[] {
  return [
    { id: "PC-CRED-S", level: "info", message: "PASS 출발 자격 증명 — MOCK_PRECHECK=1 — 시험용 흉내 (실조회 안 함)" },
    { id: "PC-CRED-T", level: "info", message: "PASS 도착 자격 증명 — MOCK_PRECHECK=1 — 시험용 흉내 (실조회 안 함)" },
  ].map((i) => PrecheckItem.parse(i));
}

// 온프레 pull 모드 도착: 살아 있는 키 수 + 마지막 하트비트 나이(초) + 그 하트비트의 k3s 버전. 판정 기준은 연결 확인(verify-connection)과 같다
//   폐기된 키로 온 하트비트는 세지 않는다
export async function onpremAgentInfo(tx: Tx, envId: string, env: NodeJS.ProcessEnv = process.env): Promise<NonNullable<PrecheckEnvInfo["agent"]>> {
  const q = await tx.query<{ keys: number; age: number | null; k3s: string | null }>(
    `SELECT (SELECT count(*)::int FROM agent_keys WHERE env_id = $1 AND revoked_at IS NULL) AS keys, h.age, h.k3s
       FROM (SELECT 1) one LEFT JOIN LATERAL (
         SELECT GREATEST(0, floor(extract(epoch FROM now() - r.received_at)))::int AS age, r.body->>'k3sVersion' AS k3s
           FROM agent_reports r JOIN agent_keys k ON k.id = r.key_id AND k.revoked_at IS NULL
          WHERE r.env_id = $1 AND r.kind = 'heartbeat' ORDER BY r.received_at DESC LIMIT 1) h ON true`, [envId]);
  const r = q.rows[0];
  return { keys: r?.keys ?? 0, lastHeartbeatAgeSec: r?.age ?? null, staleSec: agentStaleSec(env), k3sVersion: r?.k3s ?? null };
}

async function envInfo(tenantId: string, m: MigrationRow, env: NodeJS.ProcessEnv = process.env): Promise<{ source: PrecheckEnvInfo; target: PrecheckEnvInfo }> {
  return withTenant(tenantId, async (tx) => {
    const q = await tx.query(`SELECT id, provider, name, account_id, ${TARGET_ACCOUNT_SQL} AS target_account_id, external_id, aws_role_suffix FROM environments WHERE id = ANY($1::uuid[])`, [[m.sourceEnvId, m.targetEnvId]]);
    const by = new Map(q.rows.map((r) => [r.id as string, r]));
    const one = (id: string, side: "source" | "target"): PrecheckEnvInfo => {
      const r = by.get(id);
      return { side, provider: (r?.provider ?? "onprem") as CloudProvider, name: r?.name, accountId: (side === "target" ? r?.target_account_id : r?.account_id) ?? null, externalId: r?.external_id ?? null,
        awsRoleSuffix: r?.aws_role_suffix ?? null };
    };
    const target = one(m.targetEnvId, "target");
    // pull 모드(ONPREM_FLOOR_VIA_GIT≠0, apply.ts 와 같은 기준)면 워커가 고객 클러스터에 kubectl 로 못 붙는다 → Agent 하트비트로 점검
    //   출발 온프레는 그대로 (가져오기가 kubectl 로 읽는 경로라 점검도 같은 길을 본다)
    if (target.provider === "onprem" && env.ONPREM_FLOOR_VIA_GIT !== "0") target.agent = await onpremAgentInfo(tx, m.targetEnvId, env);
    return { source: one(m.sourceEnvId, "source"), target };
  });
}

/** 출발 DB 버전·크기·주소. REPL_SOURCE_URL 이 없으면 모름(null) → 점검이 WARN 으로 말한다 */
export async function sourceDbFacts(env: NodeJS.ProcessEnv = process.env): Promise<Pick<PrecheckInput, "sourcePgMajor" | "sourceDbBytes" | "endpoints">> {
  const endpoints: NonNullable<PrecheckInput["endpoints"]> = [];
  for (const [p, name] of [["REPL_SOURCE", "출발 DB"], ["REPL_TARGET", "도착 DB"]] as const) {
    const url = env[`${p}_URL`];
    if (!url) continue;
    try { const u = new URL(url); endpoints.push({ name, host: u.hostname, port: Number(u.port || 5432) }); } catch { /* 주소 모양이 틀리면 TCP 대상에서 뺀다 */ }
  }
  if (!env.REPL_SOURCE_URL) return { sourcePgMajor: null, sourceDbBytes: null, endpoints };
  try {
    const r = await withClient(endpointFromEnv("REPL_SOURCE", env), async (c) =>
      (await c.query(`SELECT current_setting('server_version_num')::int AS v, pg_database_size(current_database())::bigint AS b`)).rows[0]);
    const v = Number(r.v);
    return { sourcePgMajor: v >= 100000 ? Math.floor(v / 10000) : v / 10000, sourceDbBytes: Number(r.b), endpoints };
  } catch { return { sourcePgMajor: null, sourceDbBytes: null, endpoints }; }
}

// L5c: 빌린 관찰 자격(진짜 발급기일 때만 있음) → 쪽마다 CLI env. 워커 자기 자격(AWS_PROFILE·키)은 지운다
// RV-27: GCP 도 빌린 관찰 토큰이 있으면 그쪽 gcloud 를 그 토큰·그 프로젝트로 (gcpEnvFor 가 워커 자기 gcloud 자격 이름을 지움)
export function precheckSideEnv(roles: Pick<StepRoles, "awsEnv" | "gcpToken"> | undefined, env: NodeJS.ProcessEnv,
  projects: Partial<Record<"source" | "target", string | null>> = {}): PrecheckDeps["sideEnv"] {
  const out: NonNullable<PrecheckDeps["sideEnv"]> = {};
  for (const side of ["source", "target"] as const) {
    const e = roles?.awsEnv?.[side]; if (e) out[side] = envFor(e, env);
    const t = roles?.gcpToken?.[side], p = projects[side];
    if (t && p) out[side] = gcpEnvFor(t, p, env);
  }
  return Object.keys(out).length ? out : undefined;
}

export async function realPrecheck(tenantId: string, m: MigrationRow, deps: Partial<PrecheckDeps> = {}, roles?: Pick<StepRoles, "awsEnv" | "gcpToken">): Promise<PrecheckItem[]> {
  // PF-E2: sync 와 같이 {tf:키}(REPL_FACTS_FILES·이전 폴더)를 채운 값으로 본다. 예전엔 글자 그대로라 출발 DB 를 늘 "모름"으로 봤다
  const env = resolveTfRefs(deps.env ?? process.env, m.id);
  // PF RV-28: 진짜 판(MOCK_IAC≠1)이고 명세에 postgres 가 있으면 출발 복제 점검을 못 본 채(주소 없음·접속 실패) 통과시키지 않는다 (RV-23 sync 와 같은 기준)
  const required = !iacMockEnabled(env) && (await specHasPostgres(tenantId, m.id).catch(() => null)) === true;
  const envs = await envInfo(tenantId, m, env);
  // 중계기가 끝점을 만들 이전인가 (apply 의 중계기 문과 같은 앞 조건: relayApplies + 온프레면 pull 모드)
  const relayFacts = { sourceProvider: envs.source.provider, sourceExternalId: envs.source.externalId ?? null, targetProvider: envs.target.provider,
                       targetExternalId: envs.target.externalId ?? null };
  const relayDeferred = relayApplies(relayFacts, env) === null
    && (relayKindOf(relayFacts.sourceProvider, relayFacts.targetProvider) !== "aws-onprem" || env.ONPREM_FLOOR_VIA_GIT !== "0");
  // 이 이전의 끝점 줄이 있으면 sync 는 env 가 아니라 그 줄로 붙는다 (_repl.ts) → env 주소로 출발 DB 를 보지 않는다
  const endpointRows = (await withTenant(tenantId, (tx) => replicationEndpointsFor(tx, m.id))).some((r) => r.tenantId === tenantId);
  const [db, repl, runtime] = await Promise.all([sourceDbFacts(endpointRows ? {} : env), replSourcePrecheck(env, { required, relayDeferred, endpointRows }), specRuntime(tenantId, m.id)]);
  const gp = (e: PrecheckEnvInfo) => (e.provider === "gcp" ? e.accountId : null);   // 8nr2 RV-27: GCP 점검은 빌린 관찰 토큰·도착 프로젝트로
  const sideEnv = deps.sideEnv ?? precheckSideEnv(roles, env, { source: gp(envs.source), target: gp(envs.target) });
  const checks = await runCloudPrecheck({ ...envs, ...db }, { exec: spawnExec, ...deps, env, ...(sideEnv ? { sideEnv } : {}) });
  const link = appLinkPrecheck(env, { terraformRuntime: runtime, targetProvider: envs.target.provider });
  // AWS 도착 사실(VPC·서브넷)과 GCP → AWS 중계기 길을 승인 전에 본다 (apply 의 TARGET_FACTS_UNAVAILABLE·중계기 멈춤을 앞당김)
  const tf = envs.target.provider === "aws" && !iacMockEnabled(env) ? await awsTargetFactsPrecheck(tenantId, m.targetEnvId, env) : { items: [], vpcId: null };
  const relay = relayKindOf(envs.source.provider, envs.target.provider) === "gcp-aws"
    ? (await gcpAwsRelayPrecheck({ tenantId, migrationId: m.id }, m, roles, env, { targetVpcId: tf.vpcId })).map((i) => PrecheckItem.parse(i)) : [];
  return [...toPrecheckItems(checks).map((i) => PrecheckItem.parse(i)), ...repl, ...link, ...tf.items, ...relay];
}

/** AWS 도착: worker env TF_FACT_* 가 없으면 apply 는 실자원 읽기가 둔 도착 EKS 사실(VPC·서브넷)을 쓴다 (env-layer.ts). 아직 안 읽었거나 못 쓰면
 *  apply 가 TARGET_FACTS_UNAVAILABLE 로 멈추므로 승인 전에 막는다. vpcId = 중계기 NAT 점검에 넘길 도착 VPC (모르면 null) */
export async function awsTargetFactsPrecheck(tenantId: string, targetEnvId: string, env: NodeJS.ProcessEnv,
  inventory?: (tenantId: string, envId: string) => Promise<InventoryFacts>): Promise<{ items: PrecheckItem[]; vpcId: string | null }> {
  if (chooseEnvLayerSource("aws", null, env) !== "inventory") return { items: [], vpcId: env.TF_FACT_VPC_ID || null };
  const f = await (inventory ?? ((t, e) => withTenant(t, (tx) => readInventoryFacts(tx, e))))(tenantId, targetEnvId);
  if (f.ok) return { items: [], vpcId: f.facts.vpcId ?? null };
  return { vpcId: null, items: [PrecheckItem.parse({ id: "PC-AWS-TARGET-FACTS", level: "block",
    message: `FAIL 도착 EKS 의 VPC·서브넷을 아직 못 쓴다: ${f.reason} — 빠진 것: inventory.targetFacts`.slice(0, 1000),
    fix: "도착 환경 화면을 한 번 열어 관찰 역할로 도착 EKS 를 읽게 한 뒤(연결 스택이 옛 판이면 새 템플릿으로 업데이트해 ec2:DescribeSubnets 를 더함) 다시 점검한다. 또는 worker-env 에 TF_FACT_VPC_ID·TF_FACT_DB_SUBNET_IDS_JSON" })] };
}

async function specRuntime(tenantId: string, migrationId: string): Promise<boolean> {
  return withTenant(tenantId, async (tx) => {
    const row = await latestAcceptedSpecV2(tx, migrationId);
    return !!terraformRuntimeOf(row ? specV2ForPlan(row) : null);
  }).catch(() => false);
}

const LOOPBACK = /^(localhost|127\.\d+\.\d+\.\d+|::1|\[::1\]|0\.0\.0\.0|host\.docker\.internal)$/i;
/** APP-22 (가) DECISION(team, 11/4 01:57Z Jeong 결정): 컷오버 전까지 도착 앱은 출발 DB 에 붙고, 컷오버 때 도착 DB 로 바꾼다.
 *  자원을 만들기 전에 두 가지를 본다 (복제가 있는 이전 = REPL_SOURCE_URL, APP_LINK=0 이 아닐 때):
 *   - PC-APPLINK-PATH: 도착 앱이 출발 DB 에 닿을 경로. SOURCE_DB_LINK=real(출발 RDS 에 도착 egress 만 여는 경로를 이전이 만듦) 또는
 *     APP_LINK_SOURCE_URL(미리 마련한 경로 주소). 둘 다 없거나, 주소가 {tf:} 미해결·루프백(도착 클라우드에서 못 닿음)이면 block
 *   Terraform 실행 방식(ECS·Cloud Run·VM)은 apply 가 출발 경로로 앱을 띄우고 컷오버·롤백이 db_writer_json 을 바꿔 다시 apply 한다 (db-writer.ts).
 *   그래서 손으로 준 경로(APP_LINK_SOURCE_URL)엔 출발 전용 계정·비밀번호·DB 이름까지 있어야 한다 (도착 비밀 그릇에 넣을 값)
 *  도착 앱을 이 워커가 올리지 않는 경우(GitOps 꺼짐·Terraform 실행 방식 아님)는 경로가 쓰일 일이 없어 안 본다 (배포 단계가 GITOPS_NOT_CONFIGURED 로 멈추거나 앱이 없음) */
export function appLinkPrecheck(env: NodeJS.ProcessEnv, o: { terraformRuntime: boolean; targetProvider: CloudProvider }): PrecheckItem[] {
  const means = appLinkMeans(env);
  if (!env.REPL_SOURCE_URL || !means.on) return [];
  if (!means.gitops && !means.proxy && !o.terraformRuntime) return [];
  const out: PrecheckItem[] = [];
  const explicit = (env.APP_LINK_SOURCE_URL ?? "").trim();
  const linkReal = env.SOURCE_DB_LINK === "real";
  if (!explicit && !linkReal) {
    out.push(PrecheckItem.parse({ id: "PC-APPLINK-PATH", level: "block",
      message: "FAIL 도착 앱이 컷오버 전까지 출발 DB 에 붙을 경로가 없다 (SOURCE_DB_LINK=real 아님, APP_LINK_SOURCE_URL 없음)",
      fix: "출발 DB 에 도착 egress 만 여는 경로를 이전이 만들게 SOURCE_DB_LINK=real, 또는 미리 마련한 경로 주소를 APP_LINK_SOURCE_URL=postgres://<host>:<port> 로" }));
    return out;
  }
  if (explicit) {
    let host = "";
    try { host = new URL(explicit).hostname; } catch { /* 아래에서 FAIL */ }
    const bad = explicit.includes("{tf:") ? "{tf:} 값이 안 채워짐"
      : !host ? "주소 모양이 틀림"
      : o.targetProvider !== "onprem" && LOOPBACK.test(host) ? `루프백 주소 ${host} 는 도착(${o.targetProvider})에서 출발에 못 닿음`
      : o.terraformRuntime && !/^[a-z]+:\/\/[^:/@]+:[^@]+@[^/]+\/[^/?]+/i.test(explicit) ? "Terraform 실행 방식 도착은 계정·비밀번호·DB 이름이 있어야 함 (postgres://<계정>:<비밀번호>@<host>:<port>/<db>)" : null;
    if (bad) out.push(PrecheckItem.parse({ id: "PC-APPLINK-PATH", level: "block",
      message: `FAIL 도착 앱 → 출발 DB 경로 주소(APP_LINK_SOURCE_URL)를 쓸 수 없다: ${bad}`,
      fix: "도착 망에서 닿는 출발 DB 주소(사설 경로·중계기·공개+TLS)를 APP_LINK_SOURCE_URL 로" }));
  }
  return out;
}

/** PF-E1: 출발 DB 가 논리 복제를 받을 수 있나(wal_level·rds.logical_replication·슬롯·권한·기본키·대형 객체)를 자원 만들기 전에 본다.
 *  sync 첫 점검과 같은 규칙(@svc/replication precheckSource). 실패면 block → 명세 검토로 (apply·배포 30분 뒤 SYNC_FAILED 대신).
 *  REPL_SOURCE_URL 이 없으면 아무것도 안 낸다(복제 없는 STUB 길). 못 붙으면 warn (TCP 점검이 이유를 따로 낸다) */
export async function replSourcePrecheck(env: NodeJS.ProcessEnv = process.env,
  o: { required?: boolean; relayDeferred?: boolean; endpointRows?: boolean } = {}): Promise<PrecheckItem[]> {
  // DECISION(team) 끝점은 이전마다 DB 행으로 (2026-11-05): 줄이 있으면 sync 는 env 가 아니라 그 줄로 붙는다. 여기서 env 로 보면
  //   다른 DB 를 보거나(env 있음) "REPL_SOURCE_URL 없음" 으로 거짓 block 이다(env 없음) → 같은 규칙(precheckSource)은 sync 첫 점검이 그 줄로 본다.
  //   TODO(human): 줄의 출발 주소로 여기서 바로 볼지 (aws-sm 관리 비밀은 출발 실행 역할을 빌려야 풀린다)
  if (o.endpointRows) return o.required ? [PrecheckItem.parse({ id: "PC-REPL-ROWS", level: "warn",
    message: "출발 DB 논리 복제 점검을 미룸: 이 이전은 복제 끝점 줄(replication_endpoints)로 붙는데, 사전 점검은 워커 env 주소만 읽는다",
    fix: "sync 첫 점검이 같은 규칙(rds.logical_replication·슬롯·권한·기본키)을 끝점 줄의 주소로 본다. 줄 확인은 npm run repl:endpoint -- show" })] : [];
  // DRAFT(ai): AWS 출발 중계기 이전(→온프레·→GCP, relay-step RELAY_ROUTES)은 출발 끝점 줄을 apply 의 중계기 단계가 만든다 (relay/relay-step.ts).
  //   사전 점검 때는 출발 주소가 아직 없는 것이 정상이라 막지 않고 warn 으로 남긴다. 같은 규칙(precheckSource)은 sync 첫 점검이 그 줄로 다시 본다.
  //   대가: 출발 DB 설정이 틀리면 중계기를 만든 뒤 sync 에서 SYNC_FAILED 로 멈춘다 (트래픽은 아직 출발에 있다)
  if (!env.REPL_SOURCE_URL && o.required && o.relayDeferred) return [PrecheckItem.parse({ id: "PC-REPL-RELAY", level: "warn",
    message: "출발 DB 논리 복제 점검을 미룸: 중계기 이전(AWS→온프레·AWS→GCP·GCP→AWS)은 자원 생성(apply)이 중계기를 만들고 복제 끝점을 그때 채운다",
    fix: "sync 첫 점검이 같은 규칙(rds.logical_replication·cloudsql.logical_decoding·슬롯·권한·기본키)을 중계기 경로로 본다. GCP→AWS 는 출발 Cloud SQL 길을 PC-RELAY-SQL-* 가 따로 본다" })];
  // 중계기 짝이 아니고 끝점 줄도 REPL_* env 도 없으면 sync 가 REPL_ENDPOINT_MISSING 으로 멈춘다 → 승인 전에 막고 빠진 것을 이름으로 알린다
  if (!env.REPL_SOURCE_URL) return o.required ? [PrecheckItem.parse({ id: "PC-REPL-CONN", level: "block",
    message: "FAIL 명세에 postgres 가 있는데 복제 끝점을 만들 중계기가 없고(이 짝에 중계기 없음·흉내 자격·RELAY_AUTO=0) 끝점도 없어 논리 복제 준비를 못 봄 — 이대로면 sync 에서 멈춘다. "
      + "빠진 것: replication_endpoints(source), replication_endpoints(target) (또는 워커 env REPL_SOURCE_URL·REPL_TARGET_URL)",
    fix: "운영자가 npm run repl:endpoint -- set 으로 이 이전의 출발·도착 끝점 두 줄을 넣거나, 도착 DB 를 공개 길로 만드는 DB_PUBLIC=1 + DB_PEER_CIDRS 와 함께 워커 env 에 REPL_SOURCE_URL·REPL_TARGET_URL ({tf:} 가능)을 준다" })] : [];
  const tables = env.REPL_TABLES?.split(",").map((s) => s.trim()).filter(Boolean);
  try {
    const r = await precheckSource(endpointFromEnv("REPL_SOURCE", env), tables?.length ? { tables } : {});
    return r.checks.filter((c) => !c.ok).map((c) => PrecheckItem.parse({
      id: `PC-REPL-${c.id}`, level: c.level === "warn" ? "warn" : "block",
      message: `출발 DB 논리 복제 점검 ${c.id}: ${c.detail}`.slice(0, 500), ...(c.hint ? { fix: c.hint } : {}) }));
  } catch (e) {
    return [PrecheckItem.parse({ id: "PC-REPL-CONN", level: o.required ? "block" : "warn",
      message: `출발 DB 에 붙어 논리 복제 설정을 못 봄: ${(e as Error).message}`.slice(0, 300), fix: "REPL_SOURCE_URL·네트워크·TLS 확인 (sync 첫 점검에서 다시 본다)" })];
  }
}

// TA3 (설계 27번 3.6): 명세를 도착 capability 와 대조한다. 못 그리는 칸·사람 확인 → block (명세 검토로 되돌림)
export async function v2PrecheckFor(tenantId: string, m: MigrationRow, _env: NodeJS.ProcessEnv = process.env): Promise<PrecheckItem[]> {
  return withTenant(tenantId, async (tx) => {
    const row = await latestAcceptedSpecV2(tx, m.id);
    const e = await tx.query(`SELECT provider FROM environments WHERE id=$1`, [m.targetEnvId]);
    if (!row || !e.rows[0]) return [];   // 명세·도착이 없으면 계획 단계 재확인이 막는다
    // SG-1: IR 워크로드 보안(privileged·root·호스트 공유가 출발 그대로 도착에 감)은 SEC_PRECHECK 와 상관없이 승인 줄로.
    //   위험한 설정이 있을 때만 줄이 생긴다. 이 규칙들은 환경 사실을 안 읽어 출발 쪽은 도착과 같은 제공자로 채운다
    const spec = resolveSpecV2(row);
    const t: EnvSide = { envId: m.targetEnvId, provider: e.rows[0].provider as Provider, region: null };
    const wl = spec.ok ? securityPrecheckItems({ spec: spec.spec, source: { ...t, envId: m.sourceEnvId }, target: t, rules: "workload" }) : [];
    return [...v2PrecheckItems(e.rows[0].provider, row), ...wl];
  });
}

// 보안 판정 연결: 명세의 보안 요구사항 + 출발 사실(가져오기가 읽은 securityFacts) + 도착 사실(모듈 고정값)을 맞대어
//   막기(block → 명세 검토로 되돌림)·경고(warn → 계획서 승인 항목 precheck_warn:SEC:…)·참고(info)를 낸다. 순수 함수
// SG-1: rules = 돌릴 규칙 묶음 (기본 전부). workload = IR 컨테이너 보안 규칙(P-WL-*)만, nonWorkload = 그 밖
// W5: targetAgentFacts = 온프레 도착 Agent 의 최근 facts 보고 (있으면 잰 값이 고정값·모름을 덮는다)
export function securityPrecheckItems(i: { spec: AppSpecV2; securityFacts?: Record<string, SourceDbFacts>; source: EnvSide; target: EnvSide; targetAgentFacts?: AgentFacts; rules?: "all" | "workload" | "nonWorkload" }): PrecheckItem[] {
  const pick = i.rules ?? "all";
  const t = targetFactsV2(i.target, i.spec, i.targetAgentFacts);
  const r = evaluatePortabilityV2({
    requirements: i.spec.security?.requirements ?? null,
    source: sourceFactsV2(i.source, i.spec, i.securityFacts), sourceDbs: sourceDbsV2(i.spec, i.securityFacts),
    target: t.env, targetDbs: t.dbs, appEnv: appEnvV2(i.spec), workloads: workloadSecurityV2(i.spec),
  }, pick === "all" ? PORTABILITY_RULES : PORTABILITY_RULES.filter((x) => (x.scope === "workload") === (pick === "workload")));
  return toSecurityPrecheckItems(r).map((x) => PrecheckItem.parse(x));
}

// SEC_PRECHECK=1 일 때만. 꺼져 있으면 지금 점검 그대로. 명세를 못 쓰면 [] (v2PrecheckFor·계획 단계가 막는다)
// DRAFT(ai): 기본 꺼짐. 켜면 요구사항 없음(P-REQ-0)·도착 로그인 방식 모름·출발 확장 모름 경고가 모든 계획서의 승인 항목이 되므로 보안 시연 환경에서만 켠다
export const secPrecheckOn = (env: NodeJS.ProcessEnv = process.env) => env.SEC_PRECHECK === "1";

// W5: 그 환경 Agent 의 가장 최근 facts 보고. AGENT_FACTS_MAX_AGE_SEC(기본 900초 = loop 기본 주기 300초의 3배)보다 오래되면 안 쓴다
//   (오래된 측정을 지금 사실처럼 쓰지 않는다 → 모름·고정값 그대로). 모양이 틀린 본문도 안 쓴다
// DRAFT(ai): 900초
export async function latestAgentFacts(tx: Tx, envId: string, env: NodeJS.ProcessEnv = process.env): Promise<AgentFacts | undefined> {
  const maxAge = envNumber(env.AGENT_FACTS_MAX_AGE_SEC, 900);
  if (!Number.isFinite(maxAge) || maxAge <= 0) return undefined;
  const r = await tx.query(
    `SELECT body FROM agent_reports WHERE env_id = $1 AND kind = 'facts' AND received_at > now() - make_interval(secs => $2)
       ORDER BY received_at DESC LIMIT 1`, [envId, maxAge]);
  const p = AgentReport.safeParse(r.rows[0]?.body);
  return p.success && p.data.kind === "facts" ? p.data : undefined;
}
export async function securityPrecheckFor(tenantId: string, m: MigrationRow, env: NodeJS.ProcessEnv = process.env): Promise<PrecheckItem[]> {
  if (!secPrecheckOn(env)) return [];
  return withTenant(tenantId, async (tx) => {
    const row = await latestAcceptedSpecV2(tx, m.id);
    const spec = row ? resolveSpecV2(row) : null;
    if (!row || !spec?.ok) return [];
    // 출발 사실은 같은 판의 spec_v2.securityFacts (spec 밖이라 사람 PATCH 로 안 바뀜). 모양이 틀리거나 없으면 모름
    const f = await tx.query(`SELECT to_jsonb(s)->'spec_v2'->'securityFacts' AS f FROM spec_versions s WHERE s.migration_id = $1 AND s.version = $2`, [m.id, row.version]);
    const raw = f.rows[0]?.f;
    const facts: Record<string, SourceDbFacts> = {};
    if (raw && typeof raw === "object") for (const [id, v] of Object.entries(raw)) { const p = SourceDbFacts.safeParse(v); if (p.success) facts[id] = p.data; }
    const e = await tx.query(`SELECT id, provider, region FROM environments WHERE id = ANY($1::uuid[])`, [[m.sourceEnvId, m.targetEnvId]]);
    const side = (id: string): EnvSide | null => {
      const r = e.rows.find((x) => x.id === id);
      return r ? { envId: id, provider: r.provider as Provider, region: (r.region as string | null) ?? null } : null;
    };
    const source = side(m.sourceEnvId), target = side(m.targetEnvId);
    if (!source || !target) return [];
    const targetAgentFacts = target.provider === "onprem" ? await latestAgentFacts(tx, target.envId, env) : undefined;
    // SG-1: 워크로드 규칙(P-WL-*)은 v2PrecheckFor 가 늘 낸다 → 여기서는 빼서 두 번 안 나오게
    return securityPrecheckItems({ spec: spec.spec, securityFacts: facts, source, target, targetAgentFacts, rules: "nonWorkload" });
  });
}

export async function handlePrecheck(raw: unknown) {
  const job = MigrationJob.parse(raw); // 큐 내용은 믿지 않는다: 모양부터
  return runStep(job, {
    name: "precheck",
    expect: "prechecking",
    work: async (j, m) => withStepRoles("precheck", j, m, async (roles) => {
      // PERM-GATE: 이 이전이 쓰는 고객 권한 묶음이 빠졌으면 block 항목 PC-PERM-<묶음> (새 실패 코드 없음 → 명세 검토로). 빌린 관찰 역할로만 읽는다
      const perm = await permissionPrecheck(j.tenantId, m, roles);
      const items = [...await realPrecheck(j.tenantId, m, {}, roles), ...await v2PrecheckFor(j.tenantId, m), ...await securityPrecheckFor(j.tenantId, m), ...perm.items];
      const precheckBlockers = items.filter((i) => i.level === "block").length;
      const precheckWarnings = items.filter((i) => i.level === "warn").length;
      const mock = process.env.MOCK_PRECHECK === "1";
      if (precheckBlockers > 0)
        return { to: "spec_review", detail: { precheck: items, precheckWarnings, ...(perm.detail ? { permissions: perm.detail } : {}), ...(mock ? { stub: true } : {}) }, evidence: { precheckBlockers } };
      const planId = randomUUID();
      return {
        to: "planning",
        detail: { precheck: items, precheckWarnings, planId, ...(perm.detail ? { permissions: perm.detail } : {}), ...(mock ? { stub: true } : {}) },
        evidence: { precheckBlockers },
        next: { queue: QUEUES.plan,
                // 작업 키는 core jobKey 한 곳(plan:<이전 번호>). 환경 겹침은 env_locks 예약이 막는다 (Z43 F3)
                data: { tenantId: job.tenantId, requestId: job.requestId, migrationId: job.migrationId, planId } },
      };
    }),
  });
}
