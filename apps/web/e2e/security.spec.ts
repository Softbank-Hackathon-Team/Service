import { expect, test, SEED, createMigration, expectStatus, openConsole, shot } from "./helpers";

// 작업 Z18: 이전 상세의 보안 표. 만들기 → 끝까지 → 표가 진짜 값(감사 체인·장부·T27)을 보여 주는가
// 콘티: S6 컷 1 보안 표 (판 B, Z18 합쳐진 뒤)
test("보안 표: 진행 중에도 보이고, 끝나면 실행 역할 회수·감사 체인이 채워진다", async ({ page }, info) => {
  await openConsole(page);
  const id = await createMigration(page);
  await expectStatus(page, "spec_review");

  const panel = page.getByTestId("security-panel");
  await expect(panel).toBeVisible();
  await expect(panel.locator('[data-row="AU-CHAIN"] [data-state="ok"]')).toBeVisible();
  // Z39: 통제 12개 매트릭스가 판정된다 (미구현 아님). 펼치면 출발·도착 × 12칸 (화면의 새 이전은 도착이 시드 환경 중 하나라 도착 종류는 고정 안 함)
  await expect(panel.locator('[data-row="CT-MATRIX"]')).not.toContainText("미구현");
  await expect(panel.locator('[data-row="CT-MATRIX"]')).toContainText("출발 aws 통과");
  await panel.getByText(/통제 12개 × 환경 매트릭스 펼치기/).click();
  const matrix = panel.getByTestId("control-matrix");
  await expect(matrix.locator("[data-control]")).toHaveCount(12);
  await expect(matrix.locator('[data-control="SEC-AUD-02"] [data-side="source"][data-cell="pass"]')).toContainText("실측");
  await expect(matrix.locator('[data-control="SEC-IAM-02"] [data-side="source"][data-cell="pass"]')).toContainText("정적");
  await shot(page, info, "z18-01-spec-review");

  await page.getByRole("button", { name: /명세 확정/ }).click();
  await expectStatus(page, "awaiting_approval");
  await page.getByPlaceholder(/사유/).fill("e2e 보안 표");
  await page.getByRole("button", { name: "승인", exact: true }).click();
  await expectStatus(page, "approved");
  await page.getByRole("button", { name: /실행 시작/ }).click();
  await expectStatus(page, "completed", 45_000);

  // 끝난 이전: 정리 단계가 남긴 T27 증거 + 장부 표 + 감사 체인
  await expect(panel.locator('[data-row="TC-REVOKED"]')).toContainText("operateRoleRevoked = true");
  await expect(panel.locator('[data-row="TC-LEDGER"]')).not.toContainText("미구현");
  // Z39: 작업 단계가 임시 역할을 빌렸다 → 장부에 단계 이름, 감사에 발급 수. TC-AUDIT 는 더 이상 미구현이 아니다
  await expect(panel.locator('[data-row="TC-LEDGER"]')).toContainText("단계 precheck");
  await expect(panel.locator('[data-row="TC-AUDIT"] [data-state="ok"]')).toBeVisible();
  await expect(panel.locator('[data-row="TC-AUDIT"]')).toContainText(/발급 [1-9]/);
  await expect(panel.locator('[data-row="AU-CHAIN"] [data-state="ok"]')).toBeVisible();
  await expect(panel.locator('[data-row="SE-PLAINTEXT"] [data-state="ok"]')).toBeVisible();
  // 응답·화면에 계정 번호 모양(12자리 숫자)이 없다
  await expect(panel).not.toContainText(/\b\d{12}\b/);

  // API 를 직접 불러 화면 숫자와 같은지 (요약 칩)
  const res = await page.request.get(`/api/migrations/${id}/security`, {
    headers: { "x-dev-tenant": SEED.tenant } });
  expect(res.status()).toBe(200);
  const body = await res.json();
  await expect(panel.getByLabel("보안 표 요약")).toContainText(`위반 ${body.summary.fail}`);
  await expect(panel.getByLabel("보안 표 요약")).toContainText(`미구현 ${body.summary.notImplemented}`);
  expect(body.summary.notImplemented).toBe(0);
  expect(body.controlMatrix).toHaveLength(24);
  await shot(page, info, "z18-02-completed");
});
