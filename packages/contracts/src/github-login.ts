import { z } from "zod";

// GHLOGIN: GitHub OAuth 로그인 경계 계약. 비밀(client secret·code·토큰)은 이 모양들에 들어가지 않는다
// DRAFT(ai): GitHub REST 응답 중 쓰는 칸만 (모르는 칸은 버린다 = strict 아님. GitHub 가 칸을 늘려도 로그인이 안 깨지게)
export const GithubUser = z.object({
  id: z.number().int().positive(),
  login: z.string().min(1).max(100),
  name: z.string().max(200).nullable().optional(),
});
export type GithubUser = z.infer<typeof GithubUser>;

export const GithubEmail = z.object({
  email: z.string().max(254),
  primary: z.boolean(),
  verified: z.boolean(),
});
export type GithubEmail = z.infer<typeof GithubEmail>;
export const GithubEmails = z.array(GithubEmail);

/** 화면이 로그인 화면에 GitHub 버튼을 띄울지 정한다 (/auth/config 의 github 칸) */
export const GithubConfig = z.object({ enabled: z.boolean() }).strict();
export type GithubConfig = z.infer<typeof GithubConfig>;

/** 콜백 실패 코드 (ApiError.code 이자 브라우저 이동 때 ?github_error= 값) */
export const GITHUB_LOGIN_ERRORS = [
  "GITHUB_LOGIN_DISABLED",      // 404 깃발 없음
  "GITHUB_STATE_INVALID",       // 400 state·쿠키 틀림/만료
  "GITHUB_ACCESS_DENIED",       // 401 사용자가 GitHub 에서 거부
  "GITHUB_CODE_INVALID",        // 401 code 교환 실패
  "GITHUB_UNAVAILABLE",         // 502 GitHub 불통
  "GITHUB_EMAIL_UNVERIFIED",    // 403 검증된 기본 이메일 없음
  "GITHUB_ACCOUNT_NOT_ALLOWED", // 403 계정 없음(가입 닫힘)·꺼진 사용자
  "GITHUB_ALREADY_LINKED",      // 409 그 이메일 사용자는 다른 GitHub 계정과 이미 연결됨
] as const;
export type GithubLoginError = (typeof GITHUB_LOGIN_ERRORS)[number];
