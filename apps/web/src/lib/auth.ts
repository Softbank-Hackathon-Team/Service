import { t } from './i18n';
// 로그인 상태 한 곳. Vite(import.meta.env)를 안 쓰는 순수 모듈이라 node:test 로 바로 시험한다 (test/auth.test.ts).
//
// 서버 계약 (화면 기준 /api/auth/* → 프록시 → /api/v1/auth/*)
//   POST /auth/login   {email, password} → 200 {accessToken, tokenType, expiresIn, user} + Set-Cookie(refresh, HttpOnly)
//   POST /auth/refresh 본문 없음, 쿠키로      → 200 같은 모양(refresh 회전) / 401
//   POST /auth/logout                         → 204, 쿠키 지움
//   쿠키 svc_refresh: HttpOnly, SameSite=Strict, Path=/api (화면은 /api/auth/… 로 부르고 프록시가 /api/v1 로 바꾼다)
//   GET /auth/config {devAuth, loginRequired, github:{enabled}} 인증 없이. 로그인 화면이 GitHub 버튼을 띄울지만 본다
//   GET /auth/github/start (브라우저 이동) → GitHub → 서버 콜백 → 화면으로 302. 성공이면 refresh 쿠키가 생겨 bootstrap 이 들어가고,
//     실패면 ?github_error=<코드> 가 붙어 온다 (contracts github-login.ts GITHUB_LOGIN_ERRORS)
//   GET /auth/me 는 화면이 부르지 않는다 (로그인·refresh 응답에 user 가 이미 있다)
//   TODO(human): 서버가 시험용 헤더 인증(devAuth=true)으로 떠 있을 때 화면이 로그인을 건너뛸지. 지금은 언제나 로그인 화면을 거친다
//     참고: 화면은 x-dev-tenant 를 보내지 않고, devAuth 서버에서도 Bearer 로그인이 그대로 된다. 그래서 로그인 화면을 두는 쪽이 더 단순하다
//
// 토큰 보관
//   - access 토큰: 이 모듈 변수(메모리)에만. localStorage·sessionStorage 에 안 둔다
//   - refresh 토큰: 서버가 HttpOnly 쿠키로. JS 가 못 읽는다. 새로 고침하면 /auth/refresh 로 access 를 다시 받는다
//   - 같은 출처(Vite 프록시·nginx /api)라 credentials: "same-origin" 으로 쿠키가 따라간다

export interface AuthUser { id: string; email: string; displayName?: string | null; tenantId: string; tenantName?: string | null }
export interface TokenResponse { accessToken: string; tokenType?: string; expiresIn: number; user: AuthUser }

export interface AuthState {
  // 첫 확인이 끝났나. 끝나기 전에는 화면을 그리지 않는다
  ready: boolean;
  user: AuthUser | null;
  // 로그인 화면에 보여 줄 한 줄 (세션 만료 등)
  notice: string | null;
}

export class AuthError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

export interface AuthOptions {
  base: string;               // 예: "/api"
  fetch?: typeof fetch;       // 시험용
  now?: () => number;         // 시험용 (ms)
}

// DRAFT(ai): 만료 몇 초 전에 미리 refresh 할지. 요청 도중 만료되어 401 을 한 번 맞는 것보다 싸다
export const EARLY_REFRESH_SEC = 30;

/** GET /auth/config (apps/api routes/auth.ts AuthConfig) */
export interface AuthConfig { devAuth: boolean; loginRequired: boolean; github?: { enabled: boolean } }

// 쓰던 중에 계정이 꺼지면 보호 경로가 401 USER_DISABLED 를 준다 (apps/api plugins/auth.ts). refresh 해도 같으니 바로 로그인 화면으로
export const USER_DISABLED_NOTICE = t('이 계정은 꺼졌거나 회사에서 빠졌습니다. 회사 관리자에게 확인해 주세요.');

/** GitHub 로그인 시작 주소. fetch 가 아니라 브라우저 이동으로 연다 (GitHub 화면을 거쳐 서버 콜백이 화면으로 돌려보낸다) */
export const githubStartUrl = (base: string) => `${base}/auth/github/start`;

const GITHUB_ERROR: Record<string, string> = {
  GITHUB_LOGIN_DISABLED: t('이 서버에서는 GitHub 로그인이 꺼져 있습니다.'),
  GITHUB_STATE_INVALID: t('GitHub 로그인 확인 시간이 지났거나 다른 창에서 시작했습니다. 다시 시도해 주세요.'),
  GITHUB_ACCESS_DENIED: t('GitHub에서 접근을 허락하지 않았습니다.'),
  GITHUB_CODE_INVALID: t('GitHub 로그인을 확인하지 못했습니다. 다시 시도해 주세요.'),
  GITHUB_UNAVAILABLE: t('GitHub에 연결하지 못했습니다. 잠시 뒤 다시 시도해 주세요.'),
  GITHUB_EMAIL_UNVERIFIED: t('GitHub 계정에 확인된 기본 이메일이 없습니다. GitHub에서 이메일을 확인한 뒤 다시 시도해 주세요.'),
  GITHUB_ACCOUNT_NOT_ALLOWED: t('이 GitHub 계정으로 들어올 콘솔 계정이 없거나 꺼져 있습니다. 회사 관리자에게 확인해 주세요.'),
  GITHUB_ALREADY_LINKED: t('이 이메일의 계정은 다른 GitHub 계정과 이미 연결되어 있습니다.'),
};

/** ?github_error= 코드 → 사람 말. 모르는 코드는 지어내지 않고 실패했다고만 한다 */
export const githubErrorText = (code: string) => GITHUB_ERROR[code] ?? t('GitHub 로그인에 실패했습니다.');

/** 주소에서 github_error 를 꺼내고, 그 칸을 뺀 주소를 돌려준다 (해시는 그대로). 없으면 code 가 null */
export function takeGithubError(href: string): { code: string | null; clean: string } {
  const url = new URL(href);
  const code = url.searchParams.get("github_error");
  url.searchParams.delete("github_error");
  return { code, clean: `${url.pathname}${url.search}${url.hash}` };
}

export function createAuth(o: AuthOptions) {
  const doFetch = o.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const now = o.now ?? (() => Date.now());
  let token: string | null = null;
  let expiresAt = 0;
  let state: AuthState = { ready: false, user: null, notice: null };
  const subs = new Set<() => void>();
  const set = (s: Partial<AuthState>) => { state = { ...state, ...s }; for (const f of subs) f(); };

  const post = (path: string, body?: unknown) => doFetch(`${o.base}/auth/${path}`, {
    method: "POST",
    credentials: "same-origin",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  function accept(t: TokenResponse) {
    token = t.accessToken;
    expiresAt = now() + Math.max(0, t.expiresIn) * 1000;
    set({ ready: true, user: t.user, notice: null });
  }
  function drop(notice: string | null) {
    token = null; expiresAt = 0;
    set({ ready: true, user: null, notice });
  }

  // refresh 는 동시에 여러 요청이 401 을 맞아도 한 번만 보낸다 (refresh 토큰 회전이라 두 번 보내면 두 번째가 실패한다)
  let inflight: Promise<boolean> | null = null;
  function refresh(): Promise<boolean> {
    inflight ??= (async () => {
      try {
        const res = await post("refresh");
        if (!res.ok) { drop(state.user ? t('로그인이 끝났습니다. 다시 로그인해 주세요.') : null); return false; }
        accept(await res.json() as TokenResponse);
        return true;
      } catch {
        // 네트워크 오류. 첫 확인이면 로그인 화면으로 보내고, 쓰던 중이면 세션을 건드리지 않는다
        if (!state.ready) drop(null);
        return false;
      } finally { inflight = null; }
    })();
    return inflight;
  }

  let booted: Promise<AuthState> | null = null;

  return {
    // 첫 화면 전에 한 번: 쿠키가 살아 있으면 로그인 없이 들어간다.
    // 한 번만 (StrictMode 가 effect 를 두 번 돌려도 refresh 회전이 두 번 나가지 않게)
    bootstrap(): Promise<AuthState> { return (booted ??= refresh().then(() => state)); },
    async login(email: string, password: string): Promise<void> {
      const res = await post("login", { email, password });
      if (!res.ok) {
        let b: { code?: string; message?: string } = {};
        try { b = await res.json() as typeof b; } catch { /* JSON 아님 */ }
        throw new AuthError(res.status, b.code ?? `HTTP_${res.status}`,
          b.code === "USER_DISABLED" ? USER_DISABLED_NOTICE
            : res.status === 401 ? t('이메일이나 비밀번호가 맞지 않습니다.') : res.status === 429 ? t('시도가 너무 많습니다. 잠시 뒤 다시 시도해 주세요.') : (b.message ?? t('로그인 실패 (HTTP {0})', { 0: res.status })));
      }
      accept(await res.json() as TokenResponse);
    },
    async logout(): Promise<void> {
      try { await post("logout"); } catch { /* 서버가 없어도 화면은 로그아웃 */ }
      drop(null);
    },
    // http.ts 가 요청마다 부른다. 곧 만료면 먼저 refresh
    async accessToken(): Promise<string | null> {
      if (token && now() < expiresAt - EARLY_REFRESH_SEC * 1000) return token;
      if (state.user) await refresh();
      return token;
    },
    // 보호 경로가 401 → refresh 한 번. 성공하면 true (요청을 한 번 더 보낸다), 실패하면 로그인 화면으로
    // 401 USER_DISABLED(계정이 꺼짐)는 refresh 해도 같으므로 바로 로그인 화면으로 보내고 그 이유를 말한다
    async onUnauthorized(code?: string): Promise<boolean> {
      token = null;
      if (code === "USER_DISABLED") { drop(USER_DISABLED_NOTICE); return false; }
      return refresh();
    },
    // 로그인 화면용 서버 설정. 못 읽으면 null (GitHub 버튼을 안 띄운다)
    async config(): Promise<AuthConfig | null> {
      try {
        const res = await doFetch(`${o.base}/auth/config`, { method: "GET", credentials: "same-origin" });
        return res.ok ? (await res.json() as AuthConfig) : null;
      } catch { return null; }
    },
    get: () => state,
    subscribe(f: () => void) { subs.add(f); return () => { subs.delete(f); }; },
  };
}

export type Auth = ReturnType<typeof createAuth>;
