import { expect, test, type Page, type Route } from "@playwright/test";

// Z96: 로그인 화면 e2e 1개.
//   두 가지로 돈다
//   - 기본: /api/auth/* 를 이 시험이 흉내 낸다(서버가 DEV_AUTH=1 이어도 됨). 다른 /api 요청은
//     Bearer 가 맞으면 x-dev-tenant 를 붙여 진짜 서버로 넘기고, 없거나 틀리면 401 → 화면 흐름(401 → refresh → 로그인)을 본다
//   - E2E_LOGIN_REAL=1: 가로채지 않고 진짜 Z93 서버로(로그인 필수 서버 + 데모 계정). 비번은 E2E_LOGIN_PASSWORD (.env 에서만)
//   흐름: 첫 화면 = 로그인 → 틀린 비번 오류 → 맞는 비번 → 콘솔(머리 줄 사용자) → 새로 고침해도 로그인 유지(쿠키 refresh) → 로그아웃 → 로그인 화면
const REAL = process.env.E2E_LOGIN_REAL === "1";
const EMAIL = process.env.E2E_LOGIN_EMAIL ?? "demo@dev-company.test";
const PASSWORD = process.env.E2E_LOGIN_PASSWORD ?? "e2e-only-password";
const TENANT = "11111111-1111-4111-8111-111111111111";

async function fakeAuthServer(page: Page) {
  let n = 0;
  let live: string | null = null;    // 지금 유효한 access 토큰
  let cookie = false;                // refresh 쿠키가 살아 있나 (실제로는 HttpOnly 쿠키, 여기선 서버 쪽 상태로 흉내)
  const seen = { bearer: 0, devHeader: 0, unauth: 0 };
  const user = { id: "e2e-user", email: EMAIL, displayName: "데모 사용자", tenantId: TENANT, tenantName: "개발 회사" };
  const issue = () => { live = `e2e-token-${++n}`; cookie = true; return { accessToken: live, tokenType: "Bearer", expiresIn: 900, user }; };
  const json = (route: Route, status: number, body?: unknown) =>
    route.fulfill({ status, contentType: "application/json", body: body === undefined ? "" : JSON.stringify(body) });

  await page.route("**/api/**", async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (path === "/api/auth/config") return json(route, 200, { devAuth: false, loginRequired: true });
    if (path === "/api/auth/refresh") return cookie ? json(route, 200, issue()) : json(route, 401, { code: "REFRESH_INVALID", message: "no session" });
    if (path === "/api/auth/login") {
      const b = req.postDataJSON() as { email?: string; password?: string };
      return b.email === EMAIL && b.password === PASSWORD ? json(route, 200, issue())
        : json(route, 401, { code: "INVALID_CREDENTIALS", message: "bad" });
    }
    if (path === "/api/auth/logout") { live = null; cookie = false; return route.fulfill({ status: 204 }); }
    if (path === "/api/healthz" || path === "/api/readyz") return route.continue();
    const h = req.headers();
    if (h["x-dev-tenant"]) seen.devHeader++;
    if (!live || h.authorization !== `Bearer ${live}`) { seen.unauth++; return json(route, 401, { code: "UNAUTHENTICATED", message: "login" }); }
    seen.bearer++;
    // 진짜 서버(DEV_AUTH=1)는 x-dev-tenant 로 답한다 → 토큰의 회사로 바꿔 넘긴다
    const headers = { ...h, "x-dev-tenant": TENANT };
    delete headers.authorization;
    return route.continue({ headers });
  });
  return { seen, expire: () => { live = null; } };
}

test("로그인 → 콘솔 → 새로 고침 유지 → 토큰 만료 401 자동 refresh → 로그아웃", async ({ page }) => {
  const fake = REAL ? null : await fakeAuthServer(page);

  await page.goto("/?reset=1");
  const form = page.getByTestId("login-form");
  await expect(form).toBeVisible();
  await expect(page.getByLabel("이메일")).toBeFocused();

  // 틀린 비번
  await page.getByLabel("이메일").fill(EMAIL);
  await page.getByLabel("비밀번호").fill("wrong-password");
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  await expect(page.getByTestId("login-error")).toContainText("맞지 않아");

  // 맞는 비번
  await page.getByLabel("비밀번호").fill(PASSWORD);
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  await expect(page.getByTestId("auth-user")).toBeVisible();
  await expect(page.getByTestId("auth-user")).toContainText(REAL ? EMAIL.split("@")[0]! : "데모 사용자");
  await expect(page.getByRole("heading", { name: "이전 콘솔" })).toBeVisible();
  await expect(page.locator("label.tenant input")).toHaveCount(0); // 로그인하면 회사 번호 칸이 없다
  await expect(page.getByText("API 연결됨")).toBeVisible();

  // 토큰은 브라우저 저장소에 없다(메모리에만)
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
  expect(stored).not.toMatch(/e2e-token|eyJ/);

  // 새로 고침 → 로그인 화면 없이 그대로 (refresh 쿠키)
  await page.reload();
  await expect(page.getByTestId("auth-user")).toBeVisible();
  await expect(form).toHaveCount(0);

  if (fake) {
    // 서버가 토큰을 버림 → 다음 요청 401 → 화면이 refresh 한 번 → 같은 요청 다시 → 화면은 그대로
    const before = fake.seen.unauth;
    fake.expire();
    await expect.poll(() => fake.seen.unauth, { timeout: 15_000 }).toBeGreaterThan(before);
    await expect(page.getByTestId("auth-user")).toBeVisible();
    await expect(form).toHaveCount(0);
    expect(fake.seen.bearer).toBeGreaterThan(0);
    expect(fake.seen.devHeader).toBe(0); // 로그인 모드에선 개발 헤더를 안 보낸다
  }

  // 로그아웃 → 로그인 화면, 새로 고침해도 로그인 화면
  await page.getByTestId("logout").click();
  await expect(form).toBeVisible();
  await page.reload();
  await expect(form).toBeVisible();
});
