import { defineConfig, devices } from "@playwright/test";

// 새 콘솔(src/, 5173)을 목업 없이 실제 API·워커·DB 로 끝까지 돌린다. e2e/ 가 아니라 e2e-real/ 에 둔다:
// e2e/ 의 시험은 레거시 화면을 보고, 문구·선택자 계약(test/z81-*)이 e2e/ 전체를 레거시 소스와 대조하기 때문이다
// 화면·API·워커는 이미 떠 있어야 한다 (webServer 없음). 배포된 플랫폼은 E2E_BASE_URL 만 바꿔 같은 시험을 그대로 돌린다
// 로그인은 진짜로 한다. 비밀번호는 E2E_LOGIN_PASSWORD 로만 받는다 (파일·로그에 남기지 않는다)
if (!process.env.E2E_LOGIN_PASSWORD) {
  throw new Error(
    "E2E_LOGIN_PASSWORD 가 없습니다. 실제 서버에 로그인할 비밀번호를 환경변수로 주세요. " +
      "예: E2E_LOGIN_PASSWORD=\"$(cat <비밀번호 파일>)\" npx playwright test -c playwright.real.config.ts",
  );
}

export default defineConfig({
  testDir: "./e2e-real",
  testMatch: "*.real.ts",
  workers: 1,
  retries: 0,
  // DRAFT(ai): 배포 환경은 트래픽 단계마다 30초를 지켜보고 롤백 창도 길 수 있어 넉넉히 20분
  timeout: 20 * 60_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  outputDir: "e2e-results/real",
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:5173",
    locale: "ko-KR",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  // 화면 신호(SSE)를 CDP 로 읽으므로 chromium 하나만
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
