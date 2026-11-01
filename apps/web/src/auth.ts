// Z96: 로그인 상태 한 곳. Vite(import.meta.env)를 안 쓰는 순수 모듈이라 node:test 로 바로 시험한다 (test/auth.test.ts)
//
// 서버 계약 (Z93, apps/api auth 경로. 화면 기준 /api/auth/* → 프록시 → /api/v1/auth/*)
//   POST /auth/login   {email, password} → 200 {accessToken, tokenType, expiresIn, user} + Set-Cookie(refresh, HttpOnly)
//   POST /auth/refresh 본문 없음, 쿠키로      → 200 같은 모양(refresh 회전) / 401
//   POST /auth/logout                         → 204, 쿠키 지움
//   GET  /auth/config (인증 불필요)            → {devAuth, loginRequired}
//   GET  /auth/me (Bearer)                     → user
//   모드: config.loginRequired → refresh 시도, 실패하면 로그인 화면 ("jwt")
//         config.devAuth 이고 살아 있는 로그인(쿠키)이 없으면 → 예전처럼 x-dev-tenant 헤더로 ("dev")
//         config 가 404(옛 서버) → "dev". Bearer 가 있으면 서버는 토큰을 먼저 본다(Z93)
//   쿠키 svc_refresh: HttpOnly, SameSite=Strict, Path=/api (화면은 /api/auth/… 로 부르고 프록시가 /api/v1 로 바꾼다)
//
// 토큰 보관 (근거는 parallel/Z96/CHANGES.md §2)
//   - access 토큰: 이 모듈 변수(메모리)에만. localStorage·sessionStorage 에 안 둔다 → XSS 한 번으로 토큰이 밖으로 새지 않는다
//   - refresh 토큰: 서버가 HttpOnly 쿠키로. JS 가 못 읽는다. 새로 고침하면 /auth/refresh 로 access 를 다시 받는다
//   - 같은 출처(Vite 프록시·nginx /api)라 credentials: "same-origin" 으로 쿠키가 따라간다. CORS 설정이 필요 없다

export type AuthMode = "unknown" | "dev" | "jwt";

export interface AuthUser { id: string; email: string; displayName?: string | null; tenantId: string; tenantName?: string | null }
export interface AuthConfig { devAuth: boolean; loginRequired: boolean }
export interface TokenResponse { accessToken: string; tokenType?: string; expiresIn: number; user: AuthUser }

export interface AuthState {
  mode: AuthMode;
  user: AuthUser | null;
  // jwt 모드인데 토큰이 없으면 로그인 화면
  needLogin: boolean;
  // 로그인 화면에 보여 줄 한 줄 (세션 만료 등)
  notice: string | null;
  // 서버가 DEV_AUTH=1 이라 로그인 없이(x-dev-tenant) 계속할 수 있음
  devAuth: boolean;
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

export function createAuth(o: AuthOptions) {
  const doFetch = o.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const now = o.now ?? (() => Date.now());
  let token: string | null = null;
  let expiresAt = 0;
  let state: AuthState = { mode: "unknown", user: null, needLogin: false, notice: null, devAuth: false };
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
    set({ mode: "jwt", user: t.user, needLogin: false, notice: null });
  }
  function drop(notice: string | null) {
    token = null; expiresAt = 0;
    set({ mode: "jwt", user: null, needLogin: true, notice });
  }

  // refresh 는 동시에 여러 요청이 401 을 맞아도 한 번만 보낸다 (refresh 토큰 회전이라 두 번 보내면 두 번째가 실패한다)
  let inflight: Promise<boolean> | null = null;
  let devAuth = false; // 서버 config.devAuth (로그인 없이 x-dev-tenant 로 쓸 수 있는 서버)
  function refresh(): Promise<boolean> {
    if (state.mode === "dev") return Promise.resolve(false);
    inflight ??= (async () => {
      try {
        const res = await post("refresh");
        if (res.status === 404) { set({ mode: "dev", needLogin: false }); return false; }
        if (!res.ok && state.mode === "unknown" && devAuth) { set({ mode: "dev", needLogin: false }); return false; }
        if (!res.ok) { drop(state.user ? "로그인이 끝났어. 다시 로그인해." : null); return false; }
        accept(await res.json() as TokenResponse);
        return true;
      } catch {
        // 네트워크 오류: 판단을 미룬다. 화면은 API 끊김 띠가 말한다. 아직 모르면 dev 로 돌려 예전 화면이 뜨게 한다
        if (state.mode === "unknown") set({ mode: "dev" });
        return false;
      } finally { inflight = null; }
    })();
    return inflight;
  }

  let booted: Promise<AuthState> | null = null;
  async function boot(): Promise<AuthState> {
    // /auth/config 가 200 이 아니면(옛 서버 404·옛 모의 API 401·네트워크 오류) 예전처럼 dev 로 연다.
    //   그 뒤 보호 경로가 401 을 주면(서버가 로그인 필수였음) onUnauthorized 가 로그인 화면으로 바꾼다
    try {
      const res = await doFetch(`${o.base}/auth/config`, { credentials: "same-origin" });
      if (!res.ok) { set({ mode: "dev" }); return state; }
      const c = await res.json() as AuthConfig;
      devAuth = c.devAuth === true && c.loginRequired !== true;
      set({ devAuth });
    } catch { set({ mode: "dev" }); return state; }
    await refresh();
    return state;
  }

  return {
    // 첫 화면 전에 한 번: 쿠키가 살아 있으면 로그인 없이 들어간다.
    // 한 번만 (StrictMode 가 effect 를 두 번 돌려도 refresh 회전이 두 번 나가지 않게)
    bootstrap(): Promise<AuthState> { return (booted ??= boot()); },
    // dev 모드 화면에서 "로그인" 을 누르면 로그인 화면으로 (devAuth 서버에서도 실제 계정으로 들어가 볼 수 있게)
    continueDev() { if (devAuth) { token = null; set({ mode: "dev", user: null, needLogin: false, notice: null }); } },
    askLogin() { token = null; set({ mode: "jwt", user: null, needLogin: true, notice: null }); },
    async login(email: string, password: string): Promise<void> {
      const res = await post("login", { email, password });
      if (res.status === 404) { set({ mode: "dev", needLogin: false }); return; }
      if (!res.ok) {
        let b: { code?: string; message?: string } = {};
        try { b = await res.json() as typeof b; } catch { /* JSON 아님 */ }
        throw new AuthError(res.status, b.code ?? `HTTP_${res.status}`,
          res.status === 401 ? "이메일이나 비밀번호가 맞지 않아." : res.status === 429 ? "시도가 너무 많아. 잠시 뒤 다시 해." : (b.message ?? `로그인 실패 (HTTP ${res.status})`));
      }
      accept(await res.json() as TokenResponse);
    },
    async logout(): Promise<void> {
      try { await post("logout"); } catch { /* 서버가 없어도 화면은 로그아웃 */ }
      drop(null);
    },
    // http.ts 가 요청마다 부른다. 곧 만료면 먼저 refresh
    async accessToken(): Promise<string | null> {
      if (state.mode !== "jwt") return null;
      if (token && now() < expiresAt - EARLY_REFRESH_SEC * 1000) return token;
      if (token || !state.needLogin) await refresh();
      return token;
    },
    // 보호 경로가 401 → refresh 한 번. 성공하면 true (요청을 한 번 더 보낸다), 실패하면 로그인 화면
    async onUnauthorized(): Promise<boolean> {
      // 개발 헤더로 돌았는데 401: 서버가 로그인 필수로 바뀌었다(또는 첫 확인 때 서버가 꺼져 있었다) → 로그인 화면
      if (state.mode === "dev") { if (!devAuth) drop(null); return false; }
      if (state.mode !== "jwt") return false;
      token = null;
      return refresh();
    },
    get: () => state,
    subscribe(f: () => void) { subs.add(f); return () => { subs.delete(f); }; },
  };
}

export type Auth = ReturnType<typeof createAuth>;
