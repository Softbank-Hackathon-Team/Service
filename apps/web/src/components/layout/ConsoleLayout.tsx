import type { CSSProperties, ReactNode } from 'react';
import { AccountPill } from '../ui/controls';
import { Logo } from '../ui/Logo';
import s from './ConsoleLayout.module.css';

/** 벤토의 모양. 화면마다 이 값만 바꾸면 타일이 새 자리로 옮겨 간다. */
export type BentoLayout = {
  columns: string;
  rows: string;
  areas: string[];
};

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
    '--bento-columns': layout.columns,
    '--bento-rows': layout.rows,
    '--bento-areas': layout.areas.map((row) => `"${row}"`).join(' '),
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
