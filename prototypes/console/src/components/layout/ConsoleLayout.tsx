import type { CSSProperties, ReactNode } from 'react';
import { AccountPill, Badge } from '../ui/controls';
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
  headline?: string;
  sub?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
};

/** 모든 화면의 3층 뼈대: 상단 바, 벤토, 하단 행동. headline이 없으면 벤토가 아래까지 찬다. */
export function ConsoleLayout({ layout, nav, onAccount, barLeft, barRight, headline, sub, actions, children }: ConsoleLayoutProps) {
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
          <Badge>예시 데이터</Badge>
          {onAccount && <AccountPill label="계정" onClick={onAccount} />}
        </div>
      </header>
      <main className={s.bento} style={bentoStyle}>
        {children}
      </main>
      {headline && (
        <footer className={s.band}>
          <div className={s.headline}>
            <h1 className="t-display">{headline}</h1>
            {sub && <p className="t-body-md c-secondary">{sub}</p>}
          </div>
          <div className={s.actions}>{actions}</div>
        </footer>
      )}
    </div>
  );
}
