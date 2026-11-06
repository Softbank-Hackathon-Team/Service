import { useRef, useState } from 'react';
import { Badge, OptionPill } from '../../components/ui/controls';
import { Icon } from '../../components/ui/Icon';
import { t } from '../../lib/i18n';
import type { SubstituteRow } from '../../lib/resourceMap';
import { PROVIDER_SHORT } from '../../lib/status';
import type { Provider } from '../../lib/types';
import s from './SubstituteMap.module.css';

// 옮기지 못하는 것이 이보다 많으면 나머지는 접어 둔다 (줄 높이가 고르게)
const LOST_SHOWN = 3;

type Confirm = { checked: ReadonlySet<string>; disabled: boolean; onToggle: (ackId: string) => void };

// 칸 위쪽 흐림(scroll-fade 32px)의 절반. 다음 줄로 넘길 때 구분선이 흐림 안에, 머리줄은 흐림 밖에 온다
const ADVANCE_GAP = 16;

/**
 * 상품 대체 그래프. 한 줄 = 출발 상품 카드 → 도착 상품 카드, 그 밑에 옮기지 못하는 것.
 * confirm 이 있으면 계획 승인 큰 카드다: 줄마다 오른쪽 끝의 확인 버튼이 그 확인 항목(ackId)을 확인하는 유일한 자리이고, 남은 높이보다 길면 이 칸만 스크롤한다.
 * 없으면 명세 검토 근거 카드의 미리보기다: 같은 줄을 읽기만 하고, 계획 승인 때 확인한다는 한 줄을 붙인다
 */
export function SubstituteMap({ rows, source, target, confirm }: {
  rows: SubstituteRow[]; source: Provider | null; target: Provider | null; confirm?: Confirm;
}) {
  const box = useRef<HTMLDivElement>(null);
  // 한 줄을 확인하면 다음 줄을 칸 맨 위로 올린다. 작은 화면에서 줄마다 손으로 스크롤하지 않게
  const advance = (item: HTMLElement) => {
    const next = item.nextElementSibling;
    if (!box.current || !next) return;
    const top = box.current.scrollTop + next.getBoundingClientRect().top - box.current.getBoundingClientRect().top - ADVANCE_GAP;
    box.current.scrollTo({ top, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  };
  return (
    <div ref={box} className={confirm ? `${s.map} scroll-fade` : `${s.map} ${s.preview}`}>
      <p className="t-caption c-tertiary">{t('도착에서 다른 상품이 되는 자원')}</p>
      {!confirm && <p className="t-caption c-tertiary">{t('계획 승인 때 하나씩 확인합니다')}</p>}
      <ul className={s.rows}>
        {rows.map((row) => (
          <SubstituteItem key={row.ackId} row={row} source={source} target={target} confirm={confirm} onConfirmed={advance} />
        ))}
      </ul>
    </div>
  );
}

function SubstituteItem({ row, source, target, confirm, onConfirmed }: {
  row: SubstituteRow; source: Provider | null; target: Provider | null; confirm?: Confirm; onConfirmed: (item: HTMLElement) => void;
}) {
  const item = useRef<HTMLLIElement>(null);
  const [all, setAll] = useState(false);
  const lost = row.lost && (all ? row.lost : row.lost.slice(0, LOST_SHOWN));
  const hidden = (row.lost?.length ?? 0) - (lost?.length ?? 0);
  const checked = confirm?.checked.has(row.ackId) ?? false;
  // 큰 카드에서는 이름을 크게, 근거 카드(좁은 칸)에서는 다른 근거 줄과 같은 크기로
  const name = confirm ? 't-h3' : 't-label-md';
  return (
    <li ref={item} className={s.item}>
      <div className={s.head}>
        <span className={name}>{row.resource}</span>
        {confirm && (
          <OptionPill
            checkbox
            label={checked ? t('확인함') : t('확인')}
            icon="check"
            selected={checked}
            disabled={confirm.disabled}
            onClick={() => {
              confirm.onToggle(row.ackId);
              if (!checked && item.current) onConfirmed(item.current);
            }}
          />
        )}
      </div>
      <div className={s.card}>
        <span className={`${s.side} t-caption c-tertiary`}>{source ? PROVIDER_SHORT[source] : t('출발')}</span>
        {row.from && <span className={name}>{row.from}</span>}
      </div>
      <div className={s.link}>
        <Icon name="arrow-right" />
        {row.appChange !== undefined && (
          <Badge tone={row.appChange ? 'warning' : 'neutral'}>{row.appChange ? t('앱 코드 변경 필요') : t('그대로 연결')}</Badge>
        )}
      </div>
      <div className={s.card}>
        <span className={`${s.side} ${s.sideTarget} t-caption c-tertiary`}>{target ? PROVIDER_SHORT[target] : t('도착')}</span>
        {row.to && <span className={name}>{row.to}</span>}
      </div>
      {row.detail && <p className={`${s.lost} t-caption c-secondary`}>{row.detail}</p>}
      {lost && (lost.length === 0 ? (
        <span className={`${s.lost} t-caption c-tertiary`}>{t('옮기지 못하는 것 없음')}</span>
      ) : (
        <div className={s.lost}>
          <span className="t-caption c-tertiary">{t('옮기지 못하는 것')}</span>
          <ul>
            {lost.map((text) => <li key={text} className="t-body-sm c-secondary">{text}</li>)}
          </ul>
          {hidden > 0 && (
            <button type="button" className={`${s.more} t-caption`} onClick={() => setAll(true)}>
              {t('{0}개 더 보기', { 0: hidden })}
            </button>
          )}
        </div>
      ))}
    </li>
  );
}
