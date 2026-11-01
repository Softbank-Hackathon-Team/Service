import type { CSSProperties, ReactNode } from 'react';
import { Icon, type IconName } from '../ui/Icon';
import s from './tiles.module.css';

const areaStyle = (area: string) => ({ gridArea: area, viewTransitionName: `tile-${area}` }) as CSSProperties;

type TileProps = {
  area: string;
  spread?: boolean;
  compact?: boolean;
  scroll?: boolean;
  children: ReactNode;
};

/** 벤토의 한 칸. area 이름이 같으면 화면이 바뀔 때 같은 타일로 이어져 움직인다. */
export function Tile({ area, spread, compact, scroll, children }: TileProps) {
  const className = [s.tile, s.surface, spread && s.spread, compact && s.compact, scroll && s.scroll]
    .filter(Boolean)
    .join(' ');
  return (
    <section className={className} style={areaStyle(area)}>
      {children}
    </section>
  );
}

export type HeroTone = 'run' | 'stop' | 'done';

type HeroProps = {
  area?: string;
  tone: HeroTone;
  meta: string;
  step: string;
  title: string;
  foot?: ReactNode;
  children?: ReactNode;
};

/** 화면의 주인공. 경고(stop)만 카드를 빨갛게 칠하고, 나머지는 머리줄의 글자와 원 색으로만 상태를 알린다. */
export function Hero({ area = 'hero', tone, meta, step, title, foot, children }: HeroProps) {
  return (
    <section className={`${s.hero} ${s[tone] ?? ''}`} style={areaStyle(area)}>
      <div className={s.heroMeta}>
        <span className="t-label-md">{meta}</span>
        <span className={`${s.heroStep} t-label-md`}>{step}</span>
      </div>
      <div className={s.heroContent}>
        <h2 className={`${s.heroTitle} t-display`}>{title}</h2>
        {children}
      </div>
      {foot && <p className={`${s.heroFoot} t-body-md`}>{foot}</p>}
    </section>
  );
}

type StatTileProps = {
  area: string;
  icon: IconName;
  value: string;
  unit?: string;
  label: string;
  compact?: boolean;
};

export function StatTile({ area, icon, value, unit, label, compact }: StatTileProps) {
  return (
    <Tile area={area} spread compact={compact}>
      <span className={s.statIcon}>
        <Icon name={icon} size={20} />
      </span>
      <div>
        <p className={s.statValue}>
          <span className="t-metric-xl">{value}</span>
          {unit && <span className="t-h3 c-secondary">{unit}</span>}
        </p>
        <p className="t-body-md c-secondary">{label}</p>
      </div>
    </Tile>
  );
}

export function TileHeader({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <div className={s.tileHeader}>
      <h3 className="t-h3 c-secondary">{title}</h3>
      {action}
    </div>
  );
}

export function TileLink({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" className={`${s.tileLink} t-label-sm`} onClick={onClick}>
      {label}
      <Icon name="chevron" size={12} />
    </button>
  );
}
