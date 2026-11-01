import type { Route } from "@playwright/test";
import { expect, test, SEED, createMigration, openConsole } from "./helpers";

// Z101: 웹 콘솔에서 모의·고정값을 걷어낸 화면마다 1개 (parallel/Z101/MOCK-LIST.md 의 W 번호)

// W1·W2: 서버 목록이 실패하면 예전처럼 고정 환경 3개·브라우저 기억 목록을 꾸며 보여 주지 않고 오류를 보인다
test("W1·W2 환경·이전 목록 404 → 고정값 없이 오류 표시", async ({ page, routes }) => {
  const notFound = (r: Route) => r.fulfill({ status: 404, contentType: "application/json",
    body: JSON.stringify({ code: "NOT_FOUND", message: "e2e 404", requestId: "e2e" }) });
  await routes.add(/\/api\/environments(\?|$)/, notFound);
  await routes.add(/\/api\/migrations(\?|$)/, async (r) => (r.request().method() === "GET" ? notFound(r) : r.fallback()));
  await page.goto("/");
  await expect(page.getByText("API 연결됨")).toBeVisible();
  await expect(page.locator(".side .error").first()).toBeVisible();
  await expect(page.getByText("dev-aws")).toHaveCount(0);
  await expect(page.getByText("개발 seed 값을 보여 줘")).toHaveCount(0);
  await expect(page.getByText("이 브라우저에서 만든 이전만")).toHaveCount(0);
});

// W3·W4: 자원 대응표는 서버 GET /migrations/:id/plan/resources 값만 (예전 404 → 정적 표 대체 없음)
test("W3·W4 자원 대응표 = 서버 값 (환경 보기 이전 흐름)", async ({ page }) => {
  await openConsole(page);
  const selects = page.locator(".form select");
  await selects.nth(0).selectOption(SEED.aws);
  await selects.nth(1).selectOption(SEED.gcp);
  await createMigration(page);
  const resp = page.waitForResponse((r) => /\/api\/migrations\/[0-9a-f-]+\/plan\/resources$/.test(new URL(r.url()).pathname));
  await page.goto("/#/environments");
  expect((await resp).status()).toBe(200);
  const flow = page.locator("#env-flow");
  await expect(flow).toBeVisible();
  await expect(flow.locator("table").first()).toBeVisible();
  await expect(flow).not.toContainText("정적 표");
});

// W8: 비용 "조건 바꿔 보기"는 무슨 명세로 계산하는지 밝힌다. 이전을 고르면 그 이전의 명세(GET /migrations/:id/spec), 못 읽으면 이유
test("W8 비용 시뮬레이터 명세 줄: 고르기 전 예시, 고른 뒤 그 이전 명세 또는 못 읽은 이유", async ({ page }) => {
  await openConsole(page);
  const id = await createMigration(page);
  await page.goto("/#/cost");
  const line = page.getByTestId("sim-spec");
  await expect(line).toContainText("명세:");
  await page.evaluate((m) => { localStorage.setItem("web.selected", m); }, id);
  await page.reload();
  await page.goto("/#/cost");
  await expect(line).toContainText(/이전 [0-9a-f]{8} 의 명세|이 이전의 명세를 못 읽음/);
  await expect(page.locator("#cost-sim")).not.toContainText("명세는 데모 앱(demo-shop) 기준");
});

// W9: 대시보드·모니터링 환경 건강 — aws/gcp/onprem 도 "조회 미구현" 대신 실조회(inventory) 결과나 확인 불가 이유
test("W9 환경 건강: '조회 미구현' 없음, 실조회 결과 또는 이유", async ({ page }) => {
  await openConsole(page);
  const inv = page.waitForResponse((r) => /\/api\/environments\/[0-9a-f-]+\/inventory$/.test(new URL(r.url()).pathname));
  await page.goto("/#/monitoring");
  await inv;
  await expect(page.locator("#mon-envs")).toBeVisible();
  await expect(page.locator("#mon-envs")).not.toContainText("조회 미구현");
  await page.goto("/#/dashboard");
  const row = page.locator("#dash-env tbody tr", { hasText: "dev-aws" });
  await expect(row).toBeVisible();
  await expect(row.locator("td").nth(3)).not.toHaveText("확인 중…", { timeout: 20_000 });
  await expect(row.locator("td").nth(3)).not.toContainText("경로 없음");
});

// W10: 온프레 환경을 고르면 Agent 보고 칸 (Z92 GET /environments/:id/agent-reports). 보고가 없으면 없다고 쓴다
test("W10 온프레 Agent 보고 칸", async ({ page }) => {
  await page.addInitScript(() => { try { localStorage.setItem("web.tenant", "11111111-1111-4111-8111-111111111111"); } catch { /* 무시 */ } });
  const resp = page.waitForResponse((r) => /\/api\/environments\/[0-9a-f-]+\/agent-reports/.test(r.url()));
  await page.goto("/#/environments");
  await page.getByRole("tab", { name: /onprem/ }).click();
  const r = await resp;
  const card = page.getByTestId("agent-reports");
  await expect(card).toBeVisible();
  if (r.status() === 200) {
    const body = await r.json() as { items: unknown[]; lastHeartbeatAt: string | null };
    if (body.items.length === 0) await expect(card).toContainText("받은 보고가 없어");
    else await expect(card.locator("tbody tr")).toHaveCount(body.items.length);
  } else {
    await expect(card.locator(".error")).toBeVisible();
  }
});
