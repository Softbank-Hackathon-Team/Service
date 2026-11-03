import { prometheusMetrics, stubMetrics, switcherFromEnv, type MetricsSource, type TrafficSwitcher } from "@svc/traffic";
import { awsCliSts, awsStsIssuer, createTempRoleBroker, gcpCliIssuer, perEnvGcpIssuer, loadPermissionSet, mockIssuer, perEnvAwsIssuer, type PermissionSet, type ProviderIssuer, type TempRoleBroker } from "@svc/security";
import { fileURLToPath } from "node:url";
import { pgLedger } from "./temp-cred-ledger.js";
import { withTenant, writeAudit, scrubString } from "@svc/core";
import { envNumber } from "@svc/contracts";

// 워커 프로세스 하나에 하나씩 두는 외부 연결 (트래픽 전환기, 지표, 임시 역할 중개자)
// DRAFT(ai): 기본은 전부 가짜(mock/stub). 환경변수가 있으면 진짜로 바뀐다. 비밀값은 환경변수 이름만 읽는다

let sw: TrafficSwitcher | null = null;
export function trafficSwitcher(): TrafficSwitcher {
  // STUB: 진짜 Cloudflare 토큰 공급자(비밀 저장소)는 계정 세팅 뒤. 지금은 CLOUDFLARE_API_TOKEN 환경변수에서 읽는다 (예전 이름 CF_API_TOKEN 도 받음)
  sw ??= switcherFromEnv(process.env, { tokens: () => async () => {
    const t = process.env.CLOUDFLARE_API_TOKEN || process.env.CF_API_TOKEN;
    if (!t) throw new Error("CLOUDFLARE_API_TOKEN 이 없다");
    return t;
  } });
  return sw;
}

export function trafficMetrics(): MetricsSource {
  // DRAFT(ai): PROM_URL 이 없으면 가짜 정상 지표. TRAFFIC_STUB_SCENARIO=err|slow|down 으로 롤백 데모
  if (process.env.PROM_URL) return prometheusMetrics({ baseUrl: process.env.PROM_URL, baselineP95Ms: envNumber(process.env.TRAFFIC_BASELINE_P95_MS, 200) });
  const sc = (process.env.TRAFFIC_STUB_SCENARIO ?? "clean") as "clean" | "err" | "slow" | "down";
  return stubMetrics(sc, { failAt: envNumber(process.env.TRAFFIC_STUB_FAIL_AT, 50) });
}

// DRAFT(ai): 판정 간격. 진짜 지표(PROM_URL)면 1000ms(창 하나 = 1초), 가짜 지표면 20ms (smoke·통합 시험이 36초씩 걸리지 않게)
// 부를 때마다 읽는다 (시험이 before()에서 환경변수를 바꿔도 먹게)
export const trafficTickMs = () => envNumber(process.env.TRAFFIC_TICK_MS, process.env.PROM_URL ? 1000 : 20);
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
async function resolveEnv(tenantId: string, envId: string, purpose: "observe" | "operate") {
  const e = await withTenant(tenantId, async (tx) => (await tx.query(
    `SELECT provider, account_id, external_id FROM environments WHERE id = $1`, [envId])).rows[0]) as
    { provider: string; account_id: string | null; external_id: string | null } | undefined;
  const role = `svc-${purpose}`;
  const acct = e?.account_id || (e?.provider === "aws" ? "000000000000" : "stub");
  const roleRef = e?.provider === "gcp" ? `${role}@${acct}.iam.gserviceaccount.com`
    : e?.provider === "onprem" ? `agent://${envId}/${role}`
    : e?.provider === "azure_mock" ? `azure-mock://${acct}/${role}`
    : `arn:aws:iam::${acct}:role/${role}`;
  return { roleRef, ...(e?.external_id ? { externalId: e.external_id } : {}) };
}

// L4: 진짜 AWS 발급기 스위치. REAL_STS=1 일 때만 aws sts assume-role (CLI). 빈 값·0 = 지금처럼 전부 mock
// MOCK_CREDS 는 읽는 코드가 없어 기준으로 쓰지 않는다. 시험 전용이 아니라 운영 스위치라 TEST_ONLY_SWITCHES 에 넣지 않는다
export const realStsEnabled = (env: NodeJS.ProcessEnv = process.env) => env.REAL_STS?.trim() === "1";
// REAL_STS=1 이어도 external_id 없는 환경(시드)은 mock (issuers.ts perEnvAwsIssuer DRAFT(ai))
export function awsIssuer(env: NodeJS.ProcessEnv = process.env): ProviderIssuer {
  return realStsEnabled(env) ? perEnvAwsIssuer(awsStsIssuer({ sts: awsCliSts() }), mockIssuer("aws")) : mockIssuer("aws");
}

// L7i: GCP 진짜 발급기. REAL_STS=1 + GCP_PLATFORM_PROJECT 있을 때만 gcloud impersonate. 플랫폼 SA 는 회사 번호로 DB 에서만 읽는다
export async function gcpPlatformSa(tenantId: string): Promise<string | undefined> {
  return withTenant(tenantId, async (tx) => (await tx.query(`SELECT gcp_platform_sa FROM tenants WHERE id = $1`, [tenantId])).rows[0]?.gcp_platform_sa);
}
export function gcpIssuer(env: NodeJS.ProcessEnv = process.env): ProviderIssuer {
  const project = env.GCP_PLATFORM_PROJECT?.trim();
  return realStsEnabled(env) && project
    ? perEnvGcpIssuer(gcpCliIssuer({ platformSa: gcpPlatformSa, platformProject: project }), mockIssuer("gcp"))
    : mockIssuer("gcp");
}

export function tempRoles(): TempRoleBroker {
  // STUB: GCP·온프레 발급기는 mock. AWS 는 REAL_STS=1 + external_id 있는 환경만 진짜 (L4). GCP 는 WIF 연결 뒤
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
