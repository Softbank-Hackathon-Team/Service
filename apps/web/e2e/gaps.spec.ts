import { expect, test, OTHER_TENANT, SEED, confirmSpec, createMigration, expectStatus, openConsole, shot } from "./helpers";
import type { Page, Route } from "@playwright/test";

// Z104: 기능 명세 40행 대비 e2e 공백 메우기 (parallel/Z104/E2E-GAP.md 우선순위 1·2·7 + 로그인 모드 화면 전체)
//   #13 계획 거절 · #36 같은 요청 두 번(멱등 키) · #30 증적 리포트 · 로그인 모드에서 모든 페이지가 Bearer 로만 부르는지(Z101)

const H = { "x-dev-tenant": SEED.tenant };
const key = () => crypto.randomUUID();

async function toAwaitingApproval(page: Page): Promise<string> {
  await openConsole(page);
  const id = await createMigration(page);
  await confirmSpec(page);
  await expectStatus(page, "awaiting_approval");
  return id;
}

async function cancelIfOpen(page: Page, id: string) {
  const r = await page.request.get(`/api/migrations/${id}`, { headers: H });
  if (!r.ok()) return;
  const s = (await r.json()).status as string;
  if (["completed", "rolled_back", "cancelled"].includes(s)) return;
  await page.request.post(`/api/migrations/${id}/cancel`, { headers: { ...H, "idempotency-key": key() }, data: {} });
}

test("#13 계획 거절: 거절 → rejected, 안내 문구, 실행 버튼 없음, 서버도 시작 409", async ({ page }, info) => {
  const id = await toAwaitingApproval(page);
  try {
    await page.getByRole("button", { name: "거절", exact: true }).click();
    await expectStatus(page, "rejected");
    await expect(page.getByText(/계획을 거절했어|거절했어\./).first()).toBeVisible();
    await expect(page.getByRole("button", { name: /실행 시작/ })).toHaveCount(0);
    const res = await page.request.post(`/api/migrations/${id}/start`, { headers: { ...H, "idempotency-key": key() } });
    expect(res.status()).toBe(409);
    // 감사: 거절 결정이 리포트 승인 줄에 남는다
    const rep = await (await page.request.get(`/api/migrations/${id}/report`, { headers: H })).json();
    expect(rep.approvals.some((a: { decision: string }) => a.decision === "reject")).toBe(true);
    await shot(page, info, "z104-13-rejected");
  } finally {
    await cancelIfOpen(page, id);
  }
});

test("#36 같은 키로 두 번 보내면 첫 응답 그대로(idempotent-replayed), 다른 본문이면 409 IDEMPOTENCY_KEY_REUSED", async ({ page }) => {
  const id = await toAwaitingApproval(page);
  const k = key();
  const body = { reason: "z104 멱등 확인" };
  const a = await page.request.post(`/api/migrations/${id}/cancel`, { headers: { ...H, "idempotency-key": k }, data: body });
  expect(a.status(), await a.text()).toBeLessThan(300);
  const b = await page.request.post(`/api/migrations/${id}/cancel`, { headers: { ...H, "idempotency-key": k }, data: body });
  expect(b.status()).toBe(a.status());
  expect(b.headers()["idempotent-replayed"]).toBe("true");
  expect(await b.text()).toBe(await a.text());
  const c = await page.request.post(`/api/migrations/${id}/cancel`, { headers: { ...H, "idempotency-key": k }, data: { reason: "다른 본문" } });
  expect(c.status()).toBe(409);
  expect((await c.json()).code).toBe("IDEMPOTENCY_KEY_REUSED");
  // 취소는 한 번만 일어났다: 상태 변화 줄에 cancelled 로 가는 줄이 하나
  const tl = await (await page.request.get(`/api/migrations/${id}/timeline`, { headers: H })).json();
  const items = (Array.isArray(tl) ? tl : tl.items ?? tl.events ?? []) as { to?: string; toStatus?: string }[];
  expect(items.filter((e) => (e.to ?? e.toStatus) === "cancelled").length).toBeLessThanOrEqual(1);
});

test("#30 증적 리포트: JSON 체인 검증·승인 지문 일치, 다른 회사 404, 화면 버튼으로 HTML 새 탭", async ({ page }) => {
  const id = await toAwaitingApproval(page);
  try {
    await page.getByRole("button", { name: "승인", exact: true }).click();
    await expectStatus(page, "approved");
    const r = await page.request.get(`/api/migrations/${id}/report`, { headers: H });
    expect(r.status()).toBe(200);
    expect(r.headers()["cache-control"]).toBe("no-store");
    const rep = await r.json();
    expect(rep.integrity.ok).toBe(true);
    expect(rep.reportHash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.headers()["x-report-hash"]).toBe(rep.reportHash);
    const ap = rep.approvals.find((a: { decision: string }) => a.decision === "approve");
    expect(ap?.hashMatches).toBe(true);
    expect(ap?.approvedPlanHash).toBe(ap?.storedPlanHash);

    const other = await page.request.get(`/api/migrations/${id}/report`, { headers: { "x-dev-tenant": OTHER_TENANT } });
    expect(other.status()).toBe(404);

    const [tab] = await Promise.all([
      page.context().waitForEvent("page"),
      page.getByRole("button", { name: "증적 리포트 열기" }).click(),
    ]);
    await tab.waitForLoadState();
    await expect(tab).toHaveTitle("이전 증적 리포트");
    await expect(tab.locator("body")).toContainText(id.slice(0, 8));
    await tab.close();
  } finally {
    await cancelIfOpen(page, id);
  }
});

// Z101 이 찾은 "로그인 토큰 없이 API 호출"이 다른 페이지에도 있는지: 로그인 모드에서 8개 페이지를 다 돌며
// /api 요청마다 Bearer 가 붙었는지, 개발 헤더(x-dev-tenant)가 하나도 안 나가는지 센다. 인증 서버는 login.spec 과 같은 흉내
test("로그인 모드: 8개 페이지 모두 Bearer 로만 부르고 x-dev-tenant 는 0건", async ({ page }) => {
  test.setTimeout(90_000);
  const TENANT = SEED.tenant;
  let live: string | null = null, n = 0;
  const bad: string[] = [];
  let bearer = 0;
  const user = { id: "e2e-user", email: "demo@dev-company.test", displayName: "데모 사용자", tenantId: TENANT, tenantName: "개발 회사" };
  const issue = () => { live = `e2e-z104-${++n}`; return { accessToken: live, tokenType: "Bearer", expiresIn: 900, user }; };
  const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  await page.route("**/api/**", async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (path === "/api/auth/config") return json(route, 200, { devAuth: false, loginRequired: true });
    if (path === "/api/auth/refresh") return live ? json(route, 200, issue()) : json(route, 401, { code: "REFRESH_INVALID", message: "no" });
    if (path === "/api/auth/login") return json(route, 200, issue());
    if (path === "/api/auth/logout") { live = null; return route.fulfill({ status: 204 }); }
    if (path === "/api/healthz" || path === "/api/readyz" || path.startsWith("/api/docs") || path.endsWith("openapi.json")) return route.continue();
    const h = req.headers();
    if (h["x-dev-tenant"] || h.authorization !== `Bearer ${live}`) { bad.push(`${req.method()} ${path} dev=${!!h["x-dev-tenant"]} auth=${h.authorization ? "다름" : "없음"}`); return json(route, 401, { code: "UNAUTHENTICATED", message: "login" }); }
    bearer++;
    const headers = { ...h, "x-dev-tenant": TENANT };
    delete headers.authorization;
    return route.continue({ headers });
  });

  await page.goto("/?reset=1");
  await page.getByLabel("이메일").fill(user.email);
  await page.getByLabel("비밀번호").fill("e2e-only-password");
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  await expect(page.getByTestId("auth-user")).toBeVisible();

  // 이전 하나를 골라 두면 이전별 페이지(환경·비용·모니터링·보안·AI)가 그 이전으로 부른다
  await page.getByRole("button", { name: "새 이전 만들기" }).click();
  await expect(page.locator(".dhead h2 code")).toBeVisible();
  const id = (await page.locator(".dhead h2 code").textContent())!.trim();

  for (const p of ["dashboard", "environments", "cost", "monitoring", "security", "agent", "docs", ""]) {
    await page.evaluate((h) => { location.hash = h; }, `#/${p}`);
    await expect(page.getByTestId("auth-user")).toBeVisible();
    await page.waitForTimeout(2000);   // 첫 요청 + 폴링 한 바퀴
  }
  // 증적 리포트(직접 fetch 하는 유일한 길, z104-05)도
  const rep = page.getByRole("button", { name: "증적 리포트 열기" });
  if (await rep.isVisible().catch(() => false)) {
    const opened = page.context().waitForEvent("page", { timeout: 5_000 }).catch(() => null);
    await rep.click();
    (await opened)?.close();
  }

  expect(bad, bad.join("\n")).toEqual([]);
  expect(bearer).toBeGreaterThan(5);
  await page.request.post(`/api/migrations/${id}/cancel`, { headers: { ...H, "idempotency-key": key() }, data: {} });
});
