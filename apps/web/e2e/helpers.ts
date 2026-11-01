import { test as base, expect, type Page, type Route, type TestInfo } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

// 개발 seed(db/migrations/0002_seed_dev.sql)와 같은 값 = 0번 일꾼(worker)의 회사
const BASE_SEED = {
  tenant: "11111111-1111-4111-8111-111111111111",
  aws: "22222222-2222-4222-8222-222222222222",
  gcp: "33333333-3333-4333-8333-333333333333",
  azure: "44444444-4444-4444-8444-444444444444",
};
// Z75-11: 일꾼끼리 같은 회사·환경을 쓰면 환경 잠금(409)·회사당 쓰기 한도가 섞인다 → 일꾼마다 회사를 나눈다.
// 0번은 지금 seed 그대로(혼자 돌 때와 똑같다). n번(1..15)은 끝 두 자리를 f<n> 으로 바꾼 번호. global-setup 이 만든다
export function seedFor(n: number): typeof BASE_SEED {
  if (n === 0) return BASE_SEED;
  if (n > 15) throw new Error(`일꾼 ${n}번: 회사 번호는 15번까지 만든다`);
  const tail = `f${n.toString(16)}`;
  const swap = (id: string) => id.slice(0, -2) + tail;
  return { tenant: swap(BASE_SEED.tenant), aws: swap(BASE_SEED.aws), gcp: swap(BASE_SEED.gcp), azure: swap(BASE_SEED.azure) };
}
// Playwright 가 일꾼 프로세스마다 0..workers-1 을 준다 (playwright.dev/docs/test-parallel)
export const WORKER = Number(process.env.TEST_PARALLEL_INDEX ?? 0);
export const SEED = seedFor(WORKER);

// 화면이 처음 뜰 때 이 일꾼의 회사 번호로 시작하게 한다 (App 은 localStorage "web.tenant" 를 먼저 읽는다).
// 이미 값이 있으면(시험이 회사를 바꾼 뒤 새로 고침) 건드리지 않는다. 0번은 아무것도 안 한다
// z75-25: 시험 안에서 API 응답을 바꾸는 가로채기(page.route)는 routes 로만 건다.
//   - 같은 주소 무늬를 두 번 걸면 앞의 것을 먼저 떼고 건다 (Map 으로 하나만 유지)
//   - 뗀 뒤에 아직 돌던 처리기가 응답을 내려다 "Route is already handled" 로 깨지는 것을 막는다:
//     뗀 처리기는 아무것도 안 하고, 떼는 중에 난 그 오류만 삼킨다
//   - 시험이 끝나면 남은 가로채기를 전부 뗀다 (unrouteAll ignoreErrors)
//   출처: playwright.dev/docs/api/class-page#page-unroute-all
type RouteUrl = string | RegExp;
type RouteFn = (route: Route) => Promise<unknown> | unknown;
export interface Routes {
  add(url: RouteUrl, fn: RouteFn): Promise<void>;
  remove(url: RouteUrl): Promise<void>;
  removeAll(): Promise<void>;
}
const routeKey = (u: RouteUrl) => (u instanceof RegExp ? `re:${u.source}/${u.flags}` : `glob:${u}`);
const lateRouteError = (e: unknown) => /already handled|Target page, context or browser has been closed|Request context disposed/i.test(String((e as Error)?.message ?? e));
// Z32 (7b r2 흔들림): 화면이 폴링 요청을 스스로 끊으면(다음 폴링·화면 전환) 가로챈 r.fetch() 응답이 버려져
//   resp.json() 이 "Response has been disposed" 를 던진다. 그 요청을 기다리는 쪽이 없으니 켜져 있어도 무시한다 (서버와 무관)
const abandonedResponse = (e: unknown) => /Response has been disposed/i.test(String((e as Error)?.message ?? e));

export const test = base.extend<{ routes: Routes }>({
  page: async ({ page }, use) => {
    if (WORKER > 0) {
      await page.addInitScript((t) => { try { if (!localStorage.getItem("web.tenant")) localStorage.setItem("web.tenant", t); } catch { /* 무시 */ } },
        SEED.tenant);
    }
    await use(page);
  },
  routes: async ({ page }, use) => {
    const live = new Map<string, { url: RouteUrl; on: boolean; handler: (r: Route) => Promise<void> }>();
    const routes: Routes = {
      async add(url, fn) {
        await routes.remove(url);
        const entry = { url, on: true, handler: async (r: Route) => {
          if (!entry.on) { await r.fallback().catch(() => {}); return; }
          try { await fn(r); } catch (e) { if ((!entry.on && lateRouteError(e)) || abandonedResponse(e)) { await r.fallback().catch(() => {}); return; } throw e; }
        } };
        live.set(routeKey(url), entry);
        await page.route(url, entry.handler);
      },
      async remove(url) {
        const entry = live.get(routeKey(url));
        if (!entry) return;
        entry.on = false;
        live.delete(routeKey(url));
        await page.unroute(url, entry.handler);
      },
      async removeAll() {
        for (const e of live.values()) e.on = false;
        live.clear();
        await page.unrouteAll({ behavior: "ignoreErrors" });
      },
    };
    await use(routes);
    await routes.removeAll();
  },
});
export { expect };
// seed에 없는 회사. 이 회사로는 환경이 하나도 안 보여야 한다(RLS)
export const OTHER_TENANT = "99999999-9999-4999-8999-999999999999";

// 상세 카드 오른쪽 위 칩: "명세 검토 · spec_review"
export function statusChip(page: Page) {
  return page.locator(".dhead .chip");
}

export async function expectStatus(page: Page, status: string, timeout = 20_000) {
  await expect(statusChip(page)).toContainText(`· ${status}`, { timeout });
}

export async function currentStatus(page: Page): Promise<string | null> {
  const t = await statusChip(page).textContent().catch(() => null);
  return t?.split("·").pop()?.trim() ?? null;
}

export async function currentMigrationId(page: Page): Promise<string> {
  const id = await page.locator(".dhead h2 code").textContent();
  if (!id) throw new Error("상세 화면에 이전 번호가 없다");
  return id.trim();
}

// 화면이 처음 뜨고 환경 목록(서버 GET /environments)이 들어올 때까지
export async function openConsole(page: Page) {
  await page.goto("/");
  await expect(page.getByText("API 연결됨")).toBeVisible();
  await expect(page.locator(".side .card").first().locator("tbody tr").first()).not.toHaveText("환경 없음");
}

export async function createMigration(page: Page): Promise<string> {
  await page.getByRole("button", { name: "새 이전 만들기" }).click();
  await expect(page.locator(".dhead h2 code")).toBeVisible();
  return currentMigrationId(page);
}

// 스크린샷: 시험 결과 폴더 + (E2E_SCREENSHOT_DIR 이 있으면) 그 폴더에도
export async function shot(page: Page, info: TestInfo, name: string) {
  const file = `${name}.png`;
  await page.screenshot({ path: info.outputPath(file), fullPage: true });
  const dir = process.env.E2E_SCREENSHOT_DIR;
  if (dir) {
    mkdirSync(dir, { recursive: true });
    await page.screenshot({ path: join(dir, file), fullPage: true });
  }
}
