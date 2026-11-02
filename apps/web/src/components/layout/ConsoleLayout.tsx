import type { CSSProperties, ReactNode } from 'react';
import { AccountPill } from '../ui/controls';
import { Logo } from '../ui/Logo';
import s from './ConsoleLayout.module.css';

/** 칸 너비. 큰 카드(fill)만 늘고 줄며, 나머지는 토큰으로 고정한다. */
const COLUMN = {
  fill: 'minmax(0, 1fr)',
  narrow: 'var(--col-narrow)',
  side: 'var(--col-side)',
  wide: 'var(--col-wide)',
} as const;

export type BentoColumn = keyof typeof COLUMN;

/**
 * 벤토의 모양. 한 화면 안에서는 상태가 바뀌어도 같은 모양을 쓰고, 빈 칸은 비워 둔다.
 * 좁은 화면에서는 hero를 맨 앞에, 나머지는 areas에 적은 순서로 한 줄로 쌓는다.
 */
export type BentoLayout = {
  columns: BentoColumn[];
  areas: string;
};

/** 좁은 화면에서 쌓는 순서: 큰 카드, 그 밖의 칸, 행동 버튼 줄. */
export function stackOrder(areas: string) {
  const names = [...new Set(areas.split(/\s+/).filter(Boolean))];
  return [...names.filter((name) => name === 'hero'), ...names.filter((name) => name !== 'hero'), 'dock'];
}

export type ConsoleLayoutProps = {
  layout: BentoLayout;
  nav?: ReactNode;
  onAccount?: () => void;
  barLeft?: ReactNode;
  barRight?: ReactNode;
  children: ReactNode;
};

/** 모든 화면의 뼈대: 상단 바와 벤토. 행동 버튼은 벤토 안 오른쪽 아래에 둔다. */
export function ConsoleLayout({ layout, nav, onAccount, barLeft, barRight, children }: ConsoleLayoutProps) {
  const bentoStyle = {
    '--bento-columns': layout.columns.map((column) => COLUMN[column]).join(' '),
    '--bento-areas': `"${layout.areas}"`,
    '--bento-stack': stackOrder(layout.areas).map((area) => `"${area}"`).join(' '),
  } as CSSProperties;

  return (
    <div className={s.root}>
      <header className={s.topBar}>
        <div className={s.barGroup}>
          <Logo />
          {nav}
          {barLeft}
        </div>
        <div className={s.barGroup}>
          {barRight}
          {onAccount && <AccountPill label="계정" onClick={onAccount} />}
        </div>
      </header>
      <main className={s.bento} style={bentoStyle}>
        {children}
      </main>
    </div>
  );
}
