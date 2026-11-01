import { writeFileSync } from "node:fs";
import { expect, test } from "./helpers";
import { ROUTES } from "./scene-routes";

// z75-49 (작업 Z78): 발표 장면 ↔ 해시 주소(Z83-05 메뉴 7개) 표(parallel/Z78/SCENES.md)대로
//   (1) 딥링크: 주소로 바로 열기 → 보여 줄 요소가 보일 때까지 ms, HTTP 상태
//   (2) 메뉴 경로: "/" 에서 왼쪽 메뉴를 눌러 같은 요소가 보일 때까지 ms
// 이전 하나가 필요한 페이지(비용·모니터링·보안·AI)는 가장 최근 이전을 localStorage(web.selected)로 미리 골라 둔다. 앱 코드는 안 건드린다.
// 결과: DEEPLINK_JSON 파일 {"routes":[{"id","url","status","deepMs","menuMs"}]}. 기준(전부 200, 딥링크 ≤1초)은 rehearse.sh 가 판정
const OUT = process.env.DEEPLINK_JSON;
const TENANT = "11111111-1111-4111-8111-111111111111";

test("장면 딥링크 vs 메뉴 경로", async ({ page, request }) => {
  const r = await request.get("/api/migrations", { headers: { "x-dev-tenant": TENANT } });
  const items = ((await r.json()) as { items?: Array<{ id: string }> }).items ?? [];
  const mid = items[0]?.id ?? "";
  await page.addInitScript(([t, m]) => {
    localStorage.setItem("web.tenant", t);
    if (m) { localStorage.setItem("web.selected", m); localStorage.setItem("web.knownMigrations", JSON.stringify([m])); }
  }, [TENANT, mid]);
  // z75-53 (Z83-09): 첫 goto 는 ?reset=1 — 지난 회차의 숨김·선택 표식을 지우고 시작 (주소에서 reset 은 화면이 뗀다)
  await page.goto("/?reset=1#/dashboard");
  const out: Array<{ id: string; url: string; status: number; deepMs: number; menuMs: number }> = [];
  for (const rt of ROUTES) {
    await page.goto("about:blank");
    let t = performance.now();
    const resp = await page.goto("/" + rt.hash);
    await expect(page.locator(rt.sel).first()).toBeVisible();
    const deepMs = Math.round(performance.now() - t);
    await page.goto("/");
    await expect(page.locator("nav.menu").first()).toBeVisible();
    t = performance.now();
    await page.locator(`nav.menu a.mi[href="${rt.hash}"]`).first().click();
    await expect(page.locator(rt.sel).first()).toBeVisible();
    const menuMs = Math.round(performance.now() - t);
    out.push({ id: rt.id, url: rt.hash, status: resp?.status() ?? 0, deepMs, menuMs });
  }
  if (OUT) writeFileSync(OUT, JSON.stringify({ migration: mid.slice(0, 8), routes: out }));
});
