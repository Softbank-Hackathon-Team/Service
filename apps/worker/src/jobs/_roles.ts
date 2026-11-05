import type { Provider } from "@svc/contracts";
import { withTenant, scrubString } from "@svc/core";
import {
  STEP_ROLES, stepActions, TempRoleDenied, CredRenewFailed, startRenewal, renewIntervalSec, CRED_RENEW_DEFAULT_SEC,
  type RoleStep, type TempCredential,
} from "@svc/security";
import { borrowedAwsCreds, type BorrowedAwsCreds } from "@svc/adapters";
import { permissionSet, tempRoles } from "../platform.js";
import type { MigrationRow } from "./_step.js";
import { envNumber } from "@svc/contracts";

// 작업 단계가 임시 역할을 빌리고, 단계가 끝나면 바로 돌려준다 (작업 Z39).
// 왜 단계마다: 자격 값은 빌린 워커 메모리(보관함)에만 있고, 다음 단계는 다른 워커가 할 수 있다 → 단계 밖으로 못 가져간다.
// 그래서 "빌림 → 일 → 회수"를 한 단계 안에서 끝낸다. 장부(temp_credentials)·감사(temp_role.*)에 발급·회수·만료가 남는다.
//
// L5b·L5c: 진짜 발급기(REAL_STS=1 + external_id)로 빌린 AWS 자격은 apply terraform·precheck CLI 가 쓴다 (awsEnv).
// STUB: 가짜 발급기·GCP·온프레 자격은 아직 안 쓴다 (프로세스 자격). 그래도 발급 검사(최소 권한·세션 정책·TTL)는 진짜로 돈다.
// 거부되면(권한 파일 없음 등) 감사에 temp_role.denied 가 남고 단계는 계속 간다.
// DRAFT(ai): TEMP_ROLE_REQUIRED=1 이면 거부 = 단계 실패(예외). 기본 0 (자격을 아직 안 쓰는 STUB 단계를 거부로 멈추지 않게)
// DRAFT(ai): 요청 수명 = 900초 (실행 역할 상한, AWS STS 최소값과 같음)
export const STEP_ROLE_TTL_SEC = envNumber(process.env.STEP_ROLE_TTL_SEC, 900);
const required = () => process.env.TEMP_ROLE_REQUIRED === "1";
// 재발급 주기 (작업 Z61, Jeong 17:03Z 승인값 "10분 재발급"). 기본 600초. STUB·시험에서는 줄여서 시간을 당긴다 (예 CRED_RENEW_SEC=0.05)
// 수명의 2/3 를 넘지 못한다 (renewIntervalSec). 부를 때마다 읽는다 → 시험이 env 를 바꿔도 먹는다
export const credRenewSec = () => renewIntervalSec(envNumber(process.env.CRED_RENEW_SEC, CRED_RENEW_DEFAULT_SEC), STEP_ROLE_TTL_SEC);

export interface StepRoles {
  creds: TempCredential[];
  denied: { side: string; purpose: string; code: string }[];
  skipped: { side: string; reason: string }[];
  renewals?: number;        // 이 단계 동안 성공한 재발급 횟수 (Z61)
  signal?: AbortSignal;     // 재발급이 실패하면 abort. 진짜 Terraform 실행기는 이걸로 SIGINT 를 보낸다
  sides?: ("source" | "target")[];   // L5b: creds[i] 가 어느 쪽 환경 것인지 (같은 순서)
  // L5b: 진짜 발급기(REAL_STS=1 + external_id)로 빌린 AWS 실행 자격 → terraform 자식 env 에 덮을 값 (파일 경로만, 키 값 없음).
  //   없으면(가짜 발급기·AWS 아님) 지금처럼 프로세스 자격(맥 프로필)으로 돈다
  awsEnv?: Partial<Record<"source" | "target", Record<string, string>>>;
  // RV-27: 진짜 발급기로 빌린 GCP 자격(bearer 토큰). precheck 등 gcloud 읽기가 워커 자기 로그인 대신 쓴다. 재발급되면 같이 바뀜. 메모리에만
  gcpToken?: Partial<Record<"source" | "target", string>>;
}

async function envsOf(tenantId: string, m: MigrationRow) {
  return withTenant(tenantId, async (tx) => {
    const q = await tx.query(`SELECT id, provider, region FROM environments WHERE id = ANY($1::uuid[])`, [[m.sourceEnvId, m.targetEnvId]]);
    return new Map(q.rows.map((r) => [r.id as string, { provider: r.provider as Provider, region: (r.region as string | null) ?? null }]));
  });
}

export async function borrowStepRoles(step: RoleStep, j: { tenantId: string; migrationId: string }, m: MigrationRow): Promise<StepRoles> {
  const out: StepRoles = { creds: [], denied: [], skipped: [], sides: [] };
  const envs = await envsOf(j.tenantId, m);
  const perms = permissionSet();
  const broker = tempRoles();
  for (const r of STEP_ROLES[step]) {
    const envId = r.side === "source" ? m.sourceEnvId : m.targetEnvId;
    const provider = envs.get(envId)?.provider;
    if (!provider) { out.skipped.push({ side: r.side, reason: "env_not_found" }); continue; }
    // Azure 는 Mock 전용이라 실행 역할을 주지 않는다 (ROLE_AZURE_MOCK). 묻지도 않는다 → 거부 감사가 매번 쌓이지 않게
    if (provider === "azure_mock" && r.purpose === "operate") { out.skipped.push({ side: r.side, reason: "azure_mock_no_operate" }); continue; }
    const stage = "stage" in r ? r.stage : undefined;
    const policy = "policy" in r ? r.policy : undefined;
    // 중계기 세션 정책은 AWS 실행 역할에만 있다. 다른 클라우드면 묻지 않는다 (부르는 쪽이 먼저 거르지만 한 번 더)
    if (policy && provider !== "aws") { out.skipped.push({ side: r.side, reason: "relay_policy_aws_only" }); continue; }
    try {
      out.creds.push(await broker.issue({
        // 관찰 역할도 이전 번호를 붙인다 (필수는 아님) → 이 이전의 장부·감사·보안 표에 같이 보인다
        tenantId: j.tenantId, envId, provider, purpose: r.purpose, migrationId: j.migrationId,
        ...(stage ? { stage } : {}), ...(policy ? { policy } : {}),
        actions: "actions" in r ? [...r.actions] : stepActions(perms, provider, r.purpose, stage, policy), ttlSec: STEP_ROLE_TTL_SEC,
      }, { step }));
      out.sides!.push(r.side);
    } catch (e) {
      if (!(e instanceof TempRoleDenied)) throw e;
      out.denied.push({ side: r.side, purpose: r.purpose, code: e.code });
      if (required()) { await returnStepRoles(out, j.tenantId, `${step}_denied`); throw e; }
    }
  }
  return out;
}

// 단계 끝 (성공·실패 모두). 이 워커가 쥔 것만 지운다
export async function returnStepRoles(r: StepRoles, tenantId: string, reason: string) {
  for (const c of r.creds) await tempRoles().revoke(c.credentialRef, tenantId, reason).catch((e) =>
    console.error("temp role revoke", scrubString((e as Error).message)));
}

// 감사 detail 에 남길 요약 (참조·값 없음)
export const rolesDetail = (r: StepRoles) => ({
  issued: r.creds.map((c) => ({ provider: c.provider, purpose: c.purpose, stage: c.stage ?? null, actions: c.actions.length, stub: c.stub })),
  denied: r.denied, skipped: r.skipped, renewals: r.renewals ?? 0,
});

// 빌림 → 일(동안 10분마다 재발급) → 회수. 일이 예외로 끝나도 회수한다.
// 재발급이 실패하면 일을 기다리지 않고 CredRenewFailed 를 던진다 → apply·cleanup 은 paused(CRED_RENEW_FAILED) 로 멈춘다 (onError)
// L5b: 진짜 AWS 자격이면 r.awsEnv[side] 를 terraform 실행기 env 에 덮는다 (apply). STUB: cleanup·rollback 은 아직 destroy 를 안 돌려 안 씀
export async function withStepRoles<T>(step: RoleStep, j: { tenantId: string; migrationId: string }, m: MigrationRow,
  fn: (r: StepRoles) => Promise<T>): Promise<T> {
  const r = await borrowStepRoles(step, j, m);
  let files = new Map<string, BorrowedAwsCreds>();
  try { files = await awsCredFiles(r, j, m); }
  catch (e) { await returnStepRoles(r, j.tenantId, `${step}_done`); throw e; }
  gcpTokens(r, j);
  const h = r.creds.length ? startRenewal({ creds: r.creds, everyMs: credRenewSec() * 1000,
    renew: async (c) => {
      const n = await tempRoles().renew(c.credentialRef, j.tenantId);
      // L5b: 진짜 자격 파일을 새 키로 바꾼다 (terraform 이 Expiration 뒤 다시 읽음). 참조가 바뀌니 표도 옮긴다
      // RV-27: GCP 토큰도 새 것으로 (같은 쪽)
      const i = r.creds.indexOf(c), side = r.sides?.[i];
      if (c.provider === "gcp" && !n.stub && side && r.gcpToken?.[side]) {
        const k = tempRoles().use(n.credentialRef, j.tenantId, j.migrationId);
        if (k.kind === "bearer") r.gcpToken[side] = k.token;
      }
      const f = files.get(c.credentialRef);
      if (f) {
        const k = tempRoles().use(n.credentialRef, j.tenantId, j.migrationId);
        if (k.kind === "aws") f.update(k, new Date(n.expiresAt));
        files.delete(c.credentialRef); files.set(n.credentialRef, f);
      }
      return n;
    } }) : null;
  if (h) r.signal = h.signal;
  try { return await (h ? Promise.race([fn(r), h.failed]) : fn(r)); }
  finally {
    await h?.stop();
    r.renewals = h?.renewals() ?? 0;
    for (const f of files.values()) f.dispose();
    await returnStepRoles(r, j.tenantId, `${step}_done`);
  }
}

// RV-27: 진짜 발급기로 빌린 GCP 자격(stub=false)의 bearer 토큰을 쪽별로 꺼내 둔다 (파일 없음, 메모리만)
function gcpTokens(r: StepRoles, j: { tenantId: string; migrationId: string }) {
  r.creds.forEach((c, i) => {
    const side = r.sides?.[i];
    if (c.provider !== "gcp" || c.stub || !side) return;
    const k = tempRoles().use(c.credentialRef, j.tenantId, j.migrationId);
    if (k.kind === "bearer") (r.gcpToken ??= {})[side] = k.token;
  });
}

// L5b: 진짜 발급기로 빌린 AWS 자격(stub=false)만 임시 credential_process 파일로 만든다. 가짜(stub)는 지금처럼 안 넘긴다
// DRAFT(ai): 환경에 리전이 없으면 서울 (issuers.ts AWS_DEFAULT_REGION 과 같음)
async function awsCredFiles(r: StepRoles, j: { tenantId: string; migrationId: string }, m: MigrationRow) {
  const files = new Map<string, BorrowedAwsCreds>();
  if (!r.creds.some((c) => c.provider === "aws" && !c.stub)) return files;
  try {
    const envs = await envsOf(j.tenantId, m);
    r.creds.forEach((c, i) => {
      const side = r.sides?.[i];
      if (c.provider !== "aws" || c.stub || !side) return;
      const k = tempRoles().use(c.credentialRef, j.tenantId, j.migrationId);
      if (k.kind !== "aws") return;
      const region = envs.get(side === "source" ? m.sourceEnvId : m.targetEnvId)?.region || "ap-northeast-2";
      const f = borrowedAwsCreds(k, new Date(c.expiresAt), { region });
      files.set(c.credentialRef, f);
      (r.awsEnv ??= {})[side] = f.env;
    });
  } catch (e) {
    // 중간에 실패하면 이미 만든 자격 파일을 지운다 (호출부는 이 함수가 던지면 files 를 못 받아 못 지운다)
    for (const f of files.values()) f.dispose();
    throw e;
  }
  return files;
}

// apply 의 onError 가 쓴다 (Z38 REVIEW-4 Z43-1): 재발급 실패면 failed(CRED_RENEW_FAILED), 아니면 null.
//   paused 로 보내면 나가는 길이 롤백뿐인데, 롤백은 Terraform 으로 만들다 만 자원을 지우지 않고 rolled_back(끝 상태)에서 잠금을 푼다
//   → 클라우드에 자원이 남은 채 "끝남"이 된다. failed 는 잠금을 쥔 채 남고, 취소하려면 사람이 "자원 정리했음"(T38)을 확인해야 하며,
//   provisioning 실패라 다시 계획(T37)도 된다 = APPLY_FAILED 와 같은 길
export function failedOnRenewFailure(e: unknown) {
  if (!(e instanceof CredRenewFailed)) return null;
  return { to: "failed" as const, failureCode: "CRED_RENEW_FAILED",
    detail: { credRenew: { reason: e.reason, error: e.message.slice(0, 300) } } };
}

// cleanup 의 onError 가 쓴다: 재발급 실패면 paused, 아니면 null (원래 처리로)
export function pausedOnRenewFailure(e: unknown) {
  if (!(e instanceof CredRenewFailed)) return null;
  return { to: "paused" as const, failureCode: "CRED_RENEW_FAILED",
    detail: { credRenew: { reason: e.reason, error: e.message.slice(0, 300) } } };
}
