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
  pass: 'circle',
  fail: 'x',
  unknown: 'help',
  na: 'minus',
  attested: 'check',
};

/**
 * 색만으로 구분하지 않도록 상태마다 모양이 다르다. 타임라인 표시처럼 엷은 바탕 위 기호로 그린다.
 * 통과 = 엷은 파랑 위 O, 실패 = 엷은 빨강 위 X, 모름 = 회색 위 ?, 사람 확인 = 파랑 위 체크, 해당 없음 = 회색 줄.
 */
export function SecurityDot({ status, title }: { status: SecurityStatus; title?: string }) {
  const mark =
    status === 'fail' ? (
      <span className={s.failMark}>
        <Icon name="x" size={12} />
      </span>
    ) : status === 'attested' ? (
      <span className={s.attestedMark}>
        <Icon name="check" size={10} />
      </span>
    ) : status === 'unknown' ? (
      <span className={s.unknownMark} aria-hidden="true">
        ?
      </span>
    ) : (
      <span className={s[`${status}Mark`]} />
    );
  return (
    <span className={s.dot} title={title ?? STATUS_LABEL[status]} role="img" aria-label={title ?? STATUS_LABEL[status]}>
      {mark}
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
