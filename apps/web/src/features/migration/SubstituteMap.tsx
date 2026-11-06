import { useState } from 'react';
import { Badge } from '../../components/ui/controls';
import { Icon } from '../../components/ui/Icon';
import { t } from '../../lib/i18n';
import type { SubstituteRow } from '../../lib/resourceMap';
import { PROVIDER_SHORT } from '../../lib/status';
import type { Provider } from '../../lib/types';
import s from './SubstituteMap.module.css';

// 옮기지 못하는 것이 이보다 많으면 나머지는 접어 둔다 (줄 높이가 고르게)
const LOST_SHOWN = 3;

/**
 * "자원 대응" 카드의 상품 대체 그래프. 한 줄 = 출발 상품 카드 → 도착 상품 카드.
 * 줄마다 계획서 확인 항목이라 체크 상태만 보여 준다. 체크는 "승인 전에 확인" 카드 한 곳에서만 한다
 */
export function SubstituteMap({ rows, source, target, checked }: {
  rows: SubstituteRow[]; source: Provider | null; target: Provider | null; checked: ReadonlySet<string>;
}) {
  if (rows.length === 0) return <p className={`${s.empty} t-body-sm c-tertiary`}>{t('승인할 상품 대체가 없습니다')}</p>;
  return (
    <div className={s.map}>
      <p className="t-caption c-tertiary">{t('도착에서 다른 상품이 되는 자원')}</p>
      <ul className={s.rows}>
        {rows.map((row) => (
          <SubstituteItem key={row.ackId} row={row} source={source} target={target} checked={checked.has(row.ackId)} />
        ))}
      </ul>
    </div>
  );
}

function SubstituteItem({ row, source, target, checked }: { row: SubstituteRow; source: Provider | null; target: Provider | null; checked: boolean }) {
  const [all, setAll] = useState(false);
  const lost = all ? row.lost : row.lost.slice(0, LOST_SHOWN);
  const hidden = row.lost.length - lost.length;
  return (
    <li className={s.item}>
      <div className={s.head}>
        <span className="t-label-md">{row.resource}</span>
        <Badge tone={checked ? 'success' : 'warning'}>{checked ? t('확인함') : t('승인 전에 확인')}</Badge>
      </div>
      <div className={s.card}>
        <span className={`${s.side} t-caption c-tertiary`}>{source ? PROVIDER_SHORT[source] : t('출발')}</span>
        <span className="t-label-md">{row.from}</span>
      </div>
      <div className={s.link}>
        <Icon name="arrow-right" />
        <Badge tone={row.appChange ? 'warning' : 'neutral'}>{row.appChange ? t('앱 코드 변경 필요') : t('그대로 연결')}</Badge>
      </div>
      <div className={s.card}>
        <span className={`${s.side} ${s.sideTarget} t-caption c-tertiary`}>{target ? PROVIDER_SHORT[target] : t('도착')}</span>
        <span className="t-label-md">{row.to}</span>
      </div>
      {row.lost.length === 0 ? (
        <span className={`${s.lost} t-caption c-tertiary`}>{t('옮기지 못하는 것 없음')}</span>
      ) : (
        <div className={s.lost}>
          <span className="t-caption c-tertiary">{t('옮기지 못하는 것')}</span>
          <ul>
            {lost.map((item) => <li key={item} className="t-caption c-secondary">{item}</li>)}
          </ul>
          {hidden > 0 && (
            <button type="button" className={`${s.more} t-caption`} onClick={() => setAll(true)}>
              {t('{0}개 더 보기', { 0: hidden })}
            </button>
          )}
        </div>
      )}
    </li>
  );
}
