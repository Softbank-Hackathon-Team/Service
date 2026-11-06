import { prometheusMetrics, stubMetrics, switcherFromEnv, type MetricsSource, type TrafficProvider, type TrafficSwitcher } from "@svc/traffic";
import { iacMockEnabled } from "@svc/adapters";
import { awsCliSts, awsStsIssuer, createTempRoleBroker, gcpCliIssuer, GcpIssueError, perEnvGcpIssuer, loadPermissionSet, mockIssuer, perEnvAwsIssuer, type PermissionSet, type ProviderIssuer, type TempRoleBroker } from "@svc/security";
import { fileURLToPath } from "node:url";
import { pgLedger } from "./temp-cred-ledger.js";
import { withTenant, writeAudit, scrubString, trafficTargetFor } from "@svc/core";
import { awsRoleName, envNumber, type TrafficTarget } from "@svc/contracts";

// 워커 프로세스 하나에 하나씩 두는 외부 연결 (트래픽 전환기, 지표, 임시 역할 중개자)
// 트래픽은 환경변수가 있으면 진짜, 없으면 흉내를 허락한 판(trafficStubAllowed)에서만 가짜. 비밀값은 환경변수 이름만 읽는다

let sw: TrafficSwitcher | null = null;
export function trafficSwitcher(): TrafficSwitcher {
  // STUB: 진짜 Cloudflare 토큰 공급자(비밀 저장소)는 계정 세팅 뒤. 지금은 CLOUDFLARE_API_TOKEN 환경변수에서 읽는다 (예전 이름 CF_API_TOKEN 도 받음)
  sw ??= switcherFromEnv(process.env, { tokens: () => async () => workerCfToken(process.env) });
  return sw;
}

// pf-d FM-TRF-18: 워커는 LB 가중치 PATCH·GET 만 한다 → 그 권한만 가진 토큰(Zone · Load Balancers: Edit)을 따로 받는다.
//   CLOUDFLARE_WORKER_API_TOKEN 이 있으면 그것, 없으면 예전처럼 CLOUDFLARE_API_TOKEN(cf-check 와 같은 토큰, 풀·모니터 권한까지 있음)
export function workerCfToken(env: Record<string, string | undefined>): string {
  const t = env.CLOUDFLARE_WORKER_API_TOKEN || env.CLOUDFLARE_API_TOKEN || env.CF_API_TOKEN;
  if (!t) throw new Error("CLOUDFLARE_WORKER_API_TOKEN (또는 CLOUDFLARE_API_TOKEN) 이 없다");
  return t;
}

// PF TRF-21: 이 이전의 LB 자리와 전환기. DB(0041 migration_traffic_targets)에 줄이 있으면 그 값, 없으면 예전처럼 .env (TRAFFIC_LB_ID…)
//   → 이전마다 .env 4줄을 고치고 워커를 다시 띄우지 않아도 된다. 토큰은 여전히 워커 환경(비밀값은 DB 에 안 둔다)
const byTarget = new Map<string, TrafficSwitcher>();
export interface TrafficFor { lbId: string; switcher: TrafficSwitcher; from: "db" | "env" }
export async function trafficFor(tenantId: string, migrationId: string): Promise<TrafficFor> {
  const t = await withTenant(tenantId, (tx) => trafficTargetFor(tx, migrationId));
  if (!t) return { lbId: TRAFFIC_LB_ID ?? migrationId, switcher: trafficSwitcher(), from: "env" };
  const key = JSON.stringify(t);
  let s = byTarget.get(key);
  if (!s) { s = switcherFromEnv(trafficEnvFor(t, process.env), { tokens: () => async () => workerCfToken(process.env) }); byTarget.set(key, s); }
  return { lbId: t.lbId, switcher: s, from: "db" };
}
/** DB 의 LB 자리를 switcherFromEnv 가 읽는 이름으로 덮는다 (없는 칸은 워커 env 그대로) */
export function trafficEnvFor(t: TrafficTarget, env: Record<string, string | undefined>): Record<string, string | undefined> {
  return { ...env, TRAFFIC_PROVIDER: t.provider, TRAFFIC_LB_ID: t.lbId,
    ...(t.sourcePoolId ? { CLOUDFLARE_SOURCE_POOL_ID: t.sourcePoolId } : {}),
    ...(t.targetPoolId ? { CLOUDFLARE_TARGET_POOL_ID: t.targetPoolId } : {}),
    ...(t.zoneId ? { CLOUDFLARE_ZONE_ID: t.zoneId } : {}) };
}

// DRAFT(ai): 가짜 지표·mock 전환기를 써도 되는 판. 도착을 흉내로 만든 판(MOCK_IAC=1)은 옮길 진짜 트래픽이 없고, MOCK_TRAFFIC=1 은 진짜 도착에 흉내 트래픽.
//   MOCK_IAC 는 시험 전용 스위치(contracts TEST_ONLY_SWITCHES)라 DEMO_MODE=1 이면 서비스가 안 뜬다. MOCK_TRAFFIC 은 그 목록에 없어 DEMO_MODE=1 에서도 켜진다.
//   진짜 판에서 설정이 빠지면 shift 가 TRAFFIC_NOT_CONFIGURED 로 멈춘다
export const trafficStubAllowed = (env: NodeJS.ProcessEnv = process.env) => iacMockEnabled(env) || env.MOCK_TRAFFIC?.trim() === "1";

// 이 이전의 LB 자리가 어디서 왔고(DB 등록·워커 env) 어떤 전환기인가. 판정 지표를 이전마다 고르는 데 쓴다
export interface TrafficTargetKind { from: TrafficFor["from"]; provider: TrafficProvider | undefined }
const ENV_MOCK: TrafficTargetKind = { from: "env", provider: "mock" };
const realLb = (t: TrafficTargetKind) => !!t.provider && t.provider !== "mock";
/** cf-check --register 로 이 이전에만 진짜 LB 를 등록했다 (DB 줄 + mock 아닌 전환기) */
export const registeredRealLb = (t: TrafficTargetKind) => t.from === "db" && realLb(t);

export type TrafficMetricsKind = "prometheus" | "stub" | "none";
/** 이 이전을 무엇으로 판정하나 (none = 지표 없음).
 *  진짜 판(흉내 불허): 예전 그대로 PROM_URL 이면 Prometheus, 없으면 none.
 *  흉내 판(MOCK_TRAFFIC·MOCK_IAC): 진짜 LB 를 옮기는 이전만 PROM_URL 이 있을 때 Prometheus. mock 전환기 이전은 PROM_URL 이 있어도 가짜 지표
 *    (mock LB 는 트래픽을 안 옮겨 실측 몫이 안 맞는다). 등록한 진짜 LB 이전인데 PROM_URL 이 없으면 none (가짜 숫자로 진짜 LB 를 판정하지 않는다).
 *  DRAFT(ai): 공유 흉내 판에 PROM_URL 을 넣어도 등록한 이전 하나만 진짜 지표로 돌고 나머지는 예전처럼 흉내. 워커 env 의 진짜 전환기(TRAFFIC_PROVIDER)는 예전 규칙 그대로 */
export function trafficMetricsKind(t: TrafficTargetKind = ENV_MOCK, env: NodeJS.ProcessEnv = process.env): TrafficMetricsKind {
  if (!trafficStubAllowed(env)) return env.PROM_URL ? "prometheus" : "none";
  if (realLb(t) && env.PROM_URL) return "prometheus";
  return registeredRealLb(t) ? "none" : "stub";
}

export type TrafficConfigName = "PROM_URL" | "TRAFFIC_PROVIDER";
export const TRAFFIC_CONFIG_HINT: Record<TrafficConfigName, string> = {
  PROM_URL: "판정용 Prometheus 주소 (차트 trafficMetrics.promUrl)",
  TRAFFIC_PROVIDER: "npm run cf:check -- --register=<이전> --tenant=<회사> 로 이 이전의 LB 를 등록하거나 워커 TRAFFIC_PROVIDER·TRAFFIC_LB_ID·CLOUDFLARE_*_POOL_ID",
};
/** 이 shift 에 비어 있는 설정. 빈 배열이면 진행. 진짜 판은 PROM_URL·LB 전환기, 흉내 판은 등록한 진짜 LB 이전의 PROM_URL 만 */
export function missingTrafficConfig(provider: TrafficProvider | undefined, env: NodeJS.ProcessEnv = process.env, from: TrafficFor["from"] = "env"): TrafficConfigName[] {
  if (trafficStubAllowed(env)) return trafficMetricsKind({ from, provider }, env) === "none" ? ["PROM_URL"] : [];
  return [...(env.PROM_URL ? [] : ["PROM_URL" as const]), ...(provider === "mock" ? ["TRAFFIC_PROVIDER" as const] : [])];
}

/** 판정 지표 (trafficMetricsKind). Prometheus, 가짜(TRAFFIC_STUB_SCENARIO clean|err|slow|down), 아니면 없음. target 이 없으면 워커 env 의 mock 전환기로 본다 */
export function trafficMetrics(tenantId: string, o: { sourceBaselineRps?: number; windowSec?: number; target?: TrafficTargetKind } = {},
  env: NodeJS.ProcessEnv = process.env): MetricsSource | undefined {
  const kind = trafficMetricsKind(o.target, env);
  if (kind === "prometheus") return prometheusMetrics({ baseUrl: env.PROM_URL!, tenantId, baselineP95Ms: envNumber(env.TRAFFIC_BASELINE_P95_MS, 200),
    ...(o.sourceBaselineRps ? { sourceBaselineRps: o.sourceBaselineRps } : {}), ...(o.windowSec ? { windowSec: o.windowSec } : {}) });
  if (kind === "none") return undefined;
  const sc = (env.TRAFFIC_STUB_SCENARIO ?? "clean") as "clean" | "err" | "slow" | "down";
  return stubMetrics(sc, { failAt: envNumber(env.TRAFFIC_STUB_FAIL_AT, 50) });
}

// DRAFT(ai): 판정 간격. 진짜 지표면 1000ms(창 하나 = 1초), 가짜 지표면 20ms (smoke·통합 시험이 36초씩 걸리지 않게).
//   이전마다 고른 지표(kind)를 따른다. kind 가 없으면 예전처럼 PROM_URL 유무로. 부를 때마다 읽는다 (시험이 before()에서 환경변수를 바꿔도 먹게)
export const trafficTickMs = (kind?: TrafficMetricsKind, env: NodeJS.ProcessEnv = process.env) =>
  envNumber(env.TRAFFIC_TICK_MS, (kind ? kind === "prometheus" : !!env.PROM_URL) ? 1000 : 20);
// TODO(human) FM-TRF-14: LB·풀 ID 가 워커 하나에 하나(환경 변수) → 다른 회사·환경 이전 둘이 동시에 shift 하면 같은 LB 가중치를 바꾼다.
//   이전마다 LB 를 따로 만들지(계획 승인 때 G6-7 입구 선택과 같이), 한 LB 를 잠금으로 나눌지는 사람이 정한다. 데모는 이전 1개
export const TRAFFIC_LB_ID = process.env.TRAFFIC_LB_ID;   // 없으면 이전 번호를 LB 이름으로 (mock 전용)

let broker: TempRoleBroker | null = null;

// 최소 권한 파일 (어댑터 export-permissions 가 만든 infra/permissions). 못 읽으면 null → 실행 역할은 전부 거부된다 (T-ROLE-6)
// DRAFT(ai): 경로는 PERMISSIONS_DIR, 없으면 레포의 infra/permissions
export function permissionSet(): PermissionSet | null {
  const dir = process.env.PERMISSIONS_DIR ?? fileURLToPath(new URL("../../../infra/permissions/", import.meta.url));
  try { return loadPermissionSet(dir); }
  catch (e) { console.error(`최소 권한 파일을 못 읽음 (${dir}): 실행 역할 발급이 거부된다`, scrubString((e as Error).message)); return null; }
}

// 환경 → 고객 역할 참조 (Z39). environments 의 provider·account_id·external_id 로 만든다. 값이 아니라 이름이다
// DRAFT(ai): 역할 이름 규칙 svc-<observe|operate> (stubRoleIssuer 와 같음). 계정 번호가 비면 0 으로 채운 가짜
// 한 AWS 계정에 환경 여럿 (0056): AWS 는 이름 끝에 환경 꼬리 aws_role_suffix (연결 템플릿 RoleSuffix). NULL = 옛 환경 = 예전 이름 그대로
export interface EnvRoleRow { provider: string; account_id: string | null; external_id: string | null; gcp_target_project?: string | null; aws_role_suffix?: string | null }
export function roleRefFor(e: EnvRoleRow | undefined, envId: string, purpose: "observe" | "operate"): { roleRef: string; externalId?: string } {
  const role = `svc-${purpose}`;
  // 결정 3번 A안: GCP 실행 역할(svc-operate, plan 단계는 발급기가 svc-plan 으로 바꿈)은 이전 전용 프로젝트에만 있다. 관찰은 원래 프로젝트(account_id)
  //   DRAFT(ai): 전용 프로젝트가 비면 예전처럼 account_id (옛 환경). 새 연결 스크립트로 붙은 고객이면 거기엔 svc-operate 가 없어 ROLE_NOT_FOUND
  const gcpOperate = e?.provider === "gcp" && purpose === "operate" && e.gcp_target_project;
  const acct = (gcpOperate ? e.gcp_target_project : e?.account_id) || (e?.provider === "aws" ? "000000000000" : "stub");
  const roleRef = e?.provider === "gcp" ? `${role}@${acct}.iam.gserviceaccount.com`
    : e?.provider === "onprem" ? `agent://${envId}/${role}`
    : e?.provider === "azure_mock" ? `azure-mock://${acct}/${role}`
    : `arn:aws:iam::${acct}:role/${awsRoleName(role, e?.aws_role_suffix)}`;
  return { roleRef, ...(e?.external_id ? { externalId: e.external_id } : {}) };
}
async function resolveEnv(tenantId: string, envId: string, purpose: "observe" | "operate") {
  const e = await withTenant(tenantId, async (tx) => (await tx.query(
    `SELECT provider, account_id, external_id, gcp_target_project, aws_role_suffix FROM environments WHERE id = $1`, [envId])).rows[0]) as EnvRoleRow | undefined;
  return roleRefFor(e, envId, purpose);
}

// L4: 진짜 발급기 스위치. "mock 없이"가 기본: REAL_STS 가 비었거나 없으면 켜짐(aws sts assume-role CLI, gcloud impersonate).
//   끄기는 REAL_STS=0 으로만 (로컬 개발·시험이 명시적으로 끈다: package.json test·test:db, .env.example). 흉내 발급기는 꺼졌을 때만 쓴다
// MOCK_CREDS 는 읽는 코드가 없어 기준으로 쓰지 않는다. 시험 전용이 아니라 운영 스위치라 TEST_ONLY_SWITCHES 에 넣지 않는다
export const realStsEnabled = (env: NodeJS.ProcessEnv = process.env) => env.REAL_STS?.trim() !== "0";
// #241: 실환경 모드(진짜 발급기)에서 AWS·GCP 환경이 흉내 자격을 받았다 = 연결 링크를 안 거친 환경(시드 등). 그대로 CLI 를 부르면 워커 자기 권한으로 플랫폼 계정을 읽는다.
//   고객 자원을 읽는 작업은 이 값이 참이면 읽지 말고 멈춘다. 로컬·시험(REAL_STS=0)과 온프레·azure_mock(늘 흉내 발급기)은 해당 없음
export const MOCK_CREDENTIALS = "MOCK_CREDENTIALS";
export const refuseMockCredentials = (cred: { stub: boolean }, provider: string, env: NodeJS.ProcessEnv = process.env) =>
  cred.stub && realStsEnabled(env) && (provider === "aws" || provider === "gcp");
export function awsIssuer(env: NodeJS.ProcessEnv = process.env): ProviderIssuer {
  return realStsEnabled(env) ? perEnvAwsIssuer(awsStsIssuer({ sts: awsCliSts() }), mockIssuer("aws")) : mockIssuer("aws");
}

// L7i: GCP 진짜 발급기. 켜짐(기본) + GCP_PLATFORM_PROJECT 로 gcloud impersonate. 플랫폼 SA 는 회사 번호로 DB 에서만 읽는다
export async function gcpPlatformSa(tenantId: string): Promise<string | undefined> {
  return withTenant(tenantId, async (tx) => (await tx.query(`SELECT gcp_platform_sa FROM tenants WHERE id = $1`, [tenantId])).rows[0]?.gcp_platform_sa);
}
// DRAFT(ai): 켜졌는데 GCP_PLATFORM_PROJECT 가 없으면 흉내로 조용히 넘어가지 않고 진짜 고객 SA 발급은 PLATFORM_SA_MISSING 으로 실패시킨다.
//   시드 환경(프로젝트 "stub" 등 고객 SA 모양 아님)은 AWS external_id 없는 시드와 같게 흉내로 (perEnvGcpIssuer)
export function gcpIssuer(env: NodeJS.ProcessEnv = process.env): ProviderIssuer {
  if (!realStsEnabled(env)) return mockIssuer("gcp");
  const project = env.GCP_PLATFORM_PROJECT?.trim();
  const real: ProviderIssuer = project
    ? gcpCliIssuer({ platformSa: gcpPlatformSa, platformProject: project })
    : { mock: false,
        issue: async () => { throw new GcpIssueError("PLATFORM_SA_MISSING", "GCP_PLATFORM_PROJECT 설정 없음"); },
        revoke: async () => ({ hardRevoked: false, detail: { method: "drop_and_expire" } }) };
  return perEnvGcpIssuer(real, mockIssuer("gcp"));
}

export function tempRoles(): TempRoleBroker {
  // AWS·GCP 는 기본 진짜(REAL_STS=0 일 때만 흉내). 시드 환경(external_id 없음·고객 SA 모양 아님)은 흉내.
  // STUB: 온프레 발급기는 mock (온프레 연결은 Agent 키·하트비트로 확인, 빌린 자격 없음). azure_mock 은 설계상 흉내만
  // TODO(human): environments 표에 고객 역할 ARN·ExternalId 칸이 생기면 resolveEnv 를 DB 읽기로 바꾼다 (T-ROLE-2)
  const permissions = permissionSet();
  broker ??= createTempRoleBroker({
    issuers: { aws: awsIssuer(), gcp: gcpIssuer(), onprem: mockIssuer("onprem"), azure_mock: mockIssuer("azure_mock") },
    ...(permissions ? { permissions } : {}),
    ledger: pgLedger(),   // 회수 증거는 DB 장부로 센다 (워커 여러 대, T-ROLE-8)
    resolveEnv,
    audit: (tenantId, a) => withTenant(tenantId, (tx) => writeAudit(tx, tenantId, a)),
    // 시험·데모: CRED_RENEW_STUB_FAIL=1 이면 Mock 재발급 실패 → 단계 paused (APPLY_STUB_FAIL 과 같은 방식, Z61)
    renewFault: () => process.env.CRED_RENEW_STUB_FAIL === "1",
  });
  return broker;
}

// 만료 지우기 + 다른 워커가 남긴 회수 요청 처리. DRAFT(ai): 15초마다 (실행 역할 15분 대비 충분히 짧게)
export function startTempRoleSweeper(everyMs = envNumber(process.env.TEMP_ROLE_SWEEP_MS, 15000)) {
  const t = setInterval(() => { tempRoles().sweep().catch((e) => console.error("temp role sweep", scrubString((e as Error).message))); }, everyMs);
  t.unref();
  return t;
}
