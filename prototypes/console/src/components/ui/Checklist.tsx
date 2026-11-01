import { Icon } from './Icon';
import s from './Checklist.module.css';

export type ChecklistStatus = 'done' | 'active' | 'pending' | 'paused' | 'failed';

export type ChecklistEntry = {
  status: ChecklistStatus;
  label: string;
  detail?: string;
};

const STATUS_LABEL: Record<ChecklistStatus, string> = {
  done: '끝남',
  active: '진행 중',
  pending: '대기',
  paused: '멈춤',
  failed: '실패',
};

function Marker({ status }: { status: ChecklistStatus }) {
  if (status === 'active') return <span className={s.spinner} />;
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
      {items.map((item) => (
        <li key={item.label} className={`${s.item} ${item.status === 'pending' ? s.muted : ''}`}>
          <span className={s.marker} role="img" aria-label={STATUS_LABEL[item.status]}>
            <Marker status={item.status} />
          </span>
          <span className={`${s.label} t-body-md`}>{item.label}</span>
          {item.detail && <span className={`${s.detail} t-caption`}>{item.detail}</span>}
        </li>
      ))}
    </ol>
  );
}
