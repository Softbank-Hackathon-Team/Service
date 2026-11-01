import { defineConfig, devices } from "@playwright/test";

// z75-38 (작업 Z78): 발표 화면 장면별 표시 시간만 잰다. 일반 e2e(playwright.config.ts)와 따로 돈다 (testMatch 가 *.timing.ts 라 서로 안 섞임)
// tools/rehearse.sh 가 회차마다 한 번 부른다. 화면·API·워커는 이미 떠 있어야 한다 (webServer 없음)
// 기준 주소는 운영 빌드 8080. 개발 화면과 비교할 때만 E2E_BASE_URL=http://localhost:5173
export default defineConfig({
  testDir: "./e2e",
  testMatch: "*.timing.ts",
  workers: 1,
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  outputDir: process.env.SCENE_TIMING_OUTDIR ?? "e2e-results/scene-timing",
  use: { baseURL: process.env.E2E_BASE_URL ?? "http://localhost:8080", locale: "ko-KR", trace: "off", screenshot: "off" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
