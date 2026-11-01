import { expect, test, SEED, createMigration, expectStatus, openConsole, shot } from "./helpers";

// 작업 Z58: 데모 S7 "AI 점검 결과" 카드. 이전 상세에 카드가 뜨고, 화면 값이 API 응답과 같은가
// Z90: 기본(실제 LLM)에서는 기록이 없으면 "기록 없음" + AI 상태. FAKE_LLM=1 시험이면 서버가 대본 결과를 주고 화면은 "STUB" 칩을 붙인다
test("AI 점검 결과: 상세에 카드가 뜨고 API 값과 같다 (STUB 이면 STUB 표시)", async ({ page }, info) => {
  await openConsole(page);
  const id = await createMigration(page);
  await expectStatus(page, "spec_review");

  const res = await page.request.get(`/api/migrations/${id}/agent-review`, { headers: { "x-dev-tenant": SEED.tenant } });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.migrationId).toBe(id);

  const card = page.getByTestId("agent-review");
  await expect(card).toBeVisible();
  // 작업 Z90: AI 상태 표시가 서버 값과 같다 (실제 / 키 없음 / 가짜 시험)
  if (body.llm) await expect(card.locator(`[data-llm="${body.llm.state}"]`)).toBeVisible();
  if (body.remediate) {
    const rm = card.getByTestId("agent-remediate");
    await expect(rm).toContainText(body.remediate.title);
    await expect(rm.locator(`[data-source="${body.remediate.source}"]`)).toBeVisible();
    if (body.remediate.source === "stub") await expect(rm).toContainText("STUB 대본");
    await expect(rm.locator(".air-steps li")).toHaveCount(body.remediate.steps.length);
    if (body.remediate.gate) await expect(rm.locator(`[data-gate="${body.remediate.gate.ok ? "ok" : "fail"}"]`)).toBeVisible();
    for (const x of body.remediate.notDone) await expect(rm).toContainText(x);
  } else if (!body.specDraft) {
    // 실제 모드에서 아직 안 돌린 이전: 가짜 결과 대신 "기록 없음"
    await expect(card).toContainText("아직 AI 점검 기록이 없어");
  }
  await card.scrollIntoViewIfNeeded();
  await shot(page, info, "z58-01-agent-review");

  // 남의 회사 번호로는 404 (회사 벽)
  const other = await page.request.get(`/api/migrations/${id}/agent-review`, {
    headers: { "x-dev-tenant": "99999999-9999-4999-8999-999999999999" } });
  expect(other.status()).toBe(404);
});
