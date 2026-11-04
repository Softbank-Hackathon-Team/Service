import type { ReactNode } from 'react';
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

/** 화면에 하나뿐인 지금 할 행동. 항상 오른쪽 아래에 둔다. */
export function ActionPill({ label, icon = 'arrow-right', tone = 'tile', disabled, type = 'button', onClick }: ActionPillProps) {
  return (
    <button type={type} className={`${s.action} ${s[tone]} t-h3`} disabled={disabled} onClick={onClick}>
      <span className={s.disc}>
        <Icon name={icon} size={20} />
      </span>
      {label}
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
  onClick: () => void;
};

export function OptionPill({ label, icon, selected, onClick }: OptionPillProps) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      className={`${s.option} ${selected ? s.optionSelected : ''} t-label-md`}
      onClick={onClick}
    >
      {icon && <Icon name={icon} />}
      {label}
    </button>
  );
}
