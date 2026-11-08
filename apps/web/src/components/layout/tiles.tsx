import { Children, createContext, isValidElement, useContext, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { backAction } from '../../app/nav';
import { t } from '../../lib/i18n';
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

/** 접는 카드를 어떻게 그릴지. tile = 격자 칸을 채우는 고정 카드 (늘 펼침, 머리줄은 누르지 않음, 넘치면 카드 안만 스크롤) */
const FoldMode = createContext<'fold' | 'tile'>('fold');

/**
 * 근거 카드 격자 (11/08 사용자 결정: 접지 않는 벤토 타일). 두 칸 너비에 첫 카드는 가로 전체, 그다음은 두 장씩 나란히,
 * 마지막에 한 장이 남으면 가로 전체. 줄 높이는 칸을 나눠 갖고(첫 줄이 조금 크다) 카드 안만 스크롤한다.
 * 카드는 접는 카드(FoldTile)를 그대로 넣으면 고정 타일로 그린다
 */
export function CardGrid({ area, children }: { area: string; children: ReactNode }) {
  return (
    <FoldMode.Provider value="tile">
      <div className={s.cardGrid} style={areaStyle(area)}>
        {children}
      </div>
    </FoldMode.Provider>
  );
}

/** 행동 버튼 칸. 벤토 오른쪽 아래 모퉁이에 붙는다 */
export function Dock({ area, children }: { area: string; children: ReactNode }) {
  return (
    <div className={s.dock} style={areaStyle(area)}>
      {children}
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

// tokens.css --motion-fold 와 같은 값. 펼침이 끝난 뒤 위치를 잰다
const FOLD_MS = 300;

/**
 * 연 카드가 스크롤 칸 아래로 잘리면 잘린 만큼만 올린다. 카드 머리줄이 칸 위로 넘어가지는 않게 한다.
 * 스크롤 칸이 없으면(좁은 화면 쌓기) 문서 전체를 기준으로 한다.
 */
function revealInScroller(el: HTMLElement) {
  let scroller: HTMLElement | null = el.parentElement;
  while (scroller && !(scroller.scrollHeight > scroller.clientHeight && /(auto|scroll)/.test(getComputedStyle(scroller).overflowY))) {
    scroller = scroller.parentElement;
  }
  const box = el.getBoundingClientRect();
  const view = scroller ? scroller.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
  const delta = Math.min(box.bottom - view.bottom, box.top - view.top);
  if (delta <= 0) return;
  const behavior: ScrollBehavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
  (scroller ?? window).scrollBy({ top: delta, behavior });
}

/**
 * 얇은 테두리의 접는 카드. 머리줄 오른쪽에 요약을 두어 접어도 상태가 보인다. 쌓아서 쓴다.
 * 열고 닫을 때 높이가 미끄러지듯 바뀐다. 내용은 처음 열 때 그리고, 닫아도 남겨 두어 닫히는 동안에도 보인다.
 */
export function FoldTile({ title, summary, defaultOpen = true, children }: FoldTileProps) {
  const tile = useContext(FoldMode) === 'tile';
  const [open, setOpen] = useState(defaultOpen);
  const [drawn, setDrawn] = useState(defaultOpen);
  const ref = useRef<HTMLElement>(null);
  const toggle = () => {
    setDrawn(true);
    setOpen(!open);
    // 칸 아래쪽에서 연 카드는 열린 내용이 보이도록 칸을 조금 올린다 (펼침이 끝난 뒤)
    if (!open) window.setTimeout(() => ref.current && revealInScroller(ref.current), FOLD_MS);
  };
  if (tile)
    return (
      <section className={`${s.fold} ${s.foldTile}`} data-open="true">
        <div className={s.foldHead}>
          <h3 className="t-label-md">{title}</h3>
          {summary && <span className="t-caption c-tertiary">{summary}</span>}
        </div>
        <div className={`${s.foldTileBody} scroll-fade`}>{children}</div>
      </section>
    );
  return (
    <section ref={ref} className={s.fold} data-open={open}>
      <button type="button" className={s.foldHead} aria-expanded={open} onClick={toggle}>
        <span className={s.foldTitle}>
          <span className="t-label-md">{title}</span>
          <span className={`${s.foldChevron} ${open ? s.foldOpen : ''}`}>
            <Icon name="chevron" size={14} />
          </span>
        </span>
        {summary && <span className="t-caption c-tertiary">{summary}</span>}
      </button>
      <div className={s.foldBody} inert={!open}>
        <div className={s.foldClip}>
          <div className={s.foldContent}>{drawn && children}</div>
        </div>
      </div>
    </section>
  );
}

export type HeroTone = 'run' | 'stop' | 'done';

type HeroProps = {
  area?: string;
  tone: HeroTone;
  meta: string;
  step?: string;
  /** 머리줄 오른쪽 끝에 두는 작은 버튼 (예: 계정 화면의 환경 추가하기) */
  action?: ReactNode;
  /**
   * 머리줄 왼쪽 끝 (←). 비우면 앱 안 바로 앞 화면(없으면 윗 화면, 그것도 없으면 버튼 없음).
   * 주소는 그대로 두고 화면 안에서 단계를 넘기는 곳(새 마이그레이션 · 환경 등록)은 한 단계 앞으로 가는 함수를 준다. false 면 두지 않는다
   */
  back?: false | (() => void);
  title: string;
  foot?: ReactNode;
  children?: ReactNode;
};

/** 화면의 주인공. 경고(stop)만 카드를 빨갛게 칠하고, 나머지는 머리줄의 글자와 원 색으로만 상태를 알린다. */
export function Hero({ area = 'hero', tone, meta, step, action, back, title, foot, children }: HeroProps) {
  const onBack = back === false ? null : (back ?? backAction());
  const metaText = <span className="t-label-md">{meta}</span>;
  return (
    <section className={`${s.hero} ${s[tone] ?? ''}`} style={areaStyle(area)}>
      <div className={s.heroMeta}>
        {onBack ? (
          <span className={s.heroMetaStart}>
            <button type="button" className={s.heroBack} aria-label={t('뒤로')} title={t('뒤로')} onClick={onBack}>
              <Icon name="arrow-left" size={20} />
            </button>
            {metaText}
          </span>
        ) : (
          metaText
        )}
        {step && <span className={`${s.heroStep} t-label-md`}>{step}</span>}
        {action}
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
