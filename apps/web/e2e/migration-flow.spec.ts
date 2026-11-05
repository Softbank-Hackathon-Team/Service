import { expect, test, SEED, confirmSpec, createMigration, currentStatus, expectStatus, openConsole, shot } from "./helpers";

// 콘티 장면: S1(만들기) → S3(계획서) → S4(승인·실행·완료). 장면 번호는 Z24 8분판·Z28 5분판과 같다

// 정상 경로 15칸 중 화면에서 보여야 하는 것: 사람 칸 3개 + 워커 칸 + 끝
const WORKER_STATES = ["provisioning", "deploying", "syncing", "shifting", "cutover", "rollback_window", "cleanup"];

test("만들기 → 명세 확정 → 계획 보기 → 승인 → 시작 → 진행 표시 → completed", async ({ page }, info) => {
  const t0 = Date.now();
  const mark: Record<string, number> = {};
  await openConsole(page);

  const id = await createMigration(page);
  await expectStatus(page, "spec_review");
  mark.spec_review = Date.now() - t0;
  await expect(page.locator(".mlist li", { hasText: id.slice(0, 8) })).toBeVisible();
  await shot(page, info, "01-spec-review");

  await confirmSpec(page);
  await expectStatus(page, "awaiting_approval");
  mark.awaiting_approval = Date.now() - t0;

  // 계획서: 계획 번호, 지문, 단계 6개, 사전 점검
  const plan = page.locator(".plan");
  await expect(plan).toBeVisible();
  await expect(plan.getByText("지문(planHash)")).toBeVisible();
  await expect(plan.locator("tbody tr")).toHaveCount(6);
  for (const step of ["자원 생성", "앱 배포", "DB 복제", "트래픽 이동", "DB 컷오버", "정리"]) {
    await expect(plan.getByRole("cell", { name: step, exact: true })).toBeVisible();
  }
  await expect(plan.locator(".pc li").first()).toBeVisible();
  await shot(page, info, "02-plan");

  await page.getByPlaceholder(/사유/).fill("e2e 승인");
  await page.getByRole("button", { name: "승인", exact: true }).click();
  await expectStatus(page, "approved");
  mark.approved = Date.now() - t0;

  await page.getByRole("button", { name: /실행 시작/ }).click();

  // 진행: 1.5초 폴링이라 빠른 칸은 못 볼 수 있다. 본 상태를 기록하고, 워커 칸을 최소 1개는 봐야 한다
  const seen = new Set<string>();
  let shotRunning = false;
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const s = await currentStatus(page);
    if (s) seen.add(s);
    if (s && WORKER_STATES.includes(s) && !shotRunning) { shotRunning = true; await shot(page, info, "03-running"); }
    if (s === "completed") break;
    expect(["failed", "rolled_back", "rolling_back", "paused"]).not.toContain(s);
    await page.waitForTimeout(250);
  }
  await expectStatus(page, "completed", 1_000);
  mark.completed = Date.now() - t0;

  const workerSeen = WORKER_STATES.filter((s) => seen.has(s));
  expect(workerSeen.length, `본 상태: ${[...seen].join(",")}`).toBeGreaterThan(0);

  // 끝난 화면: 15칸 전부 done, 버튼 없음, 목록 막대 100%
  await expect(page.locator(".stepper li.done")).toHaveCount(15);
  await expect(page.getByText("끝난 이전이야.")).toBeVisible();
  await expect(page.locator(".mlist li.sel .fill")).toHaveAttribute("style", /width: 100%/);
  await shot(page, info, "04-completed");

  info.annotations.push({ type: "timing-ms", description: JSON.stringify(mark) });
  info.annotations.push({ type: "seen-states", description: [...seen].join(" → ") });
  console.log(`[e2e] timing-ms ${JSON.stringify(mark)} seen ${[...seen].join(">")}`);
});

// 콘티 S2·S3: 승인하는 사람이 계획서와 예상 비용을 한 화면에서 본다.
// 예전 fixme("계획서(.plan) 안에 비용")는 계획서(PlanDoc)에 비용 칸이 없어 건너뛰었다. Z2가 같은 상세 화면에
// 비용 비교(GET /migrations/:id/cost)를 붙였으니 "승인 대기 화면에 비용이 보인다"로 바꿔 살렸다 (Z41).
// 계획서 자체에 비용을 저장하는 일(PlanDoc.cost)은 여전히 서버 몫이다.
test("승인 대기 화면에 계획서와 예상 비용이 같이 보인다 (S2·S3)", async ({ page }) => {
  await openConsole(page);
  const id = await createMigration(page);
  await confirmSpec(page);
  await expectStatus(page, "awaiting_approval");
  await expect(page.locator(".plan")).toBeVisible();
  const cost = page.locator(".cost");
  await expect(cost.locator(".kpi")).toHaveCount(3);
  await expect(cost.locator(".kpi").nth(2)).toContainText(/월 \$[\d,.]+ (아낌|더 듦)|계산 불가/);
  await expect(cost.locator(".ctotal").first()).toHaveText(/^\$[\d,.]+$/);
  // 정리: 승인 대기로 남겨 두면 환경 잠금 때문에 뒤 시험이 흔들릴 수 있다
  await page.request.post(`/api/migrations/${id}/cancel`, {
    headers: { "x-dev-tenant": SEED.tenant, "idempotency-key": crypto.randomUUID() }, data: {},
  });
});
