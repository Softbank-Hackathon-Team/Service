import { expect, test, SEED, confirmSpec, createMigration, expectStatus, openConsole } from "./helpers";

// Y(웹 UX 다듬기)에서 바꾼 화면 동작. 번호는 parallel/S/CHANGES.md 의 UX 문제 번호

// 콘티: S0/T-2:00 시작 전 상태 (첫 화면 로딩)
test("6·14 첫 응답 전에는 빈 상태 문구 대신 로딩 표시", async ({ page, routes }) => {
  await routes.add(/\/api\/(environments|migrations)(\?|$)/, async (r) => {
    await new Promise((ok) => setTimeout(ok, 2000));
    await r.fallback();
  });
  await page.goto("/");
  await expect(page.locator(".side .loading").first()).toBeVisible();
  await expect(page.getByText("환경 없음")).toHaveCount(0);
  await expect(page.getByText("아직 이전이 없어.")).toHaveCount(0);
  await expect(page.locator(".side .card").first().locator("tbody tr").first()).toContainText("dev-aws", { timeout: 10_000 });
});

// 콘티: S6 컷 2 앞 — 회사 번호를 고치는 동안 오류 화면이 안 뜬다
test("4 회사 번호를 치는 중에는 요청을 안 보낸다 (5xx 0개)", async ({ page }) => {
  await openConsole(page);
  const sent: string[] = [];
  page.on("request", (r) => { if (r.url().includes("/api/")) sent.push(r.headers()["x-dev-tenant"] ?? ""); });
  const input = page.getByLabel(/회사 번호/);
  await input.fill("");
  await input.pressSequentially("1111", { delay: 80 });
  await expect(page.locator(".tenant-hint")).toBeVisible();
  await page.waitForTimeout(1500);
  expect(sent.filter((t) => t !== SEED.tenant), `보낸 회사 번호: ${[...new Set(sent)].join(",")}`).toEqual([]);
  await expect(page.locator(".error")).toHaveCount(0);
  await input.fill(SEED.tenant);
  await expect(page.locator(".tenant-hint")).toHaveCount(0);
});

// 콘티: S1 출발·도착 고르기
test("10 출발과 도착이 같으면 만들기 버튼이 꺼진다", async ({ page }) => {
  await openConsole(page);
  const selects = page.locator(".form select");
  await selects.nth(0).selectOption(SEED.aws);
  await selects.nth(1).selectOption(SEED.aws);
  await expect(page.getByRole("button", { name: "새 이전 만들기" })).toBeDisabled();
  await expect(page.locator(".form .note")).toContainText("출발과 도착이 같아");
  await selects.nth(1).selectOption(SEED.gcp);
  await expect(page.getByRole("button", { name: "새 이전 만들기" })).toBeEnabled();
});

// 콘티: S1·S3 버튼 뒤 한국어 한 줄
test("8·9 버튼 뒤 JSON 대신 한국어 한 줄, 승인 전엔 이유 안내", async ({ page }) => {
  await openConsole(page);
  await createMigration(page);
  await confirmSpec(page);
  await expectStatus(page, "awaiting_approval");
  await expect(page.locator(".main")).not.toContainText('{"id"');
  await expect(page.locator(".actions .why")).toContainText("승인해야");
});

// 콘티: S4 끝(완료 화면)·S8 직전
test("12 끝난 이전은 상세를 다시 읽지 않는다", async ({ page }) => {
  await openConsole(page);
  const id = await createMigration(page);
  await confirmSpec(page);
  await expectStatus(page, "awaiting_approval");
  await page.getByRole("button", { name: "승인", exact: true }).click();
  await expectStatus(page, "approved");
  await page.getByRole("button", { name: /실행 시작/ }).click();
  await expectStatus(page, "completed", 45_000);
  await expect(page.getByText("자동 새로고침 멈춤")).toBeVisible();

  let polls = 0;
  page.on("request", (r) => { if (r.method() === "GET" && r.url().endsWith(`/api/migrations/${id}`)) polls++; });
  await page.waitForTimeout(4000);
  expect(polls).toBe(0);
});

// 콘티: S6 컷 2 회사 벽(화면)
test("5 다른 회사로 바꾸면 옛 상세(상태 칩·진행 칸)를 지우고 안내만 남긴다", async ({ page }) => {
  await openConsole(page);
  await createMigration(page);
  await expectStatus(page, "spec_review");
  await page.getByLabel(/회사 번호/).fill("99999999-9999-4999-8999-999999999999");
  await expect(page.locator(".main .error").first()).toContainText("404 NOT_FOUND", { timeout: 10_000 });
  await expect(page.locator(".dhead .chip")).toHaveCount(0);
  await expect(page.locator(".stepper")).toHaveCount(0);
  await page.getByRole("button", { name: "선택 해제" }).click();
  await expect(page.getByText("왼쪽에서 이전을 고르거나 새로 만들어.")).toBeVisible();
  await page.getByLabel(/회사 번호/).fill(SEED.tenant);
});
