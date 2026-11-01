import { envNumber } from "@svc/contracts";

// 로그인 설정 한 곳 (Z93). 모든 값은 요청 순간 env 를 읽는다 (시험이 env 를 바꿔 볼 수 있게)
// DRAFT(ai) Z93: 기본값 근거 — OWASP Session Management Cheat Sheet: 짧은 유휴 만료 + 절대 만료.
//   접근 토큰 15분(로그아웃해도 이 시간까지는 살아 있다 = 무상태 토큰의 대가), 리프레시 8시간(하루 작업), 로그인 한 번 최대 24시간
export const authSettings = (env: NodeJS.ProcessEnv = process.env) => ({
  accessTtlSec: envNumber(env.AUTH_ACCESS_TTL_SEC, 900) || 900,
  refreshTtlSec: envNumber(env.AUTH_REFRESH_TTL_SEC, 8 * 3600) || 8 * 3600,
  sessionMaxSec: envNumber(env.AUTH_SESSION_MAX_SEC, 24 * 3600) || 24 * 3600,
  cookieSecure: env.AUTH_COOKIE_SECURE === "1",
  // 바꾼(rotated) 토큰이 이 시간 안에 다시 오면 탭 두 개가 동시에 갱신한 것으로 보고 묶음을 끊지 않는다 (그 요청만 401). 시험은 0
  rotateGraceMs: ((v) => (Number.isFinite(v) && v >= 0 ? v : 10_000))(envNumber(env.AUTH_ROTATE_GRACE_MS, 10_000)),
});

// 개발용 x-dev-tenant 헤더 인증: DEV_AUTH=1 일 때만, 운영(NODE_ENV=production·AUTH_MODE=real)에서는 절대 안 켜진다.
// DECISION(team) 10/31 Jeong(Z93 지시): x-dev-tenant 는 시험 전용. 기본은 진짜 로그인
export const devHeaderAuthEnabled = (env: NodeJS.ProcessEnv = process.env) =>
  env.DEV_AUTH === "1" && env.NODE_ENV !== "production" && env.AUTH_MODE !== "real";

export const REFRESH_COOKIE = "svc_refresh";
// 브라우저는 /api/auth/... 로 부르고 Vite·nginx 가 /api/v1/auth/... 로 바꾼다 → 브라우저 기준 두 모양 다 덮는 /api
export const REFRESH_COOKIE_PATH = "/api";
