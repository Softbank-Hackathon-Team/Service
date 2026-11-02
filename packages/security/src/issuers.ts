import type { Provider } from "@svc/contracts";
import type { TempRoleRequest } from "./temp-role.js";
import type { SecretMaterial } from "./vault.js";

// 제공자별 임시 자격 발급·회수. 모두 "같은 입력 → 같은 요청 모양"이 되게 요청 만드는 부분은 순수 함수로 뺐다.
export interface IssueContext {
  req: TempRoleRequest;
  now: Date;
  roleRef: string;             // AWS 역할 ARN / GCP SA 이메일 / 온프레 ns/sa
  sessionName: string;
  sessionPolicy?: string;      // AWS 만
  externalId?: string;         // AWS 만. 고객별 값, 비밀은 아니지만 로그엔 안 남긴다 (혼동된 대리인 방지)
}
export interface Issued { material: SecretMaterial; expiresAt: Date; ttlSec: number; detail: Record<string, unknown> }
export interface RevokeContext { roleRef: string; issuedAt: Date; now: Date; material: SecretMaterial | null; hard: boolean }
export interface ProviderIssuer {
  readonly mock: boolean;
  // L4: 환경마다 진짜/가짜가 갈리는 발급기(perEnvAwsIssuer)만 둔다. broker 가 resolveEnv 뒤에 불러 ExternalId 관문·장부 stub 칸에 쓴다.
  //   없으면 mock 값 그대로
  mockFor?(binding: { externalId?: string }): boolean;
  issue(ctx: IssueContext): Promise<Issued>;
  // 회수. hard=false 면 보관함에서 지우기만 (만료까지 최대 1시간 남는다). hard=true 는 제공자에서 실제로 무효화 시도
  revoke(ctx: RevokeContext): Promise<{ hardRevoked: boolean; detail: Record<string, unknown> }>;
}

// ───────── AWS STS AssumeRole ─────────
// 【사실】 AssumeRole DurationSeconds 는 900초 이상 (역할 최대 세션 시간 이하). RoleSessionName 2~64자 [\w+=,.@-]
// DECISION(team): 기본 리전 서울 ap-northeast-2 (10/31 통합본 기준 확정). STS 도 지역 엔드포인트를 쓴다
export const AWS_STS_MIN_TTL = 900;
export const AWS_DEFAULT_REGION = "ap-northeast-2";
// 아래 인터페이스는 AWS SDK v3 STSClient AssumeRoleCommand 의 입력·출력 모양과 같다
// STUB: SDK 연결 (@aws-sdk/client-sts 추가는 통합에 요청). 지금은 주입받는다
export interface StsApi {
  assumeRole(input: AssumeRoleInput): Promise<{
    Credentials?: { AccessKeyId?: string; SecretAccessKey?: string; SessionToken?: string; Expiration?: Date };
    AssumedRoleUser?: { Arn?: string; AssumedRoleId?: string };
  }>;
}
export interface AssumeRoleInput {
  RoleArn: string; RoleSessionName: string; DurationSeconds: number;
  ExternalId?: string; Policy?: string; SourceIdentity?: string;
  Tags?: Array<{ Key: string; Value: string }>;
}

export function assumeRoleInput(ctx: IssueContext): AssumeRoleInput {
  const name = ctx.sessionName.replace(/[^\w+=,.@-]/g, "-").slice(0, 64);
  return {
    RoleArn: ctx.roleRef,
    RoleSessionName: name.length >= 2 ? name : `${name}--`,
    DurationSeconds: Math.max(AWS_STS_MIN_TTL, ctx.req.ttlSec),
    ...(ctx.externalId ? { ExternalId: ctx.externalId } : {}),
    ...(ctx.sessionPolicy ? { Policy: ctx.sessionPolicy } : {}),
    // 고객 CloudTrail 에서 "어느 회사의 어느 이전"인지 찾게 남긴다. SourceIdentity 는 세션 동안 못 바꾼다
    SourceIdentity: name,
    Tags: [
      { Key: "svc:tenant", Value: ctx.req.tenantId },
      { Key: "svc:purpose", Value: ctx.req.purpose },
      ...(ctx.req.migrationId ? [{ Key: "svc:migration", Value: ctx.req.migrationId }] : []),
    ],
  };
}

// 강제 회수 (위협 모델 T-ROLE-9): 고객 역할에 "이 시각 전 세션 전부 거부" 정책을 넣는 방식은 쓰지 않는다.
//   그러려면 고객 역할에 iam:PutRolePolicy 가 있어야 하고, 그 권한이 있으면 역할이 자기에게 아무 정책이나 붙일 수 있다(권한 상승).
// 대신: ① 실행 역할 세션을 STS 최소값 900초(15분)로 짧게 (broker.ts OPERATE_MAX_TTL_SEC)
//       ② 회수 = 보관함에서 값 삭제 + 장부 revoked → 플랫폼 안에서는 즉시 못 씀. 클라우드 세션은 최대 15분 뒤 만료
// 【추정】 플랫폼 계정의 중간 역할을 거쳐(역할 연쇄) 고객 역할을 빌려도, 중간 역할 세션을 끊는 것으로 이미 받은 고객 역할 세션은 안 끊긴다.
//   그래서 "플랫폼 측 역할로 회수"는 AWS 에서는 효과가 없다고 보고 넣지 않았다. 실계정 확인 필요
// TODO(human): 위협 탐지(SEC-VIO-04) 때 고객에게 "세션 회수" 버튼(고객 콘솔의 Revoke active sessions)을 안내할지
export function awsStsIssuer(o: { sts: StsApi; mock?: boolean }): ProviderIssuer {
  return {
    mock: o.mock ?? false,
    async issue(ctx) {
      const input = assumeRoleInput(ctx);
      const r = await o.sts.assumeRole(input);
      const c = r.Credentials;
      if (!c?.AccessKeyId || !c.SecretAccessKey || !c.SessionToken || !c.Expiration) throw new Error("STS 응답에 자격 증명이 없다");
      return {
        material: { kind: "aws", accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.SessionToken },
        expiresAt: c.Expiration, ttlSec: input.DurationSeconds,
        detail: { assumedRoleArn: r.AssumedRoleUser?.Arn ?? null, sessionName: input.RoleSessionName, sessionPolicyChars: input.Policy?.length ?? 0 },
      };
    },
    // 고객 역할을 건드리지 않는다. 보관함 삭제 + 만료 대기 (위 설명)
    async revoke() { return { hardRevoked: false, detail: { method: "drop_and_expire", maxRemainingSec: AWS_STS_MIN_TTL } }; },
  };
}

// L4: REAL_STS=1 일 때 AWS 발급기를 환경별로 고른다. external_id 가 있는 환경 = 진짜, 없는 환경(시드) = mock.
// DRAFT(ai): 시드 환경엔 external_id 가 없어 진짜 발급기면 broker 가 ROLE_NO_EXTERNAL_ID 로 거부한다 → precheck·plan·apply 가 깨진다.
//   그래서 그 환경만 지금처럼 mock 으로 둔다. 진짜 발급은 ExternalId 가 있을 때만 일어나므로 혼동된 대리인 방어(T-ROLE-2)는 그대로
export function perEnvAwsIssuer(real: ProviderIssuer, fallback: ProviderIssuer): ProviderIssuer {
  const pick = (externalId?: string) => (externalId ? real : fallback);
  return {
    mock: false,
    mockFor: (b) => pick(b.externalId).mock,
    async issue(ctx) {
      const out = await pick(ctx.externalId).issue(ctx);
      return { ...out, detail: { ...out.detail, realSts: !pick(ctx.externalId).mock } };
    },
    // 회수 맥락엔 ExternalId 가 없다. 둘 다 "보관함 삭제 + 만료 대기"라 aws 쪽은 같은 결과 → material 이 mock 키 모양이면 mock 으로
    async revoke(ctx) {
      const isMock = ctx.material?.kind === "aws" && ctx.material.accessKeyId.startsWith("ASIAMOCK");
      return (isMock ? fallback : real).revoke(ctx);
    },
  };
}

// ───────── GCP 서비스 계정 단기 토큰 (IAM Credentials generateAccessToken) ─────────
// 【사실】 POST https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/{SA}:generateAccessToken, 기본 최대 수명 3600초
// 플랫폼 자신의 토큰(Workload Identity Federation 으로 받은 것)이 있어야 부를 수 있다 → platformToken 으로 주입
// GCP 는 토큰마다 권한을 좁힐 수 없다 (범위는 cloud-platform). 최소 권한은 SA 커스텀 역할(G 의 gcp-operate-custom-role.yaml)이 맡는다
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string })
  => Promise<{ status: number; json(): Promise<unknown> }>;
export function gcpTokenRequest(ctx: IssueContext) {
  return {
    url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(ctx.roleRef)}:generateAccessToken`,
    body: { scope: ["https://www.googleapis.com/auth/cloud-platform"], lifetime: `${Math.min(3600, ctx.req.ttlSec)}s` },
  };
}
export function gcpIamIssuer(o: { platformToken: () => Promise<string>; fetch?: FetchLike; mock?: boolean }): ProviderIssuer {
  const f = o.fetch ?? (globalThis.fetch as unknown as FetchLike);
  return {
    mock: o.mock ?? false,
    async issue(ctx) {
      const r = gcpTokenRequest(ctx);
      const res = await f(r.url, { method: "POST", body: JSON.stringify(r.body),
        headers: { authorization: `Bearer ${await o.platformToken()}`, "content-type": "application/json" } });
      const b = (await res.json()) as { accessToken?: string; expireTime?: string; error?: { message?: string } };
      if (res.status >= 400 || !b.accessToken || !b.expireTime) throw new Error(`generateAccessToken 실패 HTTP ${res.status}: ${b.error?.message ?? ""}`);
      return { material: { kind: "bearer", token: b.accessToken }, expiresAt: new Date(b.expireTime),
        ttlSec: Math.min(3600, ctx.req.ttlSec), detail: { serviceAccount: ctx.roleRef } };
    },
    async revoke(ctx) {
      if (!ctx.hard || ctx.material?.kind !== "bearer") return { hardRevoked: false, detail: { method: "drop_and_expire" } };
      // 【미확인】 SA 가 만든 액세스 토큰도 oauth2 revoke 로 끊기는지. 실패해도 보관함에서는 지운다
      // 토큰은 URL 이 아니라 본문(form)에 싣는다 (프록시·접근 로그에 안 남게, T-ROLE-10)
      const res = await f("https://oauth2.googleapis.com/revoke",
        { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
          body: `token=${encodeURIComponent(ctx.material.token)}` });
      return { hardRevoked: res.status < 400, detail: { method: "oauth2_revoke", status: res.status } };
    },
  };
}

// ───────── 온프레 k3s: ServiceAccount TokenRequest ─────────
// 【사실】 TokenRequest expirationSeconds 최소 600초. 플랫폼은 온프레 API 서버에 직접 못 붙고 Agent(밖으로 나가는 연결)를 거친다
// STUB: Agent 쪽 "토큰 요청" 명령도, 플랫폼 쪽 발급기 코드도 아직 없다 (모양만 맞춘 발급기는 부르는 곳이 없어 지움). 최소 TTL 만 남긴다
export const K8S_MIN_TTL = 600;

// ───────── Mock (STUB): 어떤 클라우드도 안 부른다 ─────────
// 진짜 발급기와 같은 TTL 규칙(최소값 올림)을 따라서, Mock 에서 통과한 시험이 진짜에서도 같은 결과가 되게 한다
export const MIN_TTL: Record<Provider, number> = { aws: AWS_STS_MIN_TTL, gcp: 60, onprem: K8S_MIN_TTL, azure_mock: 60 };
export function mockIssuer(provider: Provider): ProviderIssuer & { revoked: string[] } {
  const revoked: string[] = [];
  let n = 0;
  return {
    mock: true, revoked,
    async issue(ctx) {
      const ttl = Math.min(3600, Math.max(MIN_TTL[provider], ctx.req.ttlSec));
      n++;
      const material: SecretMaterial = provider === "aws"
        ? { kind: "aws", accessKeyId: `ASIAMOCK${n}`, secretAccessKey: `mock-secret-${n}-do-not-log`, sessionToken: `mock-session-${n}` }
        : { kind: "bearer", token: `mock-token-${provider}-${n}-do-not-log` };
      return { material, expiresAt: new Date(ctx.now.getTime() + ttl * 1000), ttlSec: ttl,
        detail: provider === "aws" ? (() => { const i = assumeRoleInput(ctx);
          return { sessionName: i.RoleSessionName, durationSeconds: i.DurationSeconds, sessionPolicyChars: i.Policy?.length ?? 0, externalIdSet: !!i.ExternalId }; })() : {} };
    },
    async revoke(ctx) { revoked.push(ctx.roleRef); return { hardRevoked: ctx.hard, detail: { method: ctx.hard ? "mock_hard" : "drop_and_expire" } }; },
  };
}
