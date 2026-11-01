import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { ROUTES } from "./scene-routes";

// z75-54 (작업 Z78, Z62 주제 56): 발표 화면이 1920×1080 모니터에서 브라우저 확대 100%·125%·150% 일 때 잘리지 않는지 본다.
// 브라우저 확대 N% = CSS 뷰포트가 1/N 로 줄고 devicePixelRatio 가 N 배. 그래서 조건을 (1920×1080, 1) (1536×864, 1.25) (1280×720, 1.5) 로 흉내 낸다.
// 장면 9개 = SCENES.md 화면 장면 8개(한눈에·이전 목록·진행 칸·비용·모니터링·보안·AI·API 문서) + Grafana(떠 있을 때만).
// 장면마다 본다: 가로 스크롤 0 (문서 scrollWidth ≤ 창 너비), 보여 줄 요소가 보이고 가로로 창 안에 다 들어옴, 왼쪽 메뉴 보임·마지막 항목이 창 높이 안(우리 화면만),
//   창 오른쪽 밖으로 나간 요소 수(overN, 가로 스크롤 없이 잘린 것 포함).
// 잘리면 창 밖으로 나간 요소 3개(태그.클래스, 오른쪽 끝 px)를 적는다 → Z83 CSS 요청 근거. 장면 사진: VIEWPORT_OUTDIR/<조건>-<장면>.png
// 결과: VIEWPORT_JSON {"conds":[...],"rows":[{"cond","scene","status","hscroll","visible","inside","menu","over":[...]}]}. 판정은 rehearse.sh --viewports
const OUT = process.env.VIEWPORT_JSON;
const SHOTS = process.env.VIEWPORT_OUTDIR;
const GRAFANA = process.env.GRAFANA_URL ?? "http://localhost:3001";
const TENANT = "11111111-1111-4111-8111-111111111111";
const CONDS = [
  { id: "100", w: 1920, h: 1080, dpr: 1 },
  { id: "125", w: 1536, h: 864, dpr: 1.25 },
  { id: "150", w: 1280, h: 720, dpr: 1.5 },
];
const r = (id: string) => ROUTES.find((x) => x.id === id)!;
const SCENES: Array<{ id: string; url: string; sel: string; ours: boolean }> = [
  { id: "S0-dashboard", url: "/" + r("dashboard").hash, sel: r("dashboard").sel, ours: true },
  { id: "S1-list", url: "/" + r("migrations").hash, sel: r("migrations").sel, ours: true },
  { id: "S4-stepper", url: "/" + r("migrations").hash, sel: ".stepper li", ours: true },
  { id: "S5-cost", url: "/" + r("cost").hash, sel: r("cost").sel, ours: true },
  { id: "S5-monitoring", url: "/" + r("monitoring").hash, sel: r("monitoring").sel, ours: true },
  { id: "S6-security", url: "/" + r("security").hash, sel: r("security").sel, ours: true },
  { id: "S7-agent", url: "/" + r("agent").hash, sel: r("agent").sel, ours: true },
  { id: "Q-docs", url: "/" + r("docs").hash, sel: r("docs").sel, ours: true },
  { id: "Q-grafana", url: GRAFANA + "/", sel: "body", ours: false },
];

test("장면 9개 × 확대 3조건: 가로 스크롤·잘림", async ({ browser, request, baseURL }) => {
  test.setTimeout(180_000);
  const res = await request.get("/api/migrations", { headers: { "x-dev-tenant": TENANT } });
  const items = ((await res.json()) as { items?: Array<{ id: string }> }).items ?? [];
  const mid = items[0]?.id ?? "";
  let grafanaUp = false;
  try { grafanaUp = (await request.get(GRAFANA + "/api/health", { timeout: 2000 })).ok(); } catch { grafanaUp = false; }
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
  const rows: Array<Record<string, unknown>> = [];
  for (const c of CONDS) {
    const ctx = await browser.newContext({ baseURL, viewport: { width: c.w, height: c.h }, deviceScaleFactor: c.dpr, locale: "ko-KR" });
    await ctx.addInitScript(([t, m]) => {
      localStorage.setItem("web.tenant", t);
      if (m) { localStorage.setItem("web.selected", m); localStorage.setItem("web.knownMigrations", JSON.stringify([m])); }
    }, [TENANT, mid]);
    const page = await ctx.newPage();
    for (const s of SCENES) {
      if (!s.ours && !grafanaUp) { rows.push({ cond: c.id, scene: s.id, status: 0, skipped: "Grafana 안 떠 있음" }); continue; }
      const resp = await page.goto(s.url);
      const loc = page.locator(s.sel).first();
      let visible = true;
      try { await expect(loc).toBeVisible({ timeout: 10_000 }); } catch { visible = false; }
      await page.waitForTimeout(150);
      const m = await page.evaluate(() => {
        const vw = window.innerWidth;
        const se = document.scrollingElement ?? document.documentElement;
        const over: Array<{ el: string; right: number }> = [];
        for (const el of Array.from(document.body.querySelectorAll<HTMLElement>("*"))) {
          const b = el.getBoundingClientRect();
          if (b.width === 0 || b.height === 0) continue;
          const st = getComputedStyle(el);
          if (st.visibility === "hidden" || st.position === "fixed") continue;
          if (b.right > vw + 1) over.push({ el: el.tagName.toLowerCase() + (el.className && typeof el.className === "string" ? "." + el.className.trim().split(/\s+/).join(".") : ""), right: Math.round(b.right) });
        }
        // 가장 바깥(부모가 목록에 없는) 것 위주로 3개
        over.sort((a, b) => b.right - a.right);
        // 왼쪽 메뉴의 마지막 항목이 창 높이 안에 있는지 (150% 에서 아래가 잘리면 S7·문서 메뉴가 안 보임)
        const items = document.querySelectorAll("nav.menu a.mi");
        const last = items[items.length - 1] as HTMLElement | undefined;
        const menuFits = last ? last.getBoundingClientRect().bottom <= window.innerHeight + 1 : false;
        return { vw, hscroll: Math.max(0, se.scrollWidth - se.clientWidth), overN: over.length, over: over.slice(0, 3), menu: !!document.querySelector("nav.menu"), menuFits };
      });
      let inside = false;
      if (visible) { const b = await loc.boundingBox(); inside = !!b && b.x >= 0 && b.x + b.width <= m.vw + 1; }
      if (SHOTS) await page.screenshot({ path: join(SHOTS, `${c.id}-${s.id}.png`) });
      // 해시만 바뀌는 이동은 응답이 없다(null) → 상태 칸은 새 문서를 연 장면만
      rows.push({ cond: c.id, scene: s.id, status: resp ? resp.status() : null, hscroll: m.hscroll, visible, inside,
        menu: s.ours ? m.menu : null, menuFits: s.ours ? m.menuFits : null, overN: m.overN, over: m.over });
    }
    await ctx.close();
  }
  if (OUT) writeFileSync(OUT, JSON.stringify({ migration: mid.slice(0, 8), conds: CONDS, rows }));
});
