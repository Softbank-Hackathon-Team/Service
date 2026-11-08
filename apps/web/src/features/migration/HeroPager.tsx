import { useRef, useState, type ReactNode } from 'react';
import { Icon } from '../../components/ui/Icon';
import { t } from '../../lib/i18n';
import s from './HeroPager.module.css';

export type HeroPage = { id: string; label: string; /** 탭 옆 작은 숫자 (남은 확인 수 등) */ count?: number | null; content: ReactNode };

// 손가락·트랙패드로 이만큼 옆으로 밀면 넘긴다
const SWIPE_PX = 56;

/**
 * 큰 카드 안에서 같은 높이의 판을 옆으로 넘긴다. 위는 탭(어느 판인지)과 ← → 버튼, 아래는 판이 옆으로 미끄러지는 칸.
 * 판마다 남은 높이만큼만 쓰고 넘치면 그 판만 스크롤한다. 키보드 ←·→, 옆으로 밀기도 넘긴다
 */
export function HeroPager({ pages, initial, label }: { pages: HeroPage[]; initial?: string; label: string }) {
  const [picked, setPicked] = useState(() => Math.max(0, pages.findIndex((page) => page.id === initial)));
  const at = Math.min(picked, pages.length - 1);
  const start = useRef<number | null>(null);
  const go = (index: number) => setPicked(Math.max(0, Math.min(pages.length - 1, index)));
  if (pages.length === 0) return null;
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
              onClick={() => go(index)}
              onKeyDown={(event) => {
                if (event.key === 'ArrowRight') go(at + 1);
                if (event.key === 'ArrowLeft') go(at - 1);
              }}
            >
              {page.label}
              {page.count ? <span className={`${s.count} t-caption`}>{page.count}</span> : null}
            </button>
          ))}
        </div>
        <div className={s.nav}>
          <span className={`${s.dots}`} aria-hidden="true">
            {pages.map((page, index) => <span key={page.id} className={s.dot} data-on={index === at || undefined} />)}
          </span>
          <button type="button" className={s.arrow} aria-label={t('이전 판')} disabled={at === 0} onClick={() => go(at - 1)}>
            <Icon name="arrow-left" />
          </button>
          <button type="button" className={s.arrow} aria-label={t('다음 판')} disabled={at === pages.length - 1} onClick={() => go(at + 1)}>
            <Icon name="arrow-right" />
          </button>
        </div>
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
