import { execFile } from "node:child_process";
import type { IssueContext, ProviderIssuer } from "./issuers.js";

// L7i: GCP 임시 토큰 발급기 — `gcloud auth print-access-token --impersonate-service-account=<고객 SA> --delegates=<이 회사 플랫폼 SA>`
//   새 npm 의존성 없이 워커에 있는 gcloud 를 셸 없이 부른다 (sts-cli.ts 와 같은 방식). 시작 자격 = 워커의 gcloud 로그인(플랫폼 쪽)
//   회사 전용 플랫폼 SA 는 "회사 번호 → DB(tenants.gcp_platform_sa)"로만 고른다. 요청·환경 값에 SA 가 들어 있어도 무시한다 (혼동된 대리인 방어, IA 6.2)
//   고객 SA 는 환경의 프로젝트 ID 로 만든 svc-observe|svc-operate@<프로젝트>.iam.gserviceaccount.com 모양만 허용
//   stdout(토큰)은 반환값으로만 넘긴다. 로그·오류 글에 넣지 않는다
// 【미확인】 gcloud --delegates 는 "호출자 → 위임 SA → 대상 SA" 체인. 위임 SA 가 대상 SA 의 tokenCreator 여야 함(gcp-connect.sh 가 그렇게 연다)
//   첫 실측은 맥 RC + 팀 GCP 프로젝트에서 (이 묶음은 가짜 gcloud 로만 시험)

export interface GcloudRunResult { code: number; stdout: string; stderr: string }
export type GcloudRun = (args: string[], env: NodeJS.ProcessEnv) => Promise<GcloudRunResult>;
// DRAFT(ai): 시간 제한 20초 (STS CLI 와 같게)
export const GCLOUD_TIMEOUT_MS = 20_000;
export const GCP_PLATFORM_SA_ID = /^t-[0-9a-f]{28}$/;
const CUSTOMER_SA = /^svc-(observe|operate)@([a-z][a-z0-9-]{4,28}[a-z0-9])\.iam\.gserviceaccount\.com$/;
const PROJECT_ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;

/** 사유가 정해진 발급 실패. reason = ConnectionFailure 값 */
export class GcpIssueError extends Error {
  constructor(readonly reason: "ROLE_ASSUME_DENIED" | "ROLE_NOT_FOUND" | "PLATFORM_SA_MISSING", why: string) { super(`gcloud 발급 실패 (${reason}): ${why}`); }
}
/** 명령 없음·시간 초과·알 수 없는 실패 (작업 재시도 대상) */
export class GcloudCliError extends Error {
  constructor(readonly code: number, why: string) { super(`gcloud print-access-token 실패 (exit ${code}): ${why}`); }
  get missing() { return this.code === 127; }
}

export const platformSaEmail = (saId: string, platformProject: string) => `${saId}@${platformProject}.iam.gserviceaccount.com`;

/** 순수 함수: 인자 배열 */
export function gcloudImpersonateArgs(i: { target: string; delegate: string; lifetimeSec: number }): string[] {
  return ["auth", "print-access-token", `--impersonate-service-account=${i.target}`, `--delegates=${i.delegate}`, `--lifetime=${i.lifetimeSec}`];
}

const defaultRun: GcloudRun = (args, env) => new Promise((resolve) => {
  execFile("gcloud", args, { timeout: GCLOUD_TIMEOUT_MS, maxBuffer: 1024 * 1024, env, windowsHide: true }, (err, stdout, stderr) => {
    const e = err as (NodeJS.ErrnoException & { code?: number | string; killed?: boolean }) | null;
    if (e && e.code === "ENOENT") return resolve({ code: 127, stdout: "", stderr: "gcloud 없음" });
    if (e && e.killed) return resolve({ code: 124, stdout: "", stderr: "시간 초과" });
    resolve({ code: e ? (typeof e.code === "number" ? e.code : 1) : 0, stdout: String(stdout), stderr: String(stderr) });
  });
});

/** gcloud 오류 글 → 사유 (글 원문은 오류에 담지 않는다: SA 이메일·프로젝트 번호) */
export function gcloudFailure(stderr: string): "ROLE_ASSUME_DENIED" | "ROLE_NOT_FOUND" | null {
  if (/NOT_FOUND|does not exist|not found/i.test(stderr)) return "ROLE_NOT_FOUND";
  if (/PERMISSION_DENIED|iam\.serviceAccounts\.getAccessToken|does not have permission|Failed to impersonate|403/i.test(stderr)) return "ROLE_ASSUME_DENIED";
  return null;
}

export interface GcpCliIssuerOptions {
  /** 회사 번호 → 플랫폼 SA ID(tenants.gcp_platform_sa). DB 에서만 읽는다 */
  platformSa: (tenantId: string) => Promise<string | undefined>;
  platformProject: string;
  run?: GcloudRun;
  env?: NodeJS.ProcessEnv;
}

export function gcpCliIssuer(o: GcpCliIssuerOptions): ProviderIssuer {
  const run = o.run ?? defaultRun;
  if (!PROJECT_ID.test(o.platformProject)) throw new Error("GCP_PLATFORM_PROJECT 모양이 아님");
  return {
    mock: false,
    async issue(ctx: IssueContext) {
      const saId = await o.platformSa(ctx.req.tenantId);
      if (!saId || !GCP_PLATFORM_SA_ID.test(saId)) throw new GcpIssueError("PLATFORM_SA_MISSING", "이 회사의 플랫폼 SA 가 DB 에 없음");
      if (!CUSTOMER_SA.test(ctx.roleRef)) throw new GcpIssueError("ROLE_NOT_FOUND", "고객 SA 이름 모양이 아님");
      const ttl = Math.min(3600, Math.max(60, ctx.req.ttlSec));
      // 워커 자기 환경에 다른 토큰이 꽂혀 있으면 그것으로 부르지 않게 지운다 (자기 gcloud 로그인으로만 시작)
      const env = { ...(o.env ?? process.env) }; delete env.CLOUDSDK_AUTH_ACCESS_TOKEN;
      const r = await run(gcloudImpersonateArgs({ target: ctx.roleRef, delegate: platformSaEmail(saId, o.platformProject), lifetimeSec: ttl }), env);
      if (r.code !== 0) {
        const why = gcloudFailure(r.stderr);
        if (why) throw new GcpIssueError(why, "gcloud 가 거부함");
        throw new GcloudCliError(r.code, r.code === 124 ? "시간 초과" : r.code === 127 ? "gcloud 명령 없음" : "알 수 없는 오류");
      }
      const token = r.stdout.trim();
      if (!/^[A-Za-z0-9._~-]{20,}$/.test(token)) throw new GcloudCliError(1, "응답이 토큰 모양이 아님");
      return { material: { kind: "bearer" as const, token }, expiresAt: new Date(ctx.now.getTime() + ttl * 1000), ttlSec: ttl,
        detail: { serviceAccount: ctx.roleRef, delegate: platformSaEmail(saId, o.platformProject), realSts: true } };
    },
    // 액세스 토큰은 만료까지 살아 있다. 보관함에서 지우기만 한다 (gcpIamIssuer 의 hard 회수는 oauth2 revoke 를 부르지만 이 발급기는 네트워크 호출을 더 안 한다)
    async revoke() { return { hardRevoked: false, detail: { method: "drop_and_expire" } }; },
  };
}

/** REAL_STS=1 이어도 프로젝트가 "stub"(시드)인 환경은 mock 으로 (AWS perEnvAwsIssuer 와 같은 생각) */
export function perEnvGcpIssuer(real: ProviderIssuer, fallback: ProviderIssuer): ProviderIssuer {
  const isReal = (roleRef: string) => CUSTOMER_SA.test(roleRef);
  return {
    mock: false,
    mockFor: (b) => (isReal(b.roleRef ?? "") ? real.mock : fallback.mock),
    issue: (ctx) => (isReal(ctx.roleRef) ? real : fallback).issue(ctx),
    // 회수 맥락엔 roleRef 가 있다. 진짜는 보관함 삭제뿐이라 mock 과 결과 같음
    revoke: (ctx) => (isReal(ctx.roleRef) ? real : fallback).revoke(ctx),
  };
}
