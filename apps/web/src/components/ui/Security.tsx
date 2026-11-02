import { Icon, type IconName } from './Icon';
import s from './Security.module.css';

export type SecurityStatus = 'pass' | 'fail' | 'unknown' | 'na' | 'attested';

export const STATUS_LABEL: Record<SecurityStatus, string> = {
  pass: '통과',
  fail: '실패',
  unknown: '모름',
  na: '해당 없음',
  attested: '사람 확인',
};

const STATUS_ICON: Record<SecurityStatus, IconName> = {
  pass: 'check',
  fail: 'x',
  unknown: 'help',
  na: 'minus',
  attested: 'user-check',
};

/** 색만으로 구분하지 않도록 상태마다 모양이 다르다. */
export function SecurityDot({ status, title }: { status: SecurityStatus; title?: string }) {
  return (
    <span className={s.dot} title={title ?? STATUS_LABEL[status]} role="img" aria-label={title ?? STATUS_LABEL[status]}>
      {status === 'fail' ? (
        <span className={s.failMark}>
          <Icon name="x" size={12} />
        </span>
      ) : (
        <span className={s[`${status}Mark`]} />
      )}
    </span>
  );
}

export function SecurityCell({ status }: { status: SecurityStatus }) {
  return (
    <span className={`${s.cell} ${s[`cell-${status}`]} t-label-md`}>
      <Icon name={STATUS_ICON[status]} />
      {STATUS_LABEL[status]}
    </span>
  );
}

const LEGEND: SecurityStatus[] = ['pass', 'fail', 'unknown', 'attested', 'na'];

export function SecurityLegend() {
  return (
    <ul className={`${s.legend} t-caption c-secondary`}>
      {LEGEND.map((status) => (
        <li key={status} className={s.legendItem}>
          <SecurityDot status={status} />
          {STATUS_LABEL[status]}
        </li>
      ))}
    </ul>
  );
}

export type DotMapRow = { name: string; statuses: SecurityStatus[] };

export function SecurityDotMap({ columns, rows }: { columns: string[]; rows: DotMapRow[] }) {
  return (
    <div className={s.map} style={{ gridTemplateColumns: `repeat(${columns.length}, 28px)` }}>
      {columns.map((column) => (
        <span key={column} className={`${s.mapHead} t-caption c-secondary`}>
          {column}
        </span>
      ))}
      {rows.flatMap((row) =>
        row.statuses.map((status, index) => (
          <span key={`${row.name}-${columns[index]}`} className={s.mapCell}>
            <SecurityDot status={status} title={`${row.name} · ${columns[index]}: ${STATUS_LABEL[status]}`} />
          </span>
        )),
      )}
    </div>
  );
}
