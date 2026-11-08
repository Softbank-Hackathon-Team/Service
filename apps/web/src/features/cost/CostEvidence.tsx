import { useEffect, useState } from 'react';
import { FoldTile } from '../../components/layout/tiles';
import { Badge } from '../../components/ui/controls';
import { Icon } from '../../components/ui/Icon';
import { api } from '../../lib/api';
import { t } from '../../lib/i18n';
import { ago } from '../../lib/text';
import type { CostBreakdown, CostGap, CostLine, CostMapping, CostPromotion, MoveCostTarget, MoveCostView, SourceScope } from '../../lib/types';
import { usePoll } from '../../lib/usePoll';
import { Section } from '../common/Section';
import {
  GROUP_LABEL,
  PRICE_SOURCE,
  PROMO_STATUS,
  basisTag,
  changeText,
  costAbsent,
  costErrorText,
  envCostCaption,
  envCostSummary,
  extraRefs,
  figureRows,
  figuresOf,
  lineGroups,
  monthlyChange,
  money,
  moveCostBody,
  promoAmount,
  promoBuckets,
  promoSummary,
  shareRecent,
  sourceLine,
  targetPrice,
} from './evidence';
import s from '../common/page.module.css';
import c from './evidence.module.css';

// 근거 있는 비용 카드. 환경 화면의 "월 비용"과 새 마이그레이션 도착 고르기의 "예상 요금"이 같은 줄 모양을 쓴다.
// 줄마다 금액만 두지 않고 "무엇을 몇 개 셌나(수량 근거·센 자원)"와 "단가가 어디서 왔나(출처 종류·받은 날·링크)"를 바로 밑에 둔다.
// 서버: GET /environments/:id/cost, POST /environments/:id/cost/move (contracts cost-evidence.ts)

// 목록 줄과 오른쪽 카드가 같은 환경 비용을 함께 읽는다 → 5초 안의 같은 요청은 하나로
const envCostShared = shareRecent((id) => api.envCost(id), 5_000);

/** 환경 하나의 지금 비용. 실자원은 worker 가 다시 읽어 저장하므로 가끔 다시 읽는다 */
export function useEnvCost(envId: string) {
  return usePoll(() => envCostShared(envId), 30_000, [envId], { keepOnError: false });
}

/**
 * 출발(고른 범위)을 도착 후보 전부로 옮겼을 때의 요금. 도착 고르기 화면이 뜰 때 한 번 묻는다.
 * DRAFT(ai): 출발 실자원이 아직 없어 계산하지 못했으면(unavailable) worker 가 읽어 저장할 때까지 10초마다 다시 묻는다
 */
export function useMoveCost(sourceId: string | null, scope: SourceScope, targetIds: readonly string[]) {
  const body = moveCostBody(targetIds, scope);
  const ready = sourceId !== null && body.targetEnvIds.length > 0;
  const [waiting, setWaiting] = useState(false);
  const move = usePoll(ready ? () => api.moveCost(sourceId, body) : null, ready && waiting ? 10_000 : null, [sourceId, JSON.stringify(body)], { keepOnError: false });
  const unavailable = move.data?.source.status === 'unavailable';
  useEffect(() => setWaiting(unavailable), [unavailable]);
  return move;
}

function Amount({ value, className = 't-label-md' }: { value: number; className?: string }) {
  return <span className={`${c.amount} ${className}`}>{money(value)}</span>;
}

function SourceLink({ url }: { url: string }) {
  return (
    <a className={c.link} href={url} target="_blank" rel="noopener noreferrer">
      {t('출처')}
      <Icon name="external" size={12} />
    </a>
  );
}

function FigureRows({ rows }: { rows: { name: string; value: string }[] }) {
  return (
    <ul className={s.rows}>
      {rows.map((row) => (
        <li key={row.name} className={s.row}>
          <span className="t-body-sm c-secondary">{row.name}</span>
          <span className={`${c.amount} t-label-md`}>{row.value}</span>
        </li>
      ))}
    </ul>
  );
}

/** 줄 하나: 이름·금액 / 식 / 수량 근거와 센 자원 / 단가 출처 */
function LineRow({ line }: { line: CostLine }) {
  const basis = basisTag(line.basis.kind);
  const source = PRICE_SOURCE[line.price.sourceKind] ?? { label: line.price.sourceKind, tone: 'neutral' as const };
  const refs = extraRefs(line.basis);
  return (
    <li className={c.line}>
      <span className={c.lineHead}>
        <span className="t-label-md">{line.label}</span>
        <Amount value={line.monthlyUsd} />
      </span>
      <code className="t-code-sm c-secondary">{line.formula}</code>
      <span className={c.evidence}>
        {basis && <Badge tone={basis.tone}>{basis.label}</Badge>}
        <span className={`${c.evidenceText} t-caption c-secondary`}>
          {line.basis.text}
          {refs.length > 0 && (
            <span className={c.refs}>
              {refs.map((ref) => (
                <code key={ref} className={`${c.ref} t-code-sm`}>{ref}</code>
              ))}
            </span>
          )}
        </span>
      </span>
      <span className={c.evidence}>
        <Badge tone={source.tone}>{source.label}</Badge>
        <span className={`${c.evidenceText} t-caption c-tertiary`}>
          {sourceLine(line.price)}
          {line.price.sourceUrl && (
            <>
              {' · '}
              <SourceLink url={line.price.sourceUrl} />
            </>
          )}
        </span>
      </span>
    </li>
  );
}

/** 요금 내역: 묶음(클러스터·노드·DB·…)마다 소계, 그 아래 줄. 끝에 정가 합계 */
export function CostLines({ breakdown }: { breakdown: CostBreakdown }) {
  return (
    <>
      {lineGroups(breakdown.lines).map((group) => (
        <div key={group.group}>
          <p className={`${c.groupHead} t-label-sm c-tertiary`}>
            <span>{group.label}</span>
            {/* 줄이 하나면 소계가 줄 금액과 같아 두 번 쓰지 않는다 */}
            {group.lines.length > 1 && <Amount value={group.monthlyUsd} className="t-label-sm" />}
          </p>
          <ul className={c.lines}>
            {group.lines.map((line) => (
              <LineRow key={line.id} line={line} />
            ))}
          </ul>
        </div>
      ))}
      <p className={`${c.groupHead} t-label-md`}>
        <span>{t('정가 합계')}</span>
        <Amount value={breakdown.monthlyUsd} />
      </p>
    </>
  );
}

/**
 * 합계에서 뺀 것과 그 이유. 참고 금액은 합계에 넣지 않는다.
 * DRAFT(ai): estimateUsd 의 기간이 계약에 없어, 서버 문장(LCU "월 약 $5.84", 온프레 회선·인력 월 가정값)을 따라 한 달 금액으로 읽는다
 */
export function CostGaps({ gaps }: { gaps: CostGap[] }) {
  if (gaps.length === 0) return null;
  return (
    <div>
      <p className={`${c.groupHead} t-label-sm c-tertiary`}>
        <span>{t('합계에서 뺀 것')}</span>
        <span>{t('{0}개', { 0: gaps.length })}</span>
      </p>
      <ul className={c.lines}>
        {gaps.map((gap) => (
          <li key={gap.id} className={c.line}>
            <span className={c.lineHead}>
              <span className="t-label-md">{gap.label}</span>
              {gap.estimateUsd !== null && <span className={`${c.amount} t-caption c-tertiary`}>{t('참고 월 {0}', { 0: money(gap.estimateUsd) })}</span>}
            </span>
            <span className="t-caption c-secondary">{gap.reason}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function PromoRow({ promo }: { promo: CostPromotion }) {
  const status = PROMO_STATUS[promo.status] ?? { label: promo.status, tone: 'neutral' as const };
  const counted = promo.status !== 'not_applicable' && promo.firstYearUsd > 0;
  return (
    <li className={c.line}>
      <span className={c.lineHead}>
        <span className="t-label-md">{promo.title}</span>
        <span className={`${c.amount} t-caption ${counted ? '' : 'c-tertiary'}`}>{promoAmount(promo)}</span>
      </span>
      <span className={c.evidence}>
        <Badge tone={status.tone}>{status.label}</Badge>
        <span className={`${c.evidenceText} t-caption c-secondary`}>{promo.status === 'not_applicable' ? (promo.note ?? promo.condition) : promo.condition}</span>
      </span>
      {promo.status !== 'not_applicable' && (
        <span className="t-caption c-tertiary">
          {t('깎는 곳 · {0}', { 0: promo.appliesTo })}
          {promo.note ? ` · ${promo.note}` : ''}
        </span>
      )}
      <span className="t-caption c-tertiary">
        <SourceLink url={promo.sourceUrl} />
        {` · ${t('{0} 확인', { 0: promo.checkedAt.slice(0, 10) })}`}
        {promo.validUntil ? ` · ${t('{0}까지', { 0: promo.validUntil.slice(0, 10) })}` : ''}
      </span>
    </li>
  );
}

/** 프로모션을 금액에 넣은 정도로 나눠 보인다 (evidence.ts promoBuckets) */
export function Promotions({ promotions }: { promotions: CostPromotion[] }) {
  const b = promoBuckets(promotions);
  const groups = [
    { key: 'applied', title: t('금액에 넣은 것'), items: b.applied },
    { key: 'conditional', title: t('조건을 채우면 받는 것 · 조건 충족 시 금액에 넣음'), items: b.conditional },
    { key: 'request', title: t('신청이 필요한 것 · 금액에 넣지 않음'), items: b.request },
    { key: 'not_applicable', title: t('해당 없음'), items: b.notApplicable },
  ].filter((group) => group.items.length > 0);
  return (
    <>
      {groups.map((group) => (
        <div key={group.key}>
          <p className={`${c.groupHead} t-label-sm c-tertiary`}>{group.title}</p>
          <ul className={c.lines}>
            {group.items.map((promo) => (
              <PromoRow key={promo.id} promo={promo} />
            ))}
          </ul>
        </div>
      ))}
    </>
  );
}

/** 출발 자원 하나가 도착에서 무엇이 되나와 그 이유 */
export function Mappings({ mappings }: { mappings: CostMapping[] }) {
  return (
    <ul className={c.lines}>
      {mappings.map((mapping, index) => (
        <li key={`${mapping.group}-${index}`} className={c.line}>
          <span className="t-caption c-tertiary">{GROUP_LABEL[mapping.group] ?? mapping.group}</span>
          <span className="t-label-md">{mapping.from}</span>
          <span className="t-label-md">
            <span className="c-tertiary">→ </span>
            {mapping.to ?? <span className="c-tertiary">{t('만들지 않음')}</span>}
          </span>
          <span className="t-caption c-secondary">{mapping.why}</span>
        </li>
      ))}
    </ul>
  );
}

/** 카드 맨 아래: 청구서가 아니라는 말, 그 아래 가격 기준일 · 가격 리전 · 실자원을 읽은 때 */
function CostFoot({ breakdown, checkedAt }: { breakdown: CostBreakdown | null; checkedAt?: string | null }) {
  const facts = [
    breakdown ? t('가격 기준일 {0}', { 0: breakdown.priceAsOf.slice(0, 10) }) : null,
    breakdown && breakdown.provider !== 'onprem' ? t('{0} 가격', { 0: breakdown.region }) : null,
    checkedAt ? t('실자원 조회 {0}', { 0: ago(checkedAt) }) : null,
  ].filter((part): part is string => part !== null);
  return (
    <div className={c.foot}>
      <p className="t-caption c-secondary">{t('공개 가격표로 낸 추정이며 청구서가 아닙니다.')}</p>
      {facts.length > 0 && <p className="t-caption c-tertiary">{facts.join(' · ')}</p>}
    </div>
  );
}

/**
 * 환경 목록 줄 아래 "월 $X 추산". 일부만 셌으면 "일부만 셈", 계산할 수 없으면 짧은 이유. 색은 늘 중립
 * DRAFT(ai): 비용 경로가 없는 서버(costAbsent)면 아무 말도 하지 않는다. 줄마다 같은 말로 목록을 덮지 않게
 */
export function EnvCostCaption({ envId }: { envId: string }) {
  const cost = useEnvCost(envId);
  const caption = envCostCaption(cost.data, cost.error);
  if (!caption) return null;
  return <span className="t-caption c-tertiary">{caption}</span>;
}

/**
 * 환경 화면 오른쪽 "월 비용". 펼치면 요금 내역.
 * DRAFT(ai): 접어 둔 채로 시작한다 (머리줄 요약에 한 달 금액이 보이고, 긴 내역이 아래 자원 카드를 밀어내지 않게)
 */
export function EnvCostFold({ envId }: { envId: string }) {
  const cost = useEnvCost(envId);
  const view = cost.data;
  const projection = view?.projection ?? null;
  const breakdown = view?.breakdown ?? null;
  const f = projection ? figuresOf(projection) : null;
  return (
    <FoldTile title={t('월 비용')} summary={envCostSummary(view, cost.loading, cost.error)} defaultOpen={false}>
      {view && f && projection && breakdown ? (
        <>
          <p className={`${c.figure} ${c.headline}`}>
            <Amount value={f.monthly} className="t-metric-lg" />
            <span className="t-body-md c-secondary">{t('/월')}</span>
          </p>
          <FigureRows rows={figureRows(f)} />
          {view.status === 'partial' && view.reason && <p className={`${s.note} t-body-sm c-secondary`}>{view.reason}</p>}
          {projection.promotions.length > 0 && <Promotions promotions={projection.promotions} />}
          <CostLines breakdown={breakdown} />
          <CostGaps gaps={breakdown.gaps} />
          <CostFoot breakdown={breakdown} checkedAt={view.inventoryCheckedAt} />
        </>
      ) : (
        <p className={`${s.note} t-body-sm c-secondary`}>
          {view ? (view.reason ?? t('비용을 계산하지 못했습니다.')) : cost.loading ? t('비용을 계산하고 있습니다.') : costErrorText(cost.error)}
        </p>
      )}
    </FoldTile>
  );
}

/** 도착 후보 줄 오른쪽: 한 달과 1년 (조건 충족 시). 계산하지 못했으면 이유 */
export function TargetPriceAside({ target, loading }: { target: MoveCostTarget | null; loading: boolean }) {
  if (!target) return loading ? <span className="t-caption c-tertiary">{t('요금 계산 중')}</span> : null;
  const price = targetPrice(target);
  if ('reason' in price) {
    return (
      <>
        <span className="t-label-md">{t('요금 계산 불가')}</span>
        <span className="t-caption c-tertiary">{price.reason}</span>
      </>
    );
  }
  return (
    <>
      <span className={`${c.amount} t-h3`}>{price.month}</span>
      <span className={`${c.amount} t-caption c-secondary`}>{price.year}</span>
    </>
  );
}

/** 비교 칸의 큰 금액. 모르면 단위 없이 "모름" */
function MonthFigure({ value }: { value: number | null }) {
  if (value === null) return <span className="t-h2 c-tertiary">{t('모름')}</span>;
  return (
    <span className={c.figure}>
      <Amount value={value} className="t-metric-lg" />
      <span className="t-body-sm c-secondary">{t('/월')}</span>
    </span>
  );
}

type MoveCostFoldProps = {
  move: MoveCostView | null;
  loading: boolean;
  error: unknown;
  targetId: string;
};

/**
 * 새 마이그레이션 도착 고르기의 "예상 요금". 지금(고른 범위만 다시 센 출발) → 옮긴 뒤 한 달, 1년, 프로모션, 자원 대응, 요금 내역.
 * 요금을 못 내도 마이그레이션 만들기는 막지 않는다 (이유만 보인다)
 */
export function MoveCostFold({ move, loading, error, targetId }: MoveCostFoldProps) {
  const target = move?.targets.find((item) => item.envId === targetId) ?? null;
  const source = move?.source ?? null;
  const tf = target?.feasible && target.projection ? figuresOf(target.projection) : null;
  const sf = source?.projection ? figuresOf(source.projection) : null;
  const delta = source && target ? monthlyChange(source, target) : null;
  const summary = !move ? (loading ? t('계산 중') : costAbsent(error) ? t('볼 수 없음') : t('계산 못 함')) : tf ? t('{0}/월', { 0: money(tf.monthly) }) : t('계산 못 함');
  return (
    <FoldTile title={t('예상 요금')} summary={summary}>
      {!move || !source ? (
        <p className={`${s.note} t-body-sm c-secondary`}>
          {loading ? t('출발과 도착 후보의 요금을 계산하고 있습니다.') : t('{0} 마이그레이션은 그대로 만들 수 있습니다.', { 0: costErrorText(error) })}
        </p>
      ) : !target ? (
        <p className={`${s.note} t-body-sm c-secondary`}>{t('이 도착지의 요금이 응답에 없습니다.')}</p>
      ) : (
        <>
          <div className={c.compare}>
            <span className={c.compareCell}>
              <span className="t-caption c-tertiary">{t('지금 · {0}', { 0: source.name })}</span>
              <MonthFigure value={sf?.monthly ?? null} />
            </span>
            <span className={c.compareArrow}>
              <Icon name="arrow-right" />
            </span>
            <span className={c.compareCell}>
              <span className="t-caption c-tertiary">{t('옮긴 뒤 · {0}', { 0: target.name })}</span>
              <MonthFigure value={tf?.monthly ?? null} />
            </span>
          </div>
          {tf && <FigureRows rows={[...figureRows(tf), ...(delta !== null ? [{ name: t('지금보다'), value: changeText(delta) }] : [])]} />}
          {!target.feasible && <p className={`${s.note} t-body-sm c-secondary`}>{t('옮긴 뒤 요금을 계산하지 못했습니다: {0}', { 0: target.reason ?? t('이유 없음') })}</p>}
          {/* 출발 실자원이 없으면 도착도 같은 이유로 못 센다 → 같은 문장을 두 번 쓰지 않는다 */}
          {source.status !== 'ok' && source.reason && (target.feasible || source.reason !== target.reason) && (
            <p className={`${s.note} t-body-sm c-secondary`}>{t('지금 요금 · {0}', { 0: source.reason })}</p>
          )}
          {move.scopeNote && <p className={`${s.note} t-caption c-secondary`}>{t('범위 · {0}', { 0: move.scopeNote })}</p>}
          {target.projection && target.projection.promotions.length > 0 && (
            <Section title={t('프로모션')} summary={promoSummary(target.projection.promotions)} defaultOpen>
              <Promotions promotions={target.projection.promotions} />
            </Section>
          )}
          {target.mappings.length > 0 && (
            <Section title={t('자원 대응')} summary={t('{0}개', { 0: target.mappings.length })} defaultOpen>
              <Mappings mappings={target.mappings} />
            </Section>
          )}
          {target.breakdown && (
            <Section title={t('{0} 요금 내역', { 0: target.name })} summary={t('정가 {0}/월', { 0: money(target.breakdown.monthlyUsd) })} defaultOpen>
              <CostLines breakdown={target.breakdown} />
              <CostGaps gaps={target.breakdown.gaps} />
            </Section>
          )}
          {source.breakdown && (
            <Section title={t('{0} 지금 요금 내역', { 0: source.name })} summary={t('정가 {0}/월', { 0: money(source.breakdown.monthlyUsd) })}>
              <CostLines breakdown={source.breakdown} />
              <CostGaps gaps={source.breakdown.gaps} />
            </Section>
          )}
          <CostFoot breakdown={target.breakdown ?? source.breakdown} checkedAt={source.inventoryCheckedAt} />
        </>
      )}
    </FoldTile>
  );
}
