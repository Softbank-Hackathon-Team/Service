import { z } from "zod";
import { Provider } from "./common.js";
import { CreateEnvironmentBody, checkAccountId } from "./environment.js";

// 팀 가입 명부 (docs/team-env/registry.yaml). 레포에 커밋하고 api 이미지에 들어간다 (TEAM_REGISTRY_PATH)
//   자리(slot) 하나 = 로그인 하나 + 그 사람이 쓸 환경 목록. 초대 코드는 원문이 아니라 sha256 hex 만 둔다 (빈 값 = 그 자리 닫힘)
//   가입(POST /auth/signup)이 이 명부로 사용자를 만들고, 이름이 없는 환경만 미리 만든다 (연결·확인은 사용자가 직접)
// DRAFT(ai): 모르는 칸이 있으면 명부 전체를 거부한다(strict). 칸 이름 오타(cluster → clustr)가 조용히 빠진 환경을 만들지 않게.
//   거부되면 가입이 꺼지고 api 가 경고 한 줄을 남긴다 (서버는 뜬다)
export const TEAM_REGISTRY_VERSION = 1;

// 로그인 이름 = 이메일 모양 (routes/auth.ts LoginBody 와 같은 규칙). 소문자로 맞춰 대소문자만 다른 로그인을 같은 자리로 본다
export const TeamLogin = z.string().trim().toLowerCase().max(254).regex(/^[^@\s]+@[^@\s]+$/);
// 초대 코드의 sha256 (소문자 hex 64자). "" = 닫힘
export const SignupCodeHash = z.string().trim().toLowerCase().regex(/^(?:[0-9a-f]{64})?$/, "sha256 hex (64) or empty");

const GcpProjectId = z.string().trim().refine((s) => checkAccountId("gcp", s), "gcp project id shape");

export const TeamEnvironment = z.object({
  // 이름·리전·클러스터 칸 상한은 POST /environments 본문(CreateEnvironmentBody)과 같다
  name: CreateEnvironmentBody.shape.name,
  provider: Provider,
  region: CreateEnvironmentBody.shape.region,
  cluster: CreateEnvironmentBody.shape.clusterName,
  // GCP 결정 3번 A안: 원래 프로젝트(관찰) + 이전 전용 프로젝트(도착). verify 경로와 같은 규칙 (모양 같음, 서로 달라야 함)
  gcp: z.object({ original_project: GcpProjectId, dedicated_project: GcpProjectId }).strict().optional(),
  // 사람이 읽는 메모 (공유 여부·계정 별칭 등). 플랫폼은 쓰지 않는다. 비밀값·계정 번호는 적지 않는다 (명부 머리말 규칙)
  notes: z.string().max(500).optional(),
}).strict().superRefine((e, ctx) => {
  if (e.gcp && e.provider !== "gcp") ctx.addIssue({ code: "custom", path: ["gcp"], message: "gcp block is for provider gcp only" });
  if (e.gcp && e.gcp.original_project === e.gcp.dedicated_project)
    ctx.addIssue({ code: "custom", path: ["gcp", "dedicated_project"], message: "dedicated_project must differ from original_project" });
});
export type TeamEnvironment = z.infer<typeof TeamEnvironment>;

export const TeamSlot = z.object({
  id: z.string().trim().min(1).max(64).regex(/^[a-z0-9][a-z0-9-]*$/, "slot id: lowercase letters, digits, dash"),
  login: TeamLogin,
  signup_code_sha256: SignupCodeHash,
  // 칸마다 회사(테넌트). 다섯 명이 서로 막지 않고 동시에 이전하도록 칸마다 회사를 나눈다 (회사 단위 큐 몫·화면·환경 이름이 따로).
  //   비우면 명부 맨 위 tenant (예전 판 명부와 같음). 회사 행(tenants)은 운영자가 먼저 만든다 (없으면 가입이 503 SIGNUP_NOT_CONFIGURED)
  tenant: z.uuid().optional(),
  environments: z.array(TeamEnvironment).max(20).default([]),
}).strict().superRefine((s, ctx) => {
  const seen = new Set<string>();
  s.environments.forEach((e, i) => {
    if (seen.has(e.name)) ctx.addIssue({ code: "custom", path: ["environments", i, "name"], message: "duplicate environment name in slot" });
    seen.add(e.name);
  });
});
export type TeamSlot = z.infer<typeof TeamSlot>;

export const TeamRegistry = z.object({
  version: z.literal(TEAM_REGISTRY_VERSION),
  tenant: z.uuid(),
  slots: z.array(TeamSlot).max(100),
}).strict().superRefine((r, ctx) => {
  const ids = new Set<string>(), logins = new Set<string>();
  r.slots.forEach((s, i) => {
    if (ids.has(s.id)) ctx.addIssue({ code: "custom", path: ["slots", i, "id"], message: "duplicate slot id" });
    if (logins.has(s.login)) ctx.addIssue({ code: "custom", path: ["slots", i, "login"], message: "duplicate login" });
    ids.add(s.id); logins.add(s.login);
  });
});
export type TeamRegistry = z.infer<typeof TeamRegistry>;

// 비밀번호 길이: apps/api/src/auth/password.ts PASSWORD_MIN·PASSWORD_MAX 와 같은 값 (같은지는 apps/api/test/signup.test.ts 가 본다)
export const SIGNUP_PASSWORD_MIN = 8;
export const SIGNUP_PASSWORD_MAX = 256;

/** POST /auth/signup 본문. code = 운영자가 따로 건넨 초대 코드 원문 (서버는 sha256 만 비교, 어디에도 남기지 않음) */
// DRAFT(ai): 코드는 앞뒤 빈칸을 지운 뒤 해시한다 (메신저에서 복사할 때 붙는 줄바꿈·빈칸). 운영자도 빈칸 없는 코드의 sha256 을 적는다
export const SignupBody = z.object({
  login: TeamLogin,
  code: z.string().trim().min(1).max(256),
  password: z.string().min(SIGNUP_PASSWORD_MIN).max(SIGNUP_PASSWORD_MAX),
}).strict();
export type SignupBody = z.infer<typeof SignupBody>;

/** GET /auth/signup/config. 명부를 읽었고 열린 자리(코드 해시가 있는 자리)가 하나라도 있을 때만 true */
export const SignupConfig = z.object({ enabled: z.boolean() }).strict();
export type SignupConfig = z.infer<typeof SignupConfig>;

/** 가입 실패 코드 (ApiError.code). 자리 닫힘·모르는 로그인·코드 틀림은 전부 같은 SIGNUP_NOT_ALLOWED (있는 로그인을 알려 주지 않기) */
export const SIGNUP_ERRORS = [
  "SIGNUP_DISABLED",        // 404 명부 없음·틀림 또는 열린 자리 없음
  "SIGNUP_NOT_ALLOWED",     // 403 자리 닫힘·모르는 로그인·코드 틀림
  "SIGNUP_EXISTS",          // 409 그 로그인 사용자가 이미 있음 (코드가 맞을 때만 알려 줌)
  "SIGNUP_NOT_CONFIGURED",  // 503 명부의 회사가 DB 에 없음 (운영자가 고칠 것)
] as const;
export type SignupError = (typeof SIGNUP_ERRORS)[number];
