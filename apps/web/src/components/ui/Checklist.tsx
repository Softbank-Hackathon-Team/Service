import { Icon } from './Icon';
import s from './Checklist.module.css';
import { t } from '../../lib/i18n';

/** waiting 은 사람의 입력을 기다리는 칸이다. 기계가 도는 칸(active)과 달리 돌지 않는다. */
export type ChecklistStatus = 'done' | 'active' | 'waiting' | 'pending' | 'paused' | 'failed';

export type ChecklistEntry = {
  status: ChecklistStatus;
  label: string;
  detail?: string;
  /** 지금 이 칸의 화면을 보고 있다 (진행 단계 카드의 지난 단계 보기) */
  selected?: boolean;
  /** 주면 칸 전체가 버튼이 된다 */
  onSelect?: () => void;
};

const STATUS_LABEL: Record<ChecklistStatus, string> = {
  done: t('끝남'),
  active: t('진행 중'),
  waiting: t('입력 기다림'),
  pending: t('대기'),
  paused: t('멈춤'),
  failed: t('실패'),
};

function Marker({ status }: { status: ChecklistStatus }) {
  if (status === 'active') return <span className={s.spinner} />;
  if (status === 'waiting')
    return (
      <svg className={s.waiting} viewBox="0 0 20 20" aria-hidden="true">
        <circle cx="10" cy="10" r="9" />
        <circle className={s.waitingDot} cx="6" cy="10" r="1.4" />
        <circle className={s.waitingDot} cx="10" cy="10" r="1.4" />
        <circle className={s.waitingDot} cx="14" cy="10" r="1.4" />
      </svg>
    );
  if (status === 'pending') return <span className={s.pendingRing} />;
  const icon = status === 'done' ? 'check' : status === 'failed' ? 'x' : 'pause';
  return (
    <span className={`${s.disc} ${s[status]}`}>
      <Icon name={icon} size={12} />
    </span>
  );
}

export function Checklist({ items }: { items: ChecklistEntry[] }) {
  return (
    <ol className={s.list}>
      {items.map((item) => {
        const body = (
          <>
            <span className={s.marker} role="img" aria-label={STATUS_LABEL[item.status]}>
              <Marker status={item.status} />
            </span>
            <span className={`${s.label} t-body-md`}>{item.label}</span>
            {item.detail && <span className={`${s.detail} t-caption`}>{item.detail}</span>}
          </>
        );
        return (
          <li
            key={item.label}
            className={`${s.item} ${item.status === 'pending' ? s.muted : ''}`}
            data-status={item.status}
            data-selected={item.selected || undefined}
          >
            {item.onSelect ? (
              <button type="button" className={s.select} aria-current={item.selected ? 'step' : undefined} onClick={item.onSelect}>
                {body}
              </button>
            ) : (
              body
            )}
          </li>
        );
      })}
    </ol>
  );
}
