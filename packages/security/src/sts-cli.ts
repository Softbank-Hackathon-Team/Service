import { execFile } from "node:child_process";
import { maskAccount } from "./live/types.js";
import type { AssumeRoleInput, StsApi } from "./issuers.js";

// L4: StsApi 를 AWS CLI(`aws sts assume-role`)로 구현. 새 npm 의존성(SDK) 없이 워커에 이미 있는 aws CLI 를 셸 없이 부른다
//   (live/exec.ts·adapters real-runner 와 같은 방식). assume-role 은 읽기 점검 동작이 아니라 live/exec.ts 허용 목록에 넣지 않고 여기서 따로 부른다.
// 시작 자격 = 워커 프로세스 환경 그대로 (플랫폼 워커 역할을 이미 빌린 상태). --profile 은 주지 않는다 (자격 바꾸기 금지)
// stdout(빌린 키)은 반환값으로만 넘긴다. 로그·오류 메시지에 넣지 않는다

export interface StsCliRunResult { code: number; stdout: string; stderr: string }
export type StsCliRun = (args: string[], env: NodeJS.ProcessEnv) => Promise<StsCliRunResult>;

// DRAFT(ai): 시간 제한 20초 (adapters CLOUD_READ_TIMEOUT_MS 기본값과 같게)
export const STS_CLI_TIMEOUT_MS = 20_000;

/** CLI 실패. awsCode = stderr 의 괄호 코드만 (AccessDenied, NoSuchEntity …). stderr 원문은 담지 않는다 (ARN 계정 번호·요청 번호) */
export class StsCliError extends Error {
  constructor(readonly code: number, readonly awsCode: string | null, why?: string,
    /** FM-CON-07: AccessDenied 원문에서 "not authorized to perform: <동작>" 의 동작만 (sts:AssumeRole·sts:TagSession·sts:SetSourceIdentity). 계정·ARN 은 안 담음 */
    readonly deniedAction: string | null = null) {
    super(`aws sts assume-role 실패 (exit ${code}${awsCode ? `, ${awsCode}` : ""}${deniedAction ? `, ${deniedAction}` : ""})${why ? `: ${maskAccount(why)}` : ""}`);
  }
  get missing() { return this.code === 127; }
}

// "An error occurred (AccessDenied) when calling the AssumeRole operation: …" → AccessDenied
export const awsErrorCode = (stderr: string): string | null => stderr.match(/An error occurred \(([A-Za-z0-9.]+)\)/)?.[1] ?? null;
// "… is not authorized to perform: sts:TagSession on resource: …" → sts:TagSession (서비스:동작 모양만, 나머지 원문은 버림)
export const awsDeniedAction = (stderr: string): string | null => stderr.match(/not authorized to perform:\s*([a-z0-9-]+:[A-Za-z0-9]+)/)?.[1] ?? null;

/** AssumeRoleInput → aws CLI 인자 (순수 함수) */
export function stsCliArgs(i: AssumeRoleInput, region: string): string[] {
  const a = ["sts", "assume-role", "--role-arn", i.RoleArn, "--role-session-name", i.RoleSessionName,
    "--duration-seconds", String(i.DurationSeconds), "--output", "json", "--region", region];
  if (i.ExternalId) a.push("--external-id", i.ExternalId);
  if (i.SourceIdentity) a.push("--source-identity", i.SourceIdentity);
  if (i.Tags?.length) a.push("--tags", ...i.Tags.map((t) => `Key=${t.Key},Value=${t.Value}`));
  if (i.Policy) a.push("--policy", i.Policy);
  return a;
}

const defaultRun: StsCliRun = (args, env) => new Promise((resolve) => {
  execFile("aws", args, { timeout: STS_CLI_TIMEOUT_MS, maxBuffer: 1024 * 1024, env, windowsHide: true }, (err, stdout, stderr) => {
    const e = err as (NodeJS.ErrnoException & { code?: number | string; killed?: boolean }) | null;
    if (e && e.code === "ENOENT") return resolve({ code: 127, stdout: "", stderr: "aws 없음" });
    if (e && e.killed) return resolve({ code: 124, stdout: "", stderr: "시간 초과" });
    resolve({ code: e ? (typeof e.code === "number" ? e.code : 1) : 0, stdout: String(stdout), stderr: String(stderr) });
  });
});

export function awsCliSts(o: { run?: StsCliRun; env?: NodeJS.ProcessEnv } = {}): StsApi {
  const run = o.run ?? defaultRun;
  return {
    async assumeRole(input) {
      const env = o.env ?? process.env;
      // DECISION(team): 기본 리전 서울 (issuers.ts AWS_DEFAULT_REGION 과 같음). STS 지역 엔드포인트
      const region = env.AWS_REGION || env.AWS_DEFAULT_REGION || "ap-northeast-2";
      const r = await run(stsCliArgs(input, region), env);
      if (r.code !== 0) throw new StsCliError(r.code, awsErrorCode(r.stderr), r.code === 124 ? "시간 초과" : r.code === 127 ? "aws 명령 없음" : undefined, awsDeniedAction(r.stderr));
      let j: { Credentials?: { AccessKeyId?: string; SecretAccessKey?: string; SessionToken?: string; Expiration?: string };
        AssumedRoleUser?: { Arn?: string; AssumedRoleId?: string } };
      try { j = JSON.parse(r.stdout); }
      catch { throw new StsCliError(1, null, "응답이 JSON 이 아님"); }
      const c = j.Credentials;
      return {
        ...(c ? { Credentials: {
          ...(c.AccessKeyId ? { AccessKeyId: c.AccessKeyId } : {}),
          ...(c.SecretAccessKey ? { SecretAccessKey: c.SecretAccessKey } : {}),
          ...(c.SessionToken ? { SessionToken: c.SessionToken } : {}),
          ...(c.Expiration ? { Expiration: new Date(c.Expiration) } : {}),
        } } : {}),
        ...(j.AssumedRoleUser ? { AssumedRoleUser: j.AssumedRoleUser } : {}),
      };
    },
  };
}
