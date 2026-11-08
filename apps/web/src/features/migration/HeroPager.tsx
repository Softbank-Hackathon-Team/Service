import { useRef, type ReactNode } from 'react';
import s from './HeroPager.module.css';

export type HeroPage = { id: string; label: string; /** 탭 옆 작은 숫자 (줄 수 등) */ count?: number | null; /** 확인을 마친 판 (탭에 체크) */ done?: boolean; content: ReactNode };

// 손가락·트랙패드로 이만큼 옆으로 밀면 넘긴다
const SWIPE_PX = 56;

/**
 * 큰 카드 안에서 같은 높이의 판을 옆으로 넘긴다. 위는 탭(어느 판인지)과 지금 판 점, 아래는 판이 옆으로 미끄러지는 칸.
 * 어느 판을 볼지는 화면이 정한다(at·onPick): 행동 버튼(확인·뒤로)도 판을 옮기기 때문이다.
 * 판마다 남은 높이만큼만 쓰고 넘치면 그 판만 스크롤한다. 탭·키보드 ←→·옆으로 밀기로도 넘긴다
 */
export function HeroPager({ pages, at: picked, onPick, label }: { pages: HeroPage[]; at: number; onPick: (index: number) => void; label: string }) {
  const start = useRef<number | null>(null);
  if (pages.length === 0) return null;
  const at = Math.max(0, Math.min(picked, pages.length - 1));
  const go = (index: number) => onPick(Math.max(0, Math.min(pages.length - 1, index)));
  return (
    <div className={s.pager}>
      <div className={s.bar}>
        <div className={s.tabs} role="tablist" aria-label={label}>
          {pages.map((page, index) => (
            <button
              key={page.id}
              type="button"
              role="tab"
              id={`hero-tab-${page.id}`}
              aria-selected={index === at}
              aria-controls={`hero-page-${page.id}`}
              className={`${s.tab} t-label-md`}
              data-done={page.done || undefined}
              onClick={() => go(index)}
              onKeyDown={(event) => {
                if (event.key === 'ArrowRight') go(at + 1);
                if (event.key === 'ArrowLeft') go(at - 1);
              }}
            >
              {page.done && (
                <svg className={s.tabTick} viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
                  <path d="M20 6 9 17l-5-5" />
                </svg>
              )}
              {page.label}
              {page.count ? <span className={`${s.count} t-caption`}>{page.count}</span> : null}
            </button>
          ))}
        </div>
        <span className={s.dots} aria-hidden="true">
          {pages.map((page, index) => <span key={page.id} className={s.dot} data-on={index === at || undefined} />)}
        </span>
      </div>
      <div
        className={s.viewport}
        onPointerDown={(event) => {
          if (event.pointerType !== 'mouse') start.current = event.clientX;
        }}
        onPointerUp={(event) => {
          if (start.current === null) return;
          const dx = event.clientX - start.current;
          start.current = null;
          if (Math.abs(dx) > SWIPE_PX) go(at + (dx < 0 ? 1 : -1));
        }}
      >
        <div className={s.track} style={{ transform: `translateX(${-at * 100}%)` }}>
          {pages.map((page, index) => (
            <section
              key={page.id}
              id={`hero-page-${page.id}`}
              role="tabpanel"
              aria-labelledby={`hero-tab-${page.id}`}
              className={`${s.page} scroll-fade`}
              data-on={index === at || undefined}
              inert={index !== at}
            >
              {page.content}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
