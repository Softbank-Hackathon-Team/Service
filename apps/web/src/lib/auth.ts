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
//   GET  /auth/signup/config {enabled} 인증 없이. 로그인 화면이 "회원가입"을 띄울지만 본다. 404(가입 경로가 없는 예전 서버)는 꺼짐
//   POST /auth/signup {login, code, password(8자 이상)} → 201 로그인과 같은 모양 + 같은 refresh 쿠키.
//     403 SIGNUP_NOT_ALLOWED(모르는 아이디·틀린 초대 코드·닫힌 칸을 한 문장으로) · 409 SIGNUP_EXISTS · 400 입력 모양
//     가입하면 서버가 그 칸의 환경을 회사에 미리 만들어 둔다. 화면은 로그인 성공과 같은 길(accept)로 들어가 환경 화면을 연다
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

/** GET /auth/signup/config */
export interface SignupConfig { enabled: boolean }
/** POST /auth/signup 본문 */
export interface SignupBody { login: string; code: string; password: string }
/** 가입 화면의 입력칸 그대로 (비밀번호 확인 포함) */
export interface SignupForm { login: string; code: string; password: string; confirm: string }

// 서버 계약(POST /auth/signup password min 8)과 같은 하한. 상한은 로그인과 같은 서버 PASSWORD_MAX(apps/api auth/password.ts)
export const SIGNUP_PASSWORD_MIN = 8;
export const SIGNUP_PASSWORD_MAX = 256;

/** 보내기 전에 화면에서 거르는 것. 문제 없으면 null, 있으면 먼저 고칠 한 문장 */
export function signupFormError(f: SignupForm): string | null {
  if (!f.login.trim() || !f.code.trim() || !f.password || !f.confirm) return t('아이디, 초대 코드, 비밀번호를 모두 입력해 주세요.');
  if (f.password.length < SIGNUP_PASSWORD_MIN) return t('비밀번호는 {0}자 이상이어야 합니다.', { 0: SIGNUP_PASSWORD_MIN });
  if (f.password.length > SIGNUP_PASSWORD_MAX) return t('비밀번호는 {0}자를 넘을 수 없습니다.', { 0: SIGNUP_PASSWORD_MAX });
  if (f.password !== f.confirm) return t('비밀번호와 비밀번호 확인이 다릅니다.');
  return null;
}

/** 입력칸 → 서버 본문. 아이디·초대 코드는 앞뒤 공백을 떼고, 비밀번호는 그대로 보낸다 */
export const signupBody = (f: SignupForm): SignupBody => ({ login: f.login.trim(), code: f.code.trim(), password: f.password });

/**
 * 가입 실패 코드 → 사람 말. 403 은 아이디·초대 코드·닫힌 칸을 가리지 않는다 (서버가 어느 쪽이 틀렸는지 알려 주지 않는다).
 * 모르는 코드는 지어내지 않고 실패와 HTTP 상태만 말한다
 */
export function signupErrorText(status: number, code?: string): string {
  if (code === "SIGNUP_NOT_ALLOWED") return t('아이디나 초대 코드가 맞지 않습니다.');
  if (code === "SIGNUP_EXISTS") return t('이미 가입된 아이디입니다. 로그인하세요.');
  if (status === 429) return t('시도가 너무 많습니다. 잠시 뒤 다시 시도해 주세요.');
  return t('가입하지 못했습니다 (HTTP {0})', { 0: status });
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
    // 가입 성공(201)은 로그인과 같은 응답·같은 쿠키라 login 과 같은 accept 로 들어간다. 비밀번호·초대 코드는 오류에도 싣지 않는다
    async signup(body: SignupBody): Promise<void> {
      const res = await post("signup", body);
      if (!res.ok) {
        let b: { code?: string } = {};
        try { b = await res.json() as typeof b; } catch { /* JSON 아님 */ }
        throw new AuthError(res.status, b.code ?? `HTTP_${res.status}`, signupErrorText(res.status, b.code));
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
    // 로그인 화면의 "회원가입"을 띄울지. 404 는 가입 경로가 아직 없는 예전 서버라 꺼짐으로 본다.
    // DRAFT(ai): 그 밖의 실패(네트워크·5xx)는 null = 모름 → 화면은 GitHub 버튼처럼 띄우지 않는다. 로그인 자체가 같은 서버라 그쪽에서 실패가 보인다
    async signupConfig(): Promise<SignupConfig | null> {
      try {
        const res = await doFetch(`${o.base}/auth/signup/config`, { method: "GET", credentials: "same-origin" });
        if (res.status === 404) return { enabled: false };
        if (!res.ok) return null;
        const b = await res.json() as Partial<SignupConfig>;
        return { enabled: b.enabled === true };
      } catch { return null; }
    },
    get: () => state,
    subscribe(f: () => void) { subs.add(f); return () => { subs.delete(f); }; },
  };
}

export type Auth = ReturnType<typeof createAuth>;
