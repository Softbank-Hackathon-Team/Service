import { Children, isValidElement, useState, type CSSProperties, type ReactNode } from 'react';
import { Icon, type IconName } from '../ui/Icon';
import { SkeletonRows } from '../ui/Skeleton';
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
  const className = [s.tile, s.surface, spread && s.spread, compact && s.compact, scroll && `${s.scroll} scroll-fade`]
    .filter(Boolean)
    .join(' ');
  return (
    <section className={className} style={areaStyle(area)}>
      {children}
    </section>
  );
}

/**
 * 벤토 한 칸에 카드를 쌓는다. 행동 버튼(ActionRow)은 카드 묶음과 따로 맨 아래 줄을 차지해서 카드를 덮지 않는다.
 * 카드가 길면 카드 묶음만 스크롤한다. 좁은 화면에서는 행동 버튼 줄이 벤토 끝(dock)으로 가서 화면 아래에 붙는다.
 */
export function Stack({ area, children }: { area: string; children: ReactNode }) {
  const items = Children.toArray(children);
  const isDock = (item: ReactNode) => isValidElement(item) && item.type === ActionRow;
  return (
    <div className={s.stack} style={areaStyle(area)}>
      <div className={`${s.stackBody} scroll-fade`} style={{ '--stack-area': area } as CSSProperties}>
        {items.filter((item) => !isDock(item))}
      </div>
      {items.filter(isDock)}
    </div>
  );
}

type ActionRowProps = {
  before?: ReactNode;
  notice?: string | null;
  children: ReactNode;
};

/** 행동 버튼 줄. Stack 안에서는 카드 묶음 아래 자기 줄을 차지한다. */
export function ActionRow({ before, notice, children }: ActionRowProps) {
  return (
    <div className={s.actionDock} data-dock>
      {before}
      {notice && (
        <p className={`${s.actionNotice} t-body-md`} role="alert">
          {notice}
        </p>
      )}
      <div className={s.actionRow}>{children}</div>
    </div>
  );
}

type FoldTileProps = {
  title: string;
  summary?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
};

/** 얇은 테두리의 접는 카드. 머리줄 오른쪽에 요약을 두어 접어도 상태가 보인다. 쌓아서 쓴다. */
export function FoldTile({ title, summary, defaultOpen = true, children }: FoldTileProps) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className={s.fold} data-open={open}>
      <button type="button" className={s.foldHead} aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className={s.foldTitle}>
          <span className="t-label-md">{title}</span>
          <span className={`${s.foldChevron} ${open ? s.foldOpen : ''}`}>
            <Icon name="chevron" size={14} />
          </span>
        </span>
        {summary && <span className="t-caption c-tertiary">{summary}</span>}
      </button>
      {open && <div className={s.foldBody}>{children}</div>}
    </section>
  );
}

export type HeroTone = 'run' | 'stop' | 'done';

type HeroProps = {
  area?: string;
  tone: HeroTone;
  meta: string;
  step?: string;
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
        {step && <span className={`${s.heroStep} t-label-md`}>{step}</span>}
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

/** 읽는 동안의 칸. 빈 카드 대신 줄 모양으로 자리를 잡는다. */
export function SkeletonTile({ area, title, rows = 6 }: { area: string; title: string; rows?: number }) {
  return (
    <Tile area={area} compact>
      <TileHeader title={title} />
      <SkeletonRows count={rows} />
    </Tile>
  );
}
