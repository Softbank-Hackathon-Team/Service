import { useState, type ReactNode } from 'react';
import { Icon } from '../../components/ui/Icon';
import s from './page.module.css';

/**
 * 접는 카드(FoldTile) 안의 작은 묶음. 카드 하나에 다 담되, 긴 묶음은 접어 둔다.
 * 보안 카드와 비용 카드가 같이 쓴다. 머리줄 오른쪽 요약은 접어도 보인다
 */
export function Section({ title, summary, defaultOpen = false, children }: { title: string; summary?: ReactNode; defaultOpen?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={s.sub}>
      <button type="button" className={s.subHead} aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className={s.formRow}>
          <span className="t-label-md">{title}</span>
          <span className={`${s.subChevron} ${open ? s.subOpen : ''}`}>
            <Icon name="chevron" size={12} />
          </span>
        </span>
        {summary !== undefined && <span className="t-caption c-tertiary">{summary}</span>}
      </button>
      {open && <div className={s.subBody}>{children}</div>}
    </div>
  );
}
