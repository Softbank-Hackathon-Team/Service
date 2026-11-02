import { defineConfig, devices } from "@playwright/test";

// 기존 시험은 레거시 화면을 본다. 화면(Vite 5174, legacy/) → 프록시 → API(3000) → Postgres. API·워커·DB는 미리 떠 있어야 한다(global-setup이 확인).
// 화면은 안 떠 있으면 Playwright가 띄우고, 떠 있으면 그대로 쓴다.
// Z75-11: 개발 화면(5174)이면 일꾼 3개가 동시에 돈다. 일꾼마다 회사를 따로 쓴다(e2e/helpers.ts seedFor, global-setup 이 만듦)
//   → 환경 잠금·회사당 쓰기 한도가 안 섞인다. 다른 주소(운영 모양 8080 등)는 DB 에 seed 를 못 넣으니 예전처럼 1개.
//   E2E_WORKERS=1 이면 언제든 예전과 똑같이 하나씩 돈다
const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:5174";
const devServer = !process.env.E2E_BASE_URL;
const workers = Number(process.env.E2E_WORKERS ?? (devServer ? 3 : 1));

export default defineConfig({
  testDir: "./e2e",
  testMatch: "*.spec.ts",
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: workers > 1,
  workers,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [["list"], ["html", { open: "never", outputFolder: "e2e-report" }]],
  outputDir: "e2e-results",
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    locale: "ko-KR",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  // Z75-18: 개발 화면으로 돌 때는 API·워커·화면 셋 다 안 떠 있으면 Playwright 가 띄운다(떠 있으면 그대로 쓴다).
  //   DB 는 먼저 떠 있어야 한다(npm run db:up). 운영 모양(E2E_BASE_URL)일 때는 화면 하나도 띄우지 않는다
  webServer: devServer ? [
    // Z93: 기존 e2e 는 개발용 헤더(x-dev-tenant)로 돈다 → 시험용 API 는 DEV_AUTH=1. 로그인 e2e(login.spec.ts)는 같은 서버에서 진짜 로그인을 쓴다
    { command: "npm run dev:api", cwd: "../..", url: `${process.env.E2E_API_URL ?? "http://localhost:3000"}/healthz`,
      reuseExistingServer: true, timeout: 60_000, env: { DEV_AUTH: "1", MOCK_SEED: "1", MOCK_IAC: "1", MOCK_ARGO: "1", MOCK_PRECHECK: "1", FAKE_LLM: "1" } },
    { command: "npm run dev:worker", cwd: "../..", url: `http://localhost:${process.env.WORKER_METRICS_PORT ?? 9465}/metrics`,
      reuseExistingServer: true, timeout: 60_000, env: { ROLLBACK_WINDOW_SEC: process.env.ROLLBACK_WINDOW_SEC ?? "20",
        MOCK_SEED: "1", MOCK_IAC: "1", MOCK_ARGO: "1", MOCK_PRECHECK: "1", FAKE_LLM: "1" } },   // 시험 스위치 다섯 (Z98 조립)
    { command: "npm run dev:legacy", url: baseURL, reuseExistingServer: true, timeout: 60_000 },
  ] : undefined,
});
