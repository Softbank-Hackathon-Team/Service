import { expect, test, OTHER_TENANT, SEED, confirmSpec, createMigration, expectStatus, openConsole, shot } from "./helpers";

// 콘티: S3 "승인 전 실행은 409" (계획서와 지문 장면의 배경 주장)
test.describe("승인 없이 시작", () => {
  test("승인 대기에서는 실행 시작 버튼이 없고, 서버도 409로 막는다", async ({ page }, info) => {
    await openConsole(page);
    const id = await createMigration(page);
    await confirmSpec(page);
    await expectStatus(page, "awaiting_approval");

    await expect(page.getByRole("button", { name: /실행 시작/ })).toHaveCount(0);

    // 화면을 우회해 같은 프록시 경로로 직접 부른다
    const res = await page.request.post(`/api/migrations/${id}/start`, {
      headers: { "x-dev-tenant": SEED.tenant, "idempotency-key": crypto.randomUUID() },
    });
    expect(res.status()).toBe(409);
    expect(await res.json()).toMatchObject({ code: "INVALID_TRANSITION" });
    await expectStatus(page, "awaiting_approval");
  });

  test("화면이 낡아 승인됨으로 보일 때 시작을 누르면 서버 오류가 화면에 뜬다", async ({ page, routes }, info) => {
    await openConsole(page);
    const id = await createMigration(page);
    await confirmSpec(page);
    await expectStatus(page, "awaiting_approval");

    // 다른 사람이 아직 승인 안 했는데 이 화면만 "승인됨"으로 보이는 경우(폴링 사이 낡은 화면)를 흉내 낸다:
    // 상세 GET 응답의 status만 approved로 바꾼다. 시작 POST는 진짜 서버로 간다
    await routes.add(`**/api/migrations/${id}`, async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      const res = await route.fetch();
      const body = await res.json();
      await route.fulfill({ response: res, json: { ...body, status: "approved" } });
    });
    await expectStatus(page, "approved");

    await page.getByRole("button", { name: /실행 시작/ }).click();
    const err = page.locator(".actions + .error");
    await expect(err).toContainText("409 INVALID_TRANSITION");
    await expect(err).toContainText("awaiting_approval -> provisioning");
    await shot(page, info, "05-start-without-approval");

    await routes.remove(`**/api/migrations/${id}`);
    await expectStatus(page, "awaiting_approval");
  });
});

// 콘티: S6 컷 2 회사 벽을 화면 쪽에서 (터미널 demo.sh wall 은 storyboard.spec S6 컷 2)
test.describe("다른 회사 환경", () => {
  test("회사 번호를 바꾸면 환경이 안 보이고, 남은 선택으로 만들면 404로 거부된다", async ({ page }, info) => {
    await openConsole(page);

    // 우리 회사 환경을 직접 고른다(선택값이 상태에 남는다)
    const selects = page.locator(".form select");
    await selects.nth(0).selectOption(SEED.aws);
    await selects.nth(1).selectOption(SEED.gcp);

    const tenantInput = page.getByLabel(/회사 번호/);
    await tenantInput.fill(OTHER_TENANT);

    // 다른 회사에선 seed 환경이 RLS로 가려진다
    await expect(page.locator(".side .card").first().getByText("환경 없음")).toBeVisible();

    // Y: 화면은 이 회사에 안 보이는 선택값을 버린다 → 만들기 버튼이 꺼진다. 서버도 거부하는지는 아래에서 직접 확인
    await expect(page.getByRole("button", { name: "새 이전 만들기" })).toBeDisabled();
    await shot(page, info, "06-other-tenant");

    const res = await page.request.post("/api/migrations", {
      headers: { "x-dev-tenant": OTHER_TENANT, "idempotency-key": crypto.randomUUID() },
      data: { sourceEnvId: SEED.aws, targetEnvId: SEED.gcp },
    });
    expect(res.status()).toBe(404);
    expect(await res.json()).toMatchObject({ code: "NOT_FOUND" });
  });

  test("다른 회사로 바꾸면 우리 회사 이전 상세를 읽지 못한다", async ({ page }) => {
    await openConsole(page);
    const id = await createMigration(page);
    await expectStatus(page, "spec_review");

    await page.getByLabel(/회사 번호/).fill(OTHER_TENANT);
    await expect(page.locator(".main .error").first()).toContainText("404 NOT_FOUND", { timeout: 10_000 });
    await expect(page.locator(".mlist")).not.toContainText(id.slice(0, 8));
  });
});
