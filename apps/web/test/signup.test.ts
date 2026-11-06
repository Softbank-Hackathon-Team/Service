import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AuthError, createAuth, SIGNUP_PASSWORD_MAX, SIGNUP_PASSWORD_MIN, signupBody, signupErrorText, signupFormError, type SignupForm,
} from "../src/lib/auth";

// 팀 가입: GET /auth/signup/config 로 "회원가입"을 띄울지, POST /auth/signup 성공이면 로그인과 같은 길로 들어가는지,
// 화면 검사(빈칸·8자·확인 일치)와 실패 코드 문장을 브라우저 없이 본다

type Reply = { status: number; body?: unknown; raw?: string };
type Call = { url: string; init: RequestInit };
const USER = { id: "u1", email: "member@team.test", displayName: null, tenantId: "11111111-1111-4111-8111-111111111111", tenantName: "team" };
const TOKEN = { accessToken: "t1", tokenType: "Bearer", expiresIn: 900, user: USER };

function server(routes: Record<string, Reply[] | Error>) {
  const calls: Call[] = [];
  const f = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    const q = routes[`${init.method ?? "GET"} ${url}`];
    if (q instanceof Error) throw q;
    if (!q) return new Response(null, { status: 404 });
    const r = q.length > 1 ? q.shift()! : q[0]!;
    return new Response(r.raw ?? (r.body === undefined ? null : JSON.stringify(r.body)), { status: r.status });
  }) as unknown as typeof fetch;
  return { f, calls };
}

const FORM: SignupForm = { login: "member-1", code: "invite-abc", password: "long-enough", confirm: "long-enough" };

test("가입 설정: 서버가 켜 두면 enabled, 404(가입 경로가 없는 예전 서버)는 꺼짐", async () => {
  const on = server({ "GET /api/auth/signup/config": [{ status: 200, body: { enabled: true } }] });
  assert.deepEqual(await createAuth({ base: "/api", fetch: on.f }).signupConfig(), { enabled: true });
  assert.equal(on.calls[0]!.init.credentials, "same-origin");
  assert.equal((on.calls[0]!.init.headers as Record<string, string> | undefined)?.authorization, undefined, "인증 없이 읽는다");

  const old = server({});
  assert.deepEqual(await createAuth({ base: "/api", fetch: old.f }).signupConfig(), { enabled: false });
  assert.equal(old.calls[0]!.url, "/api/auth/signup/config");

  const off = server({ "GET /api/auth/signup/config": [{ status: 200, body: { enabled: false } }] });
  assert.deepEqual(await createAuth({ base: "/api", fetch: off.f }).signupConfig(), { enabled: false });
  // true 가 아닌 값은 켜짐으로 보지 않는다
  const odd = server({ "GET /api/auth/signup/config": [{ status: 200, body: { enabled: "yes" } }] });
  assert.deepEqual(await createAuth({ base: "/api", fetch: odd.f }).signupConfig(), { enabled: false });
});

test("가입 설정: 5xx·네트워크 오류는 null(모름) — 화면은 버튼을 띄우지 않는다", async () => {
  const down = server({ "GET /api/auth/signup/config": [{ status: 503, body: { code: "X" } }] });
  assert.equal(await createAuth({ base: "/api", fetch: down.f }).signupConfig(), null);
  const net = server({ "GET /api/auth/signup/config": new TypeError("fetch failed") });
  assert.equal(await createAuth({ base: "/api", fetch: net.f }).signupConfig(), null);
});

test("가입 성공(201) → 로그인과 같은 길: 토큰·사용자가 들어가고 refresh 는 부르지 않는다", async () => {
  const s = server({ "POST /api/auth/signup": [{ status: 201, body: TOKEN }] });
  const a = createAuth({ base: "/api", fetch: s.f });
  const seen: (string | null)[] = [];
  a.subscribe(() => seen.push(a.get().user?.id ?? null));
  await a.signup(signupBody({ ...FORM, login: "  member-1 ", code: " invite-abc\n" }));
  assert.equal(a.get().ready, true);
  assert.equal(a.get().user?.tenantId, USER.tenantId);
  assert.equal(a.get().notice, null);
  assert.equal(await a.accessToken(), "t1");
  assert.deepEqual(seen, ["u1"], "구독자(App)가 콘솔로 바뀐 것을 한 번 받는다");
  const call = s.calls.find((c) => c.url === "/api/auth/signup")!;
  assert.equal(call.init.method, "POST");
  assert.equal(call.init.credentials, "same-origin", "refresh 쿠키를 받으려면 같은 출처 쿠키가 따라가야 한다");
  assert.deepEqual(JSON.parse(String(call.init.body)), { login: "member-1", code: "invite-abc", password: "long-enough" });
  assert.equal(s.calls.filter((c) => c.url === "/api/auth/refresh").length, 0);
});

test("가입 실패: 403·409 는 코드별 문장, 나머지는 HTTP 상태만. 사용자는 그대로 비어 있고 비밀번호·초대 코드는 문장에 안 실린다", async () => {
  const s = server({
    "POST /api/auth/signup": [
      { status: 403, body: { code: "SIGNUP_NOT_ALLOWED", message: "signup not allowed" } },
      { status: 409, body: { code: "SIGNUP_EXISTS", message: "exists" } },
      { status: 400, body: { code: "BAD_REQUEST", message: "body/password too short" } },
      { status: 502, raw: "<html>bad gateway</html>" },
    ],
  });
  const a = createAuth({ base: "/api", fetch: s.f });
  const body = signupBody(FORM);
  const fails = (code: string, status: number, text: RegExp) => (e: unknown) =>
    e instanceof AuthError && e.code === code && e.status === status && text.test(e.message)
    && !e.message.includes(FORM.password) && !e.message.includes(FORM.code);
  await assert.rejects(a.signup(body), fails("SIGNUP_NOT_ALLOWED", 403, /아이디나 초대 코드가 맞지 않습니다/));
  await assert.rejects(a.signup(body), fails("SIGNUP_EXISTS", 409, /이미 가입된 아이디입니다. 로그인하세요/));
  await assert.rejects(a.signup(body), fails("BAD_REQUEST", 400, /가입하지 못했습니다 \(HTTP 400\)/));
  await assert.rejects(a.signup(body), fails("HTTP_502", 502, /가입하지 못했습니다 \(HTTP 502\)/));
  assert.equal(a.get().user, null);
  assert.equal(await a.accessToken(), null);
});

test("가입 실패 문장: 코드가 먼저, 모르는 코드는 지어내지 않는다", () => {
  assert.equal(signupErrorText(403, "SIGNUP_NOT_ALLOWED"), "아이디나 초대 코드가 맞지 않습니다.");
  assert.equal(signupErrorText(409, "SIGNUP_EXISTS"), "이미 가입된 아이디입니다. 로그인하세요.");
  assert.equal(signupErrorText(429, "TOO_MANY_ATTEMPTS"), "시도가 너무 많습니다. 잠시 뒤 다시 시도해 주세요.");
  // 같은 409 라도 다른 코드(RETRY 등)를 "이미 가입"으로 말하지 않는다
  assert.equal(signupErrorText(409, "RETRY"), "가입하지 못했습니다 (HTTP 409)");
  assert.equal(signupErrorText(403), "가입하지 못했습니다 (HTTP 403)");
  assert.equal(signupErrorText(500, "INTERNAL"), "가입하지 못했습니다 (HTTP 500)");
});

test("가입 화면 검사: 빈칸 → 비밀번호 길이 → 확인 일치 순서, 통과하면 null", () => {
  assert.match(signupFormError({ ...FORM, login: "   " })!, /모두 입력/);
  assert.match(signupFormError({ ...FORM, code: "" })!, /모두 입력/);
  assert.match(signupFormError({ ...FORM, password: "", confirm: "" })!, /모두 입력/);
  assert.match(signupFormError({ ...FORM, confirm: "" })!, /모두 입력/);
  const short = "x".repeat(SIGNUP_PASSWORD_MIN - 1);
  assert.equal(signupFormError({ ...FORM, password: short, confirm: short }), `비밀번호는 ${SIGNUP_PASSWORD_MIN}자 이상이어야 합니다.`);
  // 짧은 비밀번호는 확인이 달라도 길이부터 말한다 (먼저 고칠 것 하나)
  assert.match(signupFormError({ ...FORM, password: short, confirm: "other" })!, /자 이상/);
  const long = "x".repeat(SIGNUP_PASSWORD_MAX + 1);
  assert.match(signupFormError({ ...FORM, password: long, confirm: long })!, /넘을 수 없습니다/);
  assert.equal(signupFormError({ ...FORM, confirm: "long-enougH" }), "비밀번호와 비밀번호 확인이 다릅니다.");
  const exact = "x".repeat(SIGNUP_PASSWORD_MIN);
  assert.equal(signupFormError({ ...FORM, password: exact, confirm: exact }), null, "딱 8자는 통과");
  assert.equal(signupFormError(FORM), null);
});

test("가입 본문: 아이디·초대 코드는 앞뒤 공백만 떼고, 비밀번호는 손대지 않는다", () => {
  assert.deepEqual(signupBody({ login: " a ", code: "\tc ", password: " p w ", confirm: " p w " }), { login: "a", code: "c", password: " p w " });
});
