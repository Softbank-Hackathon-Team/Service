import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Icon, type IconName } from './Icon';
import s from './controls.module.css';
import { t } from '../../lib/i18n';

type ActionPillProps = {
  label: string;
  icon?: IconName;
  tone?: 'tile' | 'danger';
  disabled?: boolean;
  type?: 'button' | 'submit';
  onClick?: () => void;
};

/** 글이 칸보다 길어 끝이 잘렸을 때만 전체 글을 툴팁으로 단다 */
function useClippedTitle(label: string) {
  const ref = useRef<HTMLSpanElement>(null);
  const [clipped, setClipped] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const check = () => setClipped(el.scrollWidth > el.clientWidth);
    check();
    const observer = new ResizeObserver(check);
    observer.observe(el);
    return () => observer.disconnect();
  }, [label]);
  return { ref, title: clipped ? label : undefined };
}

/**
 * 화면에 하나뿐인 지금 할 행동. 항상 오른쪽 아래에 둔다.
 * 행동 줄(ActionRow)에서는 작은 버튼 오른쪽 끝에 붙고(data-primary), 줄이 모자라면 줄을 바꾸지 않고 글 끝을 줄인다
 */
export function ActionPill({ label, icon = 'arrow-right', tone = 'tile', disabled, type = 'button', onClick }: ActionPillProps) {
  const text = useClippedTitle(label);
  return (
    <button type={type} data-primary className={`${s.action} ${s[tone]} t-h3`} disabled={disabled} title={text.title} onClick={onClick}>
      <span className={s.disc}>
        <Icon name={icon} size={20} />
      </span>
      <span ref={text.ref} className={s.actionLabel}>{label}</span>
    </button>
  );
}

type BarPillProps = {
  label: string;
  icon?: IconName;
  tone?: 'default' | 'danger';
  onClick?: () => void;
};

/** 상단 바의 조작과 작은 보조 행동. onClick이 없으면 표시만 한다. */
export function BarPill({ label, icon, tone = 'default', onClick }: BarPillProps) {
  const className = `${s.bar} ${tone === 'danger' ? s.barDanger : ''} t-label-md`;
  const content = (
    <>
      {icon && <Icon name={icon} />}
      {label}
    </>
  );
  return onClick ? (
    <button type="button" className={`${className} ${s.barButton}`} onClick={onClick}>
      {content}
    </button>
  ) : (
    <span className={className}>{content}</span>
  );
}

export function AccountPill({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" className={`${s.account} t-label-md`} onClick={onClick}>
      <span className={s.accountDisc}>
        <Icon name="user-check" />
      </span>
      {label}
    </button>
  );
}

export type NavItem = { id: string; label: string };

/** 상단 진입점. 사이드바 대신 한 줄로 둔다. */
export function NavPills({ items, current, onSelect }: { items: NavItem[]; current: string | null; onSelect: (id: string) => void }) {
  return (
    <nav className={s.nav} aria-label={t('주요 화면')}>
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          aria-current={item.id === current ? 'page' : undefined}
          className={`${s.navItem} ${item.id === current ? s.navCurrent : ''} t-label-md`}
          onClick={() => onSelect(item.id)}
        >
          {item.label}
        </button>
      ))}
    </nav>
  );
}

export type BadgeTone = 'neutral' | 'warning' | 'success' | 'info' | 'danger';

export function Badge({ tone = 'neutral', children }: { tone?: BadgeTone; children: ReactNode }) {
  return <span className={`${s.badge} ${s[`badge-${tone}`]} t-label-sm`}>{children}</span>;
}

export function LiveIndicator({ label = t('실시간') }: { label?: string }) {
  return (
    <span className={`${s.live} t-caption`}>
      <span className={s.liveDot} aria-hidden="true" />
      {label}
    </span>
  );
}

type OptionPillProps = {
  label: string;
  icon?: IconName;
  selected: boolean;
  /** 여럿 중 고르기가 아니라 항목 하나를 확인하는 칸이면 체크 상자로 읽힌다 (계획 승인 확인 항목) */
  checkbox?: boolean;
  disabled?: boolean;
  onClick: () => void;
};

export function OptionPill({ label, icon, selected, checkbox, disabled, onClick }: OptionPillProps) {
  return (
    <button
      type="button"
      {...(checkbox ? { role: 'checkbox', 'aria-checked': selected } : { 'aria-pressed': selected })}
      disabled={disabled}
      className={`${s.option} ${selected ? s.optionSelected : ''} t-label-md`}
      onClick={onClick}
    >
      {icon && <Icon name={icon} />}
      {label}
    </button>
  );
}
