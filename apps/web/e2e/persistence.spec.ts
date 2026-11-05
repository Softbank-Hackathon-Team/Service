import { expect, test, confirmSpec, createMigration, currentMigrationId, expectStatus, openConsole, shot } from "./helpers";

// 콘티: S4 실패 시 대체 단계 1 "그 자리 재시도"(새로고침해도 무대 상태가 그대로)
test("새로고침해도 고른 이전과 상태가 그대로다", async ({ page }, info) => {
  await openConsole(page);
  const id = await createMigration(page);
  await confirmSpec(page);
  await expectStatus(page, "awaiting_approval");

  await page.reload();
  await expect(page.getByText("API 연결됨")).toBeVisible();
  expect(await currentMigrationId(page)).toBe(id);
  await expectStatus(page, "awaiting_approval");
  await expect(page.locator(".plan")).toBeVisible();
  await expect(page.locator(".mlist li.sel")).toContainText(id.slice(0, 8));
  await shot(page, info, "07-after-reload");

  // 새 탭(같은 브라우저 저장소)에서도 같은 화면
  const tab = await page.context().newPage();
  await tab.goto("/");
  expect(await currentMigrationId(tab)).toBe(id);
  await expectStatus(tab, "awaiting_approval");
});

test("완료된 이전도 새로고침 뒤 completed로 남는다", async ({ page }) => {
  await openConsole(page);
  const id = await createMigration(page);
  await confirmSpec(page);
  await expectStatus(page, "awaiting_approval");
  await page.getByRole("button", { name: "승인", exact: true }).click();
  await expectStatus(page, "approved");
  await page.getByRole("button", { name: /실행 시작/ }).click();
  await expectStatus(page, "completed", 45_000);

  await page.reload();
  expect(await currentMigrationId(page)).toBe(id);
  await expectStatus(page, "completed");
  await expect(page.locator(".stepper li.done")).toHaveCount(15);
});
