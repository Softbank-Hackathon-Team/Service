import { prometheusMetrics, stubMetrics, switcherFromEnv, type MetricsSource, type TrafficSwitcher } from "@svc/traffic";
import { awsCliSts, awsStsIssuer, createTempRoleBroker, gcpCliIssuer, GcpIssueError, perEnvGcpIssuer, loadPermissionSet, mockIssuer, perEnvAwsIssuer, type PermissionSet, type ProviderIssuer, type TempRoleBroker } from "@svc/security";
import { fileURLToPath } from "node:url";
import { pgLedger } from "./temp-cred-ledger.js";
import { withTenant, writeAudit, scrubString, trafficTargetFor } from "@svc/core";
import { envNumber, type TrafficTarget } from "@svc/contracts";

// 워커 프로세스 하나에 하나씩 두는 외부 연결 (트래픽 전환기, 지표, 임시 역할 중개자)
// DRAFT(ai): 기본은 전부 가짜(mock/stub). 환경변수가 있으면 진짜로 바뀐다. 비밀값은 환경변수 이름만 읽는다

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

export function trafficMetrics(tenantId: string, sourceBaselineRps?: number): MetricsSource {
  // DRAFT(ai): PROM_URL 이 없으면 가짜 정상 지표. TRAFFIC_STUB_SCENARIO=err|slow|down 으로 롤백 데모
  if (process.env.PROM_URL) return prometheusMetrics({ baseUrl: process.env.PROM_URL, tenantId, baselineP95Ms: envNumber(process.env.TRAFFIC_BASELINE_P95_MS, 200), ...(sourceBaselineRps ? { sourceBaselineRps } : {}) });
  const sc = (process.env.TRAFFIC_STUB_SCENARIO ?? "clean") as "clean" | "err" | "slow" | "down";
  return stubMetrics(sc, { failAt: envNumber(process.env.TRAFFIC_STUB_FAIL_AT, 50) });
}

// DRAFT(ai): 판정 간격. 진짜 지표(PROM_URL)면 1000ms(창 하나 = 1초), 가짜 지표면 20ms (smoke·통합 시험이 36초씩 걸리지 않게)
// 부를 때마다 읽는다 (시험이 before()에서 환경변수를 바꿔도 먹게)
export const trafficTickMs = () => envNumber(process.env.TRAFFIC_TICK_MS, process.env.PROM_URL ? 1000 : 20);
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
export interface EnvRoleRow { provider: string; account_id: string | null; external_id: string | null; gcp_target_project?: string | null }
export function roleRefFor(e: EnvRoleRow | undefined, envId: string, purpose: "observe" | "operate"): { roleRef: string; externalId?: string } {
  const role = `svc-${purpose}`;
  // 결정 3번 A안: GCP 실행 역할(svc-operate, plan 단계는 발급기가 svc-plan 으로 바꿈)은 이전 전용 프로젝트에만 있다. 관찰은 원래 프로젝트(account_id)
  //   DRAFT(ai): 전용 프로젝트가 비면 예전처럼 account_id (옛 환경). 새 연결 스크립트로 붙은 고객이면 거기엔 svc-operate 가 없어 ROLE_NOT_FOUND
  const gcpOperate = e?.provider === "gcp" && purpose === "operate" && e.gcp_target_project;
  const acct = (gcpOperate ? e.gcp_target_project : e?.account_id) || (e?.provider === "aws" ? "000000000000" : "stub");
  const roleRef = e?.provider === "gcp" ? `${role}@${acct}.iam.gserviceaccount.com`
    : e?.provider === "onprem" ? `agent://${envId}/${role}`
    : e?.provider === "azure_mock" ? `azure-mock://${acct}/${role}`
    : `arn:aws:iam::${acct}:role/${role}`;
  return { roleRef, ...(e?.external_id ? { externalId: e.external_id } : {}) };
}
async function resolveEnv(tenantId: string, envId: string, purpose: "observe" | "operate") {
  const e = await withTenant(tenantId, async (tx) => (await tx.query(
    `SELECT provider, account_id, external_id, gcp_target_project FROM environments WHERE id = $1`, [envId])).rows[0]) as EnvRoleRow | undefined;
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
