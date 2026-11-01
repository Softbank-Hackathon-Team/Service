import { writeFileSync } from "node:fs";
import { expect, test } from "./helpers";

// z75-38 (작업 Z78): 발표 화면 장면마다 "누름(이동) → 주요 요소 보임" 까지 ms 를 잰다. 앱 코드는 안 건드린다.
// 대상은 가장 최근 이전 한 건 (rehearse.sh 가 방금 끝낸 것, 회사 1111…). 장면 순서 = 목록 → 이전 상세 → 감사 → 숫자 → 에이전트
// 결과: SCENE_TIMING_JSON 파일에 {"list":ms, ...}. 기준(장면당 ≤1.0초, 합 ≤8초)은 rehearse.sh 가 판정한다
const OUT = process.env.SCENE_TIMING_JSON;

test("발표 화면 장면별 표시 시간", async ({ page }) => {
  const ms: Record<string, number> = {};
  const scene = async (name: string, act: () => Promise<unknown>) => {
    const t = performance.now();
    await act();
    ms[name] = Math.round(performance.now() - t);
  };

  await scene("list", async () => {
    await page.goto("/?reset=1"); // z75-53 (Z83-09): 새 화면은 지난 회차 숨김·선택 표식을 지우고 시작. 구 화면은 무시
    await expect(page.getByText("API 연결됨")).toBeVisible();
    await expect(page.locator(".mlist li").first()).toBeVisible();
  });
  await scene("detail", async () => {
    await page.locator(".mlist li .mpick").first().click();
    await expect(page.locator(".dhead h2 code")).toBeVisible();
    await expect(page.locator(".stepper li").first()).toBeVisible();
  });
  const panel = page.getByTestId("security-panel");
  await scene("audit", async () => {
    await panel.scrollIntoViewIfNeeded();
    await expect(panel.locator('[data-row="AU-CHAIN"] [data-state]').first()).toBeVisible();
  });
  await scene("numbers", async () => {
    await expect(panel.locator(".sec-sum").first()).toContainText(/지켜짐 \d+/);
  });
  await scene("agent", async () => {
    const a = page.getByTestId("agent-remediate");
    await a.scrollIntoViewIfNeeded();
    await expect(a).toBeVisible();
  });

  console.log(`[scene-timing] ${JSON.stringify(ms)}`);
  if (OUT) writeFileSync(OUT, JSON.stringify(ms));
});
