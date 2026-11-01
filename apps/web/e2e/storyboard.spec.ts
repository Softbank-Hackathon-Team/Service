import { type Page } from "@playwright/test";
import { expect, test, OTHER_TENANT, SEED, createMigration, currentMigrationId, currentStatus, expectStatus, openConsole, shot, type Routes } from "./helpers";

// 작업 Z41: 데모 콘티 장면(S0~S8)을 화면 경로로 덮는다.
//   장면 번호 = 8분판 parallel/Z24/docs/DEMO-STORYBOARD.md = 5분판 parallel/Z28/docs/DEMO-STORYBOARD-5MIN.md
//   S0(설계 문서 그림)·S5(터미널 numbers)·S7(터미널 agent)·S8(말뿐)은 웹 화면이 없다 → 웹에서 볼 수 있는 앞뒤 상태만 본다.
// 무대 순서 그대로 한 건을 끝까지 몰고 가는 시험 1개 + 콘티의 "실패 시 대체" 화면을 하나씩 보는 시험들.

const H = { "x-dev-tenant": SEED.tenant };
const WORKER_STATES = ["provisioning", "deploying", "syncing", "shifting", "cutover", "rollback_window", "cleanup"];

// 시험이 남긴 끝나지 않은 이전은 취소해서 환경 잠금을 푼다 (뒤 시험이 ENV_BUSY 409 로 연쇄 실패하지 않게)
async function cancelIfOpen(page: Page, id: string) {
  const r = await page.request.get(`/api/migrations/${id}`, { headers: H });
  if (!r.ok()) return;
  const s = (await r.json()).status as string;
  if (["completed", "rolled_back", "cancelled"].includes(s)) return;
  await page.request.post(`/api/migrations/${id}/cancel`, {
    headers: { ...H, "idempotency-key": crypto.randomUUID() }, data: {},
  });
}

async function pickPair(page: Page, src = "dev-aws (aws)", dst = "dev-gcp (gcp)") {
  const form = page.locator(".form");
  await form.getByLabel("출발").selectOption({ label: src });
  await form.getByLabel("도착").selectOption({ label: dst });
}

const usdText = (x: number) => `$${x.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}`;

test("무대 한 건: S0 시작 전 → S1 만들기 → S3 계획서 → S2 비용 → S4 실행·완료 → S6 보안 표·회사 벽·감사", async ({ page }, info) => {
  test.setTimeout(120_000);
  const mark: Record<string, number> = {};
  const clicks: string[] = [];
  let id = "";

  await test.step("S0 / T-2:00 시작 전 상태: API 연결됨 초록 점, 환경 표 dev-aws·dev-gcp·Azure Mock", async () => {
    await openConsole(page);
    await expect(page.locator("header .dot.up")).toBeVisible();
    const envTable = page.locator(".side .card").first();
    await expect(envTable.locator("tbody tr", { hasText: "dev-aws" })).toContainText("AWS");
    await expect(envTable.locator("tbody tr", { hasText: "dev-gcp" })).toContainText("GCP");
    await expect(envTable.locator("tbody tr", { hasText: "dev-aws" })).toContainText("연결됨");
    await expect(envTable.locator("tbody tr", { hasText: "azure" }).locator(".chip.mock")).toBeVisible();
    // Azure Mock 카드는 머리 줄 아래 왼쪽 칸에 있어야 한다 (Z41 이전엔 머리 줄 위로 밀려나 있었다)
    await expect(page.locator(".app > .card")).toHaveCount(0);
    await expect(page.locator(".side").getByRole("heading", { name: /dev-azure-mock/ })).toBeVisible();
    await shot(page, info, "z41-S0-start");
  });

  await test.step("S1 출발 dev-aws → 도착 dev-gcp → 새 이전 만들기 → 명세 검토(진행 칸 1~2 초록, 3 강조)", async () => {
    await pickPair(page);
    const t = Date.now();
    id = await createMigration(page); clicks.push("새 이전 만들기");
    await expectStatus(page, "spec_review");
    mark.S1_create_to_spec_review = Date.now() - t;
    await expect(page.locator(".mlist li.sel")).toContainText("dev-aws → dev-gcp");
    await expect(page.locator(".dhead + .muted")).toContainText("dev-aws → dev-gcp");
    const steps = page.locator(".stepper li");
    await expect(steps.nth(0)).toHaveClass(/done/);
    await expect(steps.nth(1)).toHaveClass(/done/);
    await expect(steps.nth(2)).toHaveClass(/here/);
    await expect(steps.nth(2)).toContainText("명세 검토");
    await shot(page, info, "z41-S1-spec-review");
  });

  await test.step("S3 앞부분: 명세 확정 → 승인 대기, 계획서(지문 64자, 단계 6줄, 롤백 기준, 사전 점검)", async () => {
    const t = Date.now();
    await page.getByRole("button", { name: /명세 확정/ }).click(); clicks.push("명세 확정");
    await expectStatus(page, "awaiting_approval");
    mark.S3_confirm_to_awaiting = Date.now() - t;
    const plan = page.locator(".plan");
    await expect(plan.locator(".kv code").nth(1)).toHaveText(/^[0-9a-f]{64}$/);
    await expect(plan.locator("tbody tr")).toHaveCount(6);
    await expect(plan.locator(".kv")).toContainText(/오류율 \d+(\.\d+)?% 초과 또는 p95 \d+(\.\d+)?배, \d+초 동안/);
    await expect(plan.locator(".pc li").first()).toBeVisible();
    // 사람 칸이라 "승인 전엔 실행 시작 버튼이 없다"가 화면에서도 보인다
    await expect(page.getByRole("button", { name: /실행 시작/ })).toHaveCount(0);
    await shot(page, info, "z41-S3-plan");
  });

  await test.step("S2 비용 비교(8분판): 출발·도착 막대와 '옮기면' 숫자가 API 응답과 같다, 미확인 값 표시", async () => {
    const res = await page.request.get(`/api/migrations/${id}/cost`, { headers: H });
    expect(res.status()).toBe(200);
    const v = await res.json();
    const cost = page.locator(".cost");
    await expect(cost.locator(".kpi").nth(0)).toContainText(`AWS (dev-aws)`);
    await expect(cost.locator(".kpi").nth(0)).toContainText(usdText(v.pair.sourceMonthlyUsd));
    await expect(cost.locator(".kpi").nth(1)).toContainText(`GCP (dev-gcp)`);
    await expect(cost.locator(".kpi").nth(1)).toContainText(usdText(v.pair.targetMonthlyUsd));
    const d = v.pair.monthlyUsd as number;
    await expect(cost.locator(".kpi").nth(2)).toContainText(d >= 0 ? `월 ${usdText(d)} 아낌` : `월 ${usdText(-d)} 더 듦`);
    // 크레딧 몫을 같이 보여 준다 (5분판이 $86.4 를 말하지 않는 이유: 대부분이 크레딧, Z28 4절)
    if (v.pair.creditPortionUsd) await expect(cost.locator(".kpi-s")).toContainText(`그중 무료 크레딧 몫 ${usdText(v.pair.creditPortionUsd)}`);
    const gcp = v.estimate.envs.find((e: { provider: string }) => e.provider === "gcp");
    if (gcp?.unverified?.length) await expect(cost.locator(".crow", { hasText: "GCP" }).locator(".cnote")).toContainText("미확인·가정 값");
    await expect(cost.locator(".tag-est").first()).toBeVisible();
    info.annotations.push({ type: "cost", description: `src ${v.pair.sourceMonthlyUsd} → dst ${v.pair.targetMonthlyUsd}, save ${d}, credit ${v.pair.creditPortionUsd}` });
    await cost.scrollIntoViewIfNeeded();
    await shot(page, info, "z41-S2-cost");
  });

  await test.step("S4 승인 → 실행 시작 → 워커 칸 → 완료 (15칸 초록, 버튼 4번)", async () => {
    await page.getByPlaceholder(/사유/).first().fill("Z41 무대 한 건");
    await page.getByRole("button", { name: "승인", exact: true }).click(); clicks.push("승인");
    await expectStatus(page, "approved");
    // 승인 뒤에는 롤백은 꺼져 있고 취소만 켜져 있다 (S4 실패 시 대체의 판단 근거)
    await expect(page.getByRole("button", { name: /^롤백 \(출발로/ })).toBeDisabled();
    const t = Date.now();
    await page.getByRole("button", { name: /실행 시작/ }).click(); clicks.push("실행 시작");
    const seen = new Set<string>();
    let sawWindowNote = false;
    const deadline = Date.now() + 70_000;
    while (Date.now() < deadline) {
      const s = await currentStatus(page);
      if (s) seen.add(s);
      if (s === "rollback_window" && !sawWindowNote) {
        sawWindowNote = await page.getByText(/롤백 가능 창 끝:/).isVisible();
        // 콘티 S4: 실행 중엔 "문제가 보이면 아래 '롤백'" 안내 (Z11)
        await expect(page.locator(".actions").first()).toContainText("롤백");
      }
      if (s === "completed") break;
      expect(["failed", "rolled_back", "rolling_back", "paused", "cancelled"]).not.toContain(s);
      await page.waitForTimeout(200);
    }
    await expectStatus(page, "completed", 1_000);
    mark.S4_start_to_completed = Date.now() - t;
    expect(WORKER_STATES.filter((s) => seen.has(s)).length, `본 상태: ${[...seen].join(",")}`).toBeGreaterThan(0);
    await expect(page.locator(".stepper li.done")).toHaveCount(15);
    await expect(page.locator(".trail")).toContainText("완료");
    await expect(page.getByText("끝난 이전이야.")).toBeVisible();
    await expect(page.locator(".emergency")).toHaveCount(0); // 끝난 이전엔 비상 버튼 칸이 없다
    expect(clicks, "콘티 Z16 4절: 버튼 4번").toEqual(["새 이전 만들기", "명세 확정", "승인", "실행 시작"]);
    info.annotations.push({ type: "seen-states", description: [...seen].join(" → ") });
    info.annotations.push({ type: "rollback-window-note-seen", description: String(sawWindowNote) });
    await shot(page, info, "z41-S4-completed");
  });

  await test.step("S6 컷 1: 보안 표 — 실행 역할 회수, 감사 체인 무결, 비밀값 평문 없음, 계정 번호 모양 없음", async () => {
    const panel = page.getByTestId("security-panel");
    await panel.scrollIntoViewIfNeeded();
    await expect(panel.locator('[data-row="TC-REVOKED"]')).toContainText("operateRoleRevoked = true");
    await expect(panel.locator('[data-row="AU-CHAIN"] [data-state="ok"]')).toBeVisible();
    await expect(panel.locator('[data-row="SE-PLAINTEXT"] [data-state="ok"]')).toBeVisible();
    await expect(panel.locator('[data-row="LP-AWS-BOUNDARY"]')).not.toContainText("위반");
    await expect(panel).not.toContainText(/\b\d{12}\b/);
    await shot(page, info, "z41-S6-1-security");
  });

  await test.step("S6 컷 2: 회사 벽 (demo.sh wall 과 같은 세 줄) — 헤더 없음 401, 다른 회사 목록 빈 배열, 다른 회사 조회 404", async () => {
    expect((await page.request.get(`/api/migrations`)).status()).toBe(401);
    const list = await page.request.get(`/api/migrations`, { headers: { "x-dev-tenant": OTHER_TENANT } });
    expect(list.status()).toBe(200);
    expect((await list.json()).items).toEqual([]);
    const one = await page.request.get(`/api/migrations/${id}`, { headers: { "x-dev-tenant": OTHER_TENANT } });
    expect(one.status()).toBe(404);
    expect((await one.json()).code).toBe("NOT_FOUND");
  });

  await test.step("S6 컷 3: 감사 줄 — user:dev 와 worker 가 번갈아, 정상 경로 14번 옮김", async () => {
    const tl = await page.request.get(`/api/migrations/${id}/timeline`, { headers: H });
    expect(tl.status()).toBe(200);
    const items = ((await tl.json()).items as { kind: string; actor: string; to: string }[]).filter((x) => x.kind === "transition");
    const actors = new Set(items.map((x) => x.actor));
    expect(actors.has("user:dev")).toBe(true);
    expect(actors.has("worker")).toBe(true);
    expect(items.at(-1)?.to).toBe("completed");
    expect(items.length).toBe(14);
  });

  info.annotations.push({ type: "timing-ms", description: JSON.stringify(mark) });
  console.log(`[e2e] Z41 무대 한 건 timing-ms ${JSON.stringify(mark)}`);
});

test("S3 뒤: 옛 화면 지문으로 승인 → 409 PLAN_HASH_MISMATCH, 한국어 한 줄 + 원문, 상태는 승인 대기 그대로", async ({ page, routes }) => {
  await openConsole(page);
  await pickPair(page);
  const id = await createMigration(page);
  try {
    await expectStatus(page, "spec_review");
    // 화면이 읽는 계획서의 지문만 바꾼다 (demo.sh wronghash 와 같은 상황: 사람이 본 계획 ≠ 서버 계획)
    await routes.add(new RegExp(`/api/migrations/${id}/plan$`), async (r) => {
      if (r.request().method() !== "GET") return r.fallback();
      const resp = await r.fetch();
      if (!resp.ok()) return r.fulfill({ response: resp });
      await r.fulfill({ response: resp, json: { ...(await resp.json()), planHash: "0".repeat(64) } });
    });
    await page.getByRole("button", { name: /명세 확정/ }).click();
    await expectStatus(page, "awaiting_approval");
    await expect(page.locator(".plan .kv code").nth(1)).toHaveText("0".repeat(64));
    await page.getByRole("button", { name: "승인", exact: true }).click();
    const err = page.locator(".actions + .error");
    await expect(err.locator(".ehead")).toHaveText("계획서 지문이 달라. 그 사이 계획서가 바뀌었어. 새로 읽고 다시 승인해.");
    await expect(err.locator(".eraw")).toContainText("409 PLAN_HASH_MISMATCH");
    await expectStatus(page, "awaiting_approval");
    await expect(page.getByRole("button", { name: /실행 시작/ })).toHaveCount(0);
    // 진짜 지문으로 다시 읽으면 승인이 된다
    await routes.remove(new RegExp(`/api/migrations/${id}/plan$`));
    await page.reload();
    await expectStatus(page, "awaiting_approval");
    await expect(page.locator(".plan .kv code").nth(1)).not.toHaveText("0".repeat(64));
    await page.getByRole("button", { name: "승인", exact: true }).click();
    await expectStatus(page, "approved");
  } finally {
    await cancelIfOpen(page, id);
  }
});

test("S1 실패 시 대체: API가 꺼지면 위 점이 빨강, 'npm run dev:api' 안내 → 다시 켜지면 초록", async ({ page, routes }) => {
  await openConsole(page);
  await routes.add("**/api/healthz", (r) => r.abort("connectionrefused"));
  await expect(page.locator("header .dot.down")).toBeVisible({ timeout: 8_000 });
  await expect(page.locator("header .bad")).toContainText("npm run dev:api");
  await routes.remove("**/api/healthz");
  await expect(page.locator("header .dot.up")).toBeVisible({ timeout: 8_000 });
  await expect(page.getByText("API 연결됨")).toBeVisible();
});

// 실패·일시 정지는 워커 전체 환경 변수(SYNC_STUB_FAIL 등)로만 만들 수 있어 다른 시험을 깨뜨린다.
// 그래서 서버에는 진짜 이전 하나를 두고, 화면이 읽는 GET 응답만 그 상태로 바꿔 화면 반응을 본다 (emergency.spec 3번과 같은 방식)
async function fakeStatus(routes: Routes, id: string, patch: Record<string, unknown>) {
  await routes.add(new RegExp(`/api/migrations/${id}$`), async (r) => {
    if (r.request().method() !== "GET") return r.fallback();
    const resp = await r.fetch();
    await r.fulfill({ response: resp, json: { ...(await resp.json()), ...patch } });
  });
}

test("S4 실패 시 대체(에러 화면): failed — 실패 코드, 멈춘 칸 표시, 롤백 꺼짐, 취소는 '직접 정리했어?' 확인 뒤 manualCleanupConfirmed", async ({ page, routes }, info) => {
  await openConsole(page);
  await pickPair(page);
  const id = await createMigration(page);
  try {
    await expectStatus(page, "spec_review");
    await fakeStatus(routes, id, { status: "failed", failedAtStatus: "syncing", failureCode: "SYNC_RETRY_EXHAUSTED" });
    await expectStatus(page, "failed");
    await expect(page.locator(".card .error", { hasText: "실패 코드" })).toContainText("SYNC_RETRY_EXHAUSTED");
    const here = page.locator(".stepper li.here");
    await expect(here).toContainText("DB 복제");
    await expect(here.locator(".chip")).toContainText("실패");
    await expect(page.locator(".dhead .chip")).toHaveClass(/tone-bad/);
    // 할 일 한 줄이 "워커가 일하는 중"이 아니라 사람에게 할 일을 말한다 (Z41 수정)
    await expect(page.locator(".actions").first()).toContainText("실패해서 멈췄어");
    await expect(page.locator(".actions").first()).not.toContainText("워커가 일하는 중");
    await expect(page.getByRole("button", { name: /^롤백 \(출발로/ })).toBeDisabled();
    await expect(page.locator(".why-off")).toContainText("남은 자원을 정리한 뒤 '취소'");
    await shot(page, info, "z41-err-failed");

    // 취소 → 확인 문장이 정리 확인으로 바뀌고, 요청 본문에 manualCleanupConfirmed=true. 서버는 진짜로 spec_review 라 결과는 서버 판단 그대로
    const posts: { url: string; body: unknown }[] = [];
    page.on("request", (q) => { if (q.method() === "POST") posts.push({ url: q.url(), body: q.postDataJSON() }); });
    await page.getByRole("button", { name: "취소", exact: true }).click();
    await expect(page.getByRole("alertdialog")).toContainText("만들다 만 자원(클라우드 쪽)을 직접 정리했어?");
    await page.getByRole("button", { name: "취소 확인" }).click();
    await expect.poll(() => posts.length).toBe(1);
    expect(posts[0]!.url).toMatch(/\/cancel$/);
    expect(posts[0]!.body).toEqual({ manualCleanupConfirmed: true });
  } finally {
    await routes.removeAll();
    await cancelIfOpen(page, id);
  }
});

test("S4 실패 시 대체(에러 화면): paused — 멈춘 칸에 '일시 정지', 사람 판단 안내, 롤백 켜짐·취소 꺼짐, 1.5초 새로고침", async ({ page, routes }, info) => {
  await openConsole(page);
  await pickPair(page);
  const id = await createMigration(page);
  try {
    await expectStatus(page, "spec_review");
    await fakeStatus(routes, id, { status: "paused", pausedFrom: "shifting" });
    await expectStatus(page, "paused");
    const here = page.locator(".stepper li.here");
    await expect(here).toContainText("트래픽 이동");
    await expect(here.locator(".chip")).toContainText("일시 정지");
    await expect(page.locator(".dhead .chip")).toHaveClass(/tone-wait/);
    await expect(page.locator(".actions").first()).toContainText("일시 정지야");
    await expect(page.locator(".actions").first()).not.toContainText("워커가 일하는 중");
    await expect(page.getByRole("button", { name: /^롤백 \(출발로/ })).toBeEnabled();
    await expect(page.getByRole("button", { name: "취소", exact: true })).toBeDisabled();
    await expect(page.locator(".why-off")).toContainText("취소 대신 '롤백'");
    await expect(page.getByText(/1\.5초마다 새로고침/)).toBeVisible();
    await shot(page, info, "z41-err-paused");
  } finally {
    await routes.removeAll();
    await cancelIfOpen(page, id);
  }
});

test("S8 직전 확인: 롤백 완료·취소된 이전은 끝난 화면 (비상 칸 없음, 새로고침 멈춤)", async ({ page }) => {
  await openConsole(page);
  await pickPair(page);
  const id = await createMigration(page);
  await expectStatus(page, "spec_review");
  await page.getByRole("button", { name: "취소", exact: true }).click();
  await page.getByRole("button", { name: "취소 확인" }).click();
  await expectStatus(page, "cancelled");
  await expect(page.locator(".emergency")).toHaveCount(0);
  await expect(page.getByText("자동 새로고침 멈춤")).toBeVisible();
  await expect(page.getByText("끝난 이전이야.")).toBeVisible();
  // 같은 환경으로 바로 새 이전을 만들 수 있다 (취소가 잠금을 풀었다)
  await page.getByRole("button", { name: "새 이전 만들기" }).click();
  await expect(page.locator(".dhead h2 code")).not.toHaveText(id);
  await expectStatus(page, "spec_review");
  const id2 = await currentMigrationId(page);
  await expect(page.locator(".actions + .error")).toHaveCount(0);
  await cancelIfOpen(page, id2);
});
