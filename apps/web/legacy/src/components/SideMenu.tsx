// 표시 메모: 왼쪽 고정 메뉴. 페이지 8개, 이전 페이지에서는 상세 칸 7개가 하위 항목으로 붙고 스크롤 위치를 표시한다. 프로토타입의 상단 버튼 내비게이션과 다른 구조다.
import { useEffect, useState } from "react";
import { PAGES, hrefOf, type PageId } from "../router";

// Z83-04/05: 왼쪽 고정 메뉴 = 페이지 7개("할 일" 동사형) + 이전 페이지 안 칸 이동.
// 페이지는 해시 라우트(#/cost …)로 바뀌고, 이전 페이지에서 이전을 골랐을 때만 상세 칸(상태·진행·계획서…)이 아래 하위 항목으로 켜진다.
// 보고 있는 칸은 굵은 왼쪽 선(aria-current)

export interface MenuItem { id: string; label: string; count?: string; sub?: boolean; off?: boolean }

// 상세 칸 목록 (MigrationDetail 의 카드 id 와 같다)
export const DETAIL_SECTIONS: { id: string; label: string }[] = [
  { id: "sec-head", label: "상태·할 일" }, { id: "sec-progress", label: "진행·타임라인" }, { id: "sec-plan", label: "계획서" },
  { id: "sec-live", label: "가동 중 앱" }, { id: "sec-cost", label: "비용" }, { id: "sec-security", label: "보안·감사" }, { id: "sec-agent", label: "AI 점검" },
];

// 보고 있는 칸 = 윗변이 화면 위쪽 45% 선을 지난 칸 중 마지막 (스크롤마다 다시 센다)
export function useActiveSection(ids: string[]): string | null {
  const [active, setActive] = useState<string | null>(null);
  const key = ids.join("|");
  useEffect(() => {
    const pick = () => {
      let last: string | null = null;
      for (const id of ids) {
        const el = document.getElementById(id);
        if (el && el.getBoundingClientRect().top <= window.innerHeight * 0.45) last = id;
      }
      setActive(last ?? ids.find((id) => document.getElementById(id)) ?? null);
    };
    window.addEventListener("scroll", pick, { passive: true });
    window.addEventListener("resize", pick);
    const t = setInterval(pick, 1000); // 칸이 생기고 없어질 때(이전 선택·상태 변화)도 따라가게
    pick();
    return () => { window.removeEventListener("scroll", pick); window.removeEventListener("resize", pick); clearInterval(t); };
  }, [key]);
  return active;
}

export function SideMenu(p: { page: PageId; counts: Partial<Record<PageId, string>>; sections: MenuItem[] }) {
  const active = useActiveSection(p.sections.filter((i) => !i.off).map((i) => i.id));
  const go = (id: string) => (e: React.MouseEvent) => {
    const el = document.getElementById(id);
    if (!el) return;
    e.preventDefault();
    el.scrollIntoView({ block: "start", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" }); // Z38 R8-41
    history.replaceState(null, "", `#${id}`);
  };
  return (
    <nav className="menu" aria-label="화면 메뉴">
      <ul>
        {PAGES.map((pg) => {
          const on = p.page === pg.id;
          return (
            <li key={pg.id} className={on ? "on" : ""}>
              <a className="mi" href={hrefOf(pg.id)} aria-current={on ? "page" : undefined} title={pg.hint}>
                <span>{pg.label}</span>{p.counts[pg.id] && <span className="mc">{p.counts[pg.id]}</span>}
              </a>
              {on && pg.id === "migrations" && p.sections.length > 0 && (
                <ul className="menu-sub">
                  {p.sections.map((it) => (
                    <li key={it.id} className={`sub${it.off ? " off" : ""}${active === it.id ? " on" : ""}`}>
                      {it.off
                        ? <span className="mi" aria-disabled="true">{it.label}</span>
                        : <a className="mi" href={`#${it.id}`} onClick={go(it.id)} aria-current={active === it.id ? "location" : undefined}>
                            <span>{it.label}</span>{it.count && <span className="mc">{it.count}</span>}
                          </a>}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
