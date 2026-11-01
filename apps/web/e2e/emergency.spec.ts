import { type Page, type Request } from "@playwright/test";
import { expect, test, SEED, createMigration, currentStatus, expectStatus, openConsole, shot } from "./helpers";

// Z11: 비상 버튼(롤백·취소). 서버 경로는 apps/api/src/routes/control.ts
// 롤백 시험은 rollback_window 칸에서 누른다. 워커 기본 창은 3초라 사람이(시험도) 누르기 빠듯하다
//   → 워커를 ROLLBACK_WINDOW_SEC=20 으로 띄운다 (데모도 같음). 창이 너무 짧으면 시험이 이유를 남기고 건너뛴다

const rollbackBtn = (p: Page) => p.getByRole("button", { name: /^롤백 \(출발로/ });
const cancelBtn = (p: Page) => p.getByRole("button", { name: "취소", exact: true });

function controlPosts(page: Page) {
  const posts: Request[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && /\/migrations\/[^/]+\/(rollback|cancel)$/.test(r.url())) posts.push(r);
  });
  return posts;
}

// 콘티: 8분판 S5 "롤백 장면" 옆 취소 버튼 / 5분판에선 안 씀. 리허설 뒤 정리(reset 대신 화면 취소)
test("취소: 명세 검토에서 확인 한 번 → cancelled, 한국어 한 줄, 그만두기는 요청 0개", async ({ page }, info) => {
  const posts = controlPosts(page);
  await openConsole(page);
  await createMigration(page);
  await expectStatus(page, "spec_review");

  // 아직 바꾼 게 없으니 롤백은 꺼지고 이유가 보인다
  await expect(rollbackBtn(page)).toBeDisabled();
  await expect(page.locator(".why-off")).toContainText("'취소'를 쓰면 돼");
  await expect(cancelBtn(page)).toBeEnabled();

  // 누르면 확인 상자만. 그만두기 → 요청 없음
  await cancelBtn(page).click();
  const dlg = page.getByRole("alertdialog", { name: "취소 확인" });
  await expect(dlg).toContainText("되돌릴 수 없어");
  await expect(cancelBtn(page)).toBeDisabled();
  await dlg.getByRole("button", { name: "그만두기" }).click();
  await expect(dlg).toHaveCount(0);
  expect(posts.length).toBe(0);

  await cancelBtn(page).click();
  await page.getByPlaceholder(/사유/).last().fill("e2e 취소");
  await shot(page, info, "Z11-cancel-confirm");
  await page.getByRole("button", { name: "취소 확인" }).click();
  await expectStatus(page, "cancelled");
  await expect(page.locator("p.ok")).toHaveText("취소했어. 이 이전은 끝났고 환경 잠금도 풀렸어.");
  await expect(page.getByRole("heading", { name: "비상 버튼" })).toHaveCount(0);
  await shot(page, info, "Z11-cancelled");

  expect(posts.length).toBe(1);
  expect(posts[0]!.url()).toMatch(/\/cancel$/);
  expect(posts[0]!.headers()["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
  expect(posts[0]!.postDataJSON()).toEqual({ reason: "e2e 취소" });
});

// 콘티: 8분판 S5 "롤백 장면"(Z11 합쳐진 뒤 화면 버튼). 워커 ROLLBACK_WINDOW_SEC=20 필요
test("롤백: 실행 중엔 취소가 꺼지고, 롤백 가능 창에서 확인 → rolling_back → rolled_back", async ({ page }, info) => {
  const posts = controlPosts(page);
  await openConsole(page);
  const id = await createMigration(page);
  await expectStatus(page, "spec_review");
  await page.getByRole("button", { name: /명세 확정/ }).click();
  await expectStatus(page, "awaiting_approval");
  await page.getByRole("button", { name: "승인", exact: true }).click();
  await expectStatus(page, "approved");
  await expect(rollbackBtn(page)).toBeDisabled();
  await expect(cancelBtn(page)).toBeEnabled();
  await page.getByRole("button", { name: /실행 시작/ }).click();

  await expectStatus(page, "rollback_window", 45_000);
  const res = await page.request.get(`/api/migrations/${id}`, { headers: { "x-dev-tenant": SEED.tenant } });
  const ends = Date.parse((await res.json()).rollbackWindowEndsAt);
  const leftMs = ends - Date.now();
  test.skip(leftMs < 4000, `롤백 가능 창이 ${leftMs}ms 남음. 워커를 ROLLBACK_WINDOW_SEC=20 으로 다시 띄워야 이 시험이 돈다`);

  await expect(cancelBtn(page)).toBeDisabled();
  await expect(page.locator(".why-off")).toContainText("취소 대신 '롤백'");
  await expect(page.getByText("문제가 보이면 아래 '롤백'으로")).toBeVisible();
  await rollbackBtn(page).click();
  await expect(page.getByRole("alertdialog", { name: "롤백 확인" })).toContainText("역방향 복제");
  await shot(page, info, "Z11-rollback-confirm");

  const t0 = Date.now();
  await page.getByRole("button", { name: "롤백 확인" }).click();
  await expect(page.locator("p.ok")).toContainText("롤백을 시작했어.");
  const sawRollingBack = (await currentStatus(page)) === "rolling_back";
  await expectStatus(page, "rolled_back", 20_000);
  const ms = Date.now() - t0;
  await expect(page.getByRole("heading", { name: "비상 버튼" })).toHaveCount(0);
  await shot(page, info, "Z11-rolled-back");

  expect(posts.length).toBe(1);
  expect(posts[0]!.url()).toMatch(/\/rollback$/);
  expect(posts[0]!.headers()["idempotency-key"]).toBeTruthy();
  info.annotations.push({ type: "rollback-click-to-rolled_back-ms", description: String(ms) });
  console.log(`[e2e] rollback click→rolled_back ${ms}ms (rolling_back 화면에 보임: ${sawRollingBack}, 창 남은 ${leftMs}ms)`);
});

// 콘티: S4·S5 실패 시 대체 — 낡은 화면에서 누른 롤백이 서버 409로 막히는 화면
test("낡은 화면에서 롤백 → 서버 409를 한국어 한 줄로, 서버 원문 줄은 그대로", async ({ page, routes }) => {
  await openConsole(page);
  const id = await createMigration(page);
  await expectStatus(page, "spec_review");
  // 화면만 '앱 배포 중'으로 낡게 만든다 (서버는 spec_review 그대로)
  await routes.add(new RegExp(`/api/migrations/${id}$`), async (r) => {
    if (r.request().method() !== "GET") return r.fallback();
    const resp = await r.fetch();
    await r.fulfill({ response: resp, json: { ...(await resp.json()), status: "deploying" } });
  });
  await expectStatus(page, "deploying");
  await rollbackBtn(page).click();
  await page.getByRole("button", { name: "롤백 확인" }).click();
  const err = page.locator(".error[role=alert]");
  await expect(err.locator(".ehead")).toHaveText("지금 상태(명세 검토)에서는 롤백할 수 없어. 그 사이 상태가 바뀌었을 수 있어.");
  await expect(err.locator(".eraw")).toContainText("409 INVALID_TRANSITION — spec_review → rolling_back not allowed");
  await routes.remove(new RegExp(`/api/migrations/${id}$`));
});
