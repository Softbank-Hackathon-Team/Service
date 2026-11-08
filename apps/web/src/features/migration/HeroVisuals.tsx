import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Icon } from '../../components/ui/Icon';
import { SecurityDot, SecurityLegend, type SecurityStatus } from '../../components/ui/Security';
import { api } from '../../lib/api';
import type { StopReason } from '../../lib/failure';
import { or404 } from '../../lib/http';
import { planResourceRows, runtimeChangeNote, type PlanResourcesView, type ResourceSide } from '../../lib/resourceMap';
import { isTerminal, LABEL, PROVIDER_SHORT } from '../../lib/status';
import { stopEvidence, stopHelp } from '../../lib/timelineDetail';
import type { MigrationView, PlanDoc, PlanStep } from '../../lib/types';
import { usePoll } from '../../lib/usePoll';
import { controlRows, securityHeadline } from '../security/model';
import { stepName } from './model';
import { CATEGORY_ICON, metricScale, rollbackCause, sweepStepMs, type CauseMetric, type SpecCard } from './visuals';
import v from './HeroVisuals.module.css';
import { localeTag, t } from '../../lib/i18n';

// 큰 카드 그림. 글로 줄줄이 쓰지 않고 상자·화살표·색으로 보인다. 색은 토큰만 쓴다:
//   출발 = 회색(data-source), 도착 = 파랑(data-target), 성공·주의·위험 = 엷은 바탕 위 글자색, 막대만 신호색(signal-*)

const OWNER: Record<PlanStep['owner'], string> = { terraform: 'Terraform', argocd: 'Argo CD', agent: 'Agent', worker: t('워커') };

/** 비율 단계(10 → 50 → 100%)를 키가 다른 막대로 */
function WeightBars({ weights }: { weights: number[] }) {
  return (
    <span className={v.weights} aria-label={`${weights.join(' → ')}%`} role="img">
      {weights.map((weight, index) => (
        <span key={`${weight}-${index}`} className={v.weight}>
          <span className={v.weightBar} style={{ height: `${Math.max(12, weight)}%` }} />
          <span className="t-caption c-tertiary">{weight}</span>
        </span>
      ))}
    </span>
  );
}

/** 계획 판: 실행 순서(상자 → 상자)와 자동으로 되돌리는 조건(조건 둘 → 되돌림) */
export function PlanFlow({ doc }: { doc: PlanDoc }) {
  const criteria = doc.rollbackCriteria;
  return (
    <div className={`${v.stack} ${v.plan}`}>
      <p className="t-label-sm c-tertiary">{t('실행 순서')}</p>
      <ol className={v.flow}>
        {doc.steps.map((step, index) => (
          <li key={step.id} className={v.flowItem}>
            <div className={v.stepBox}>
              <span className={v.stepHead}>
                <span className={`${v.stepNo} t-caption`}>{index + 1}</span>
                <span className="t-label-md">{stepName(step.id)}</span>
              </span>
              {step.weights?.length ? <WeightBars weights={step.weights} /> : null}
              <span className="t-caption c-tertiary">
                {[OWNER[step.owner] ?? step.owner, step.holdSec ? t('단계마다 {0}초', { 0: step.holdSec }) : null].filter(Boolean).join(' · ')}
              </span>
            </div>
            {index < doc.steps.length - 1 && (
              <span className={v.flowArrow} aria-hidden="true">
                <Icon name="arrow-right" />
              </span>
            )}
          </li>
        ))}
      </ol>
      <p className="t-label-sm c-tertiary">{t('자동으로 되돌리는 조건')}</p>
      <div className={v.trigger}>
        <div className={v.triggerIn}>
          <div className={v.condBox}>
            <span className="t-caption c-tertiary">{t('도착 오류율')}</span>
            <span className="t-h3">&gt; {criteria.errorRatePct}%</span>
          </div>
          <span className={`${v.or} t-caption c-tertiary`}>{t('또는')}</span>
          <div className={v.condBox}>
            <span className="t-caption c-tertiary">{t('도착 응답 p95')}</span>
            <span className="t-h3">&gt; {t('출발 × {0}', { 0: criteria.p95Multiplier })}</span>
          </div>
        </div>
        <span className={v.join} aria-hidden="true" />
        <div className={v.outcome}>
          <span className={v.outcomeIcon}>
            <Icon name="rollback" size={20} />
          </span>
          <span className="t-label-md">{t('출발로 되돌림')}</span>
          <span className="t-caption c-secondary">{t('트래픽을 모두 출발로 돌리고 DB 쓰기도 출발에 둡니다')}</span>
        </div>
      </div>
    </div>
  );
}

function SideBox({ side, end, empty }: { side: ResourceSide | null; end: 'source' | 'target'; empty: string }) {
  if (!side) return <div className={`${v.side} ${v.sideEmpty} t-caption c-tertiary`}>{empty}</div>;
  return (
    <div className={v.side} data-end={end}>
      <span className="t-label-md">{side.service}</span>
      {/* 도착 상자는 엷은 파랑 바탕이라 옅은 회색은 대비가 모자란다 (4.5:1) */}
      {side.detail && <span className={`t-caption ${end === 'target' ? 'c-secondary' : 'c-tertiary'}`}>{side.detail}</span>}
    </div>
  );
}

/** 자원 대응 판: 줄마다 출발 상자 ─(옮기는 법)→ 도착 상자. 맨 위는 두 환경 */
export function ResourceFlow({ view, loading }: { view: PlanResourcesView | null; loading: boolean }) {
  if (!view) return <p className="t-body-md c-tertiary">{loading ? t('대응표를 읽고 있습니다.') : t('아직 대응표가 없습니다.')}</p>;
  const { listed, boundary } = planResourceRows(view);
  return (
    <div className={v.map}>
      <div className={v.mapRow}>
        <div className={v.endBox} data-end="source">
          <span className="t-caption c-secondary">{t('출발')}</span>
          <span className="t-label-md">{PROVIDER_SHORT[view.source.provider]} · {view.source.name}</span>
        </div>
        <span className={v.wire} data-strong aria-hidden="true" />
        <div className={v.endBox} data-end="target">
          <span className="t-caption c-secondary">{t('도착')}</span>
          <span className="t-label-md">{PROVIDER_SHORT[view.target.provider]} · {view.target.name}</span>
        </div>
      </div>
      {listed.map(({ key, row }) => (
        <div key={key} className={v.mapRow}>
          <span className={`${v.mapHead} t-caption c-secondary`}>
            <Icon name={CATEGORY_ICON[row.category] ?? 'list'} size={14} />
            {row.label}
          </span>
          <SideBox side={row.source} end="source" empty={t('출발에 없음')} />
          <span className={v.link}>
            <span className={`${v.method} t-caption`}>{row.methodLabel}</span>
            <span className={v.wire} aria-hidden="true" />
          </span>
          <SideBox side={row.target} end="target" empty={t('만들지 않음')} />
          {runtimeChangeNote(row) && <span className={`${v.mapNote} t-caption c-warning`}>{runtimeChangeNote(row)}</span>}
        </div>
      ))}
      {boundary && (
        <p className={`${v.mapFoot} t-caption c-tertiary`}>
          {boundary.label} · {boundary.afterSource ?? t('옮기지 않음')}
        </p>
      )}
    </div>
  );
}

const TALLY = [
  { key: 'ok', label: t('지켜짐'), tone: 'success' },
  { key: 'warn', label: t('약점'), tone: 'warning' },
  { key: 'fail', label: t('위반'), tone: 'danger' },
  { key: 'notImplemented', label: t('미구현'), tone: 'neutral' },
] as const;

const KEPT: ReadonlySet<SecurityStatus> = new Set(['pass', 'attested']);
const changeOf = (source: SecurityStatus, target: SecurityStatus) =>
  KEPT.has(source) && target === 'fail' ? 'worse' : source === 'fail' && KEPT.has(target) ? 'better' : 'same';

/** 보안 판: 판정 한 줄, 네 칸 숫자 상자와 비율 막대, 통제마다 출발 ● → ● 도착 (나빠지면 빨간 선) */
export function SecurityBoard({ migration }: { migration: MigrationView }) {
  const live = !isTerminal(migration.status);
  const security = usePoll(() => or404(api.security(migration.id)), live ? 10_000 : null, [migration.id]);
  const view = security.data;
  if (!view) return <p className="t-body-md c-tertiary">{security.loading ? t('보안 표를 읽고 있습니다.') : t('아직 보안 표가 없습니다.')}</p>;
  const headline = securityHeadline(view, null);
  const controls = view.controlMatrix ? controlRows(view.controlMatrix) : [];
  const total = TALLY.reduce((sum, item) => sum + view.summary[item.key], 0);
  return (
    <div className={v.stack}>
      <p className={`t-h3 ${headline.stop ? 'c-danger' : ''}`}>{headline.title.replace('\n', ' ')}</p>
      <ul className={v.tally}>
        {TALLY.map((item) => (
          <li key={item.key} className={`${v.tallyBox} ${v.toned}`} data-tone={item.tone}>
            <span className="t-metric-lg">{view.summary[item.key]}</span>
            <span className="t-caption">{item.label}</span>
          </li>
        ))}
      </ul>
      {total > 0 && (
        <span className={v.ratio} role="img" aria-label={TALLY.map((item) => `${item.label} ${view.summary[item.key]}`).join(', ')}>
          {TALLY.map((item) => (view.summary[item.key] > 0 ? <span key={item.key} data-tone={item.tone} style={{ flexGrow: view.summary[item.key] }} /> : null))}
        </span>
      )}
      {controls.length > 0 && (
        <>
          <p className={`${v.controlsHead} t-label-sm c-tertiary`}>
            <span>{t('통제')}</span>
            <span>{t('출발 → 도착')}</span>
          </p>
          <ul className={v.controls}>
            {controls.map((control) => (
              <li key={control.id} className={v.control} data-change={changeOf(control.source, control.target)}>
                <span className="t-body-sm" title={control.reason || undefined}>{control.title}</span>
                <span className={v.pair}>
                  <SecurityDot status={control.source} />
                  <span className={v.pairWire} aria-hidden="true" />
                  <SecurityDot status={control.target} />
                </span>
              </li>
            ))}
          </ul>
          <SecurityLegend />
        </>
      )}
    </div>
  );
}

// 1 → 1%, 3.2 → 3.2%, 0.12 → 0.12% (끝 0 은 떼어 기준과 잰 값이 같은 모양)
const pct = (n: number) => `${Number(n.toFixed(n < 1 ? 2 : 1))}%`;
const ms = (n: number) => `${Math.round(n)}ms`;

/** 잰 값과 기준선. 막대 둘(출발 회색, 도착 파랑, 넘었으면 빨강)과 기준 세로선 */
function Gauge({ metric }: { metric: CauseMetric }) {
  const scale = metricScale(metric);
  const at = (n: number) => `${Math.min(100, (n / scale) * 100)}%`;
  const fmt = metric.id === 'error' ? pct : ms;
  const name = metric.id === 'error' ? t('도착 오류율') : t('도착 응답 p95');
  return (
    <div className={v.gauge} data-over={metric.over || undefined}>
      <span className={v.gaugeHead}>
        <span className="t-label-md">{name}</span>
        <span className={`t-h3 ${metric.over ? 'c-danger' : ''}`}>{fmt(metric.target)}</span>
      </span>
      <span className={v.gaugeTrack}>
        <span className={v.gaugeBar} data-end="source" style={{ width: at(metric.source) }} />
        <span className={v.gaugeBar} data-end="target" style={{ width: at(metric.target) }} />
        <span className={v.limit} style={{ left: at(metric.limit) }}>
          <span className={`${v.limitLabel} t-caption`}>{t('기준 {0}', { 0: fmt(metric.limit) })}</span>
        </span>
      </span>
      <span className="t-caption c-tertiary">{t('출발 {0}', { 0: fmt(metric.source) })}</span>
    </div>
  );
}

/**
 * 롤백 원인 그림: 어디서 → 무엇이 → 한 일 → 지금, 판정이 있으면 기준과 비교한 지표 막대.
 * 롤백 중(빨간 큰 카드)에도 읽히도록 흰 판 위에 그린다
 */
export function RollbackCauseView({ migration, reason }: { migration: MigrationView; reason: StopReason | null }) {
  const live = !isTerminal(migration.status);
  const timeline = usePoll(() => or404(api.timeline(migration.id)), live ? 5000 : null, [migration.id, migration.version]);
  const plan = usePoll(() => or404(api.latestPlan(migration.id)), null, [migration.id]);
  const items = timeline.data?.items ?? [];
  const evidence = timeline.data ? stopEvidence(items, 'rolling_back') : null;
  const cause = rollbackCause(items, evidence?.judgement ?? null, plan.data?.rollbackCriteria, migration.failureCode);
  const help = timeline.data ? stopHelp(items, 'rolling_back') : null;
  const done = migration.status === 'rolled_back';
  const tripped = cause.metrics.filter((metric) => metric.over);
  const what = cause.by === 'human' ? t('사람이 롤백을 골랐습니다') : (reason?.label ?? t('알 수 없는 사유'));
  return (
    <div className={v.cause}>
      <ol className={v.chain}>
        <li className={v.chainBox}>
          <span className="t-caption c-tertiary">{t('어디서')}</span>
          <span className="t-label-md">{cause.from ? LABEL[cause.from] : t('모름')}</span>
          {cause.stepPct !== null && (
            <span className={v.mini} role="img" aria-label={t('도착 {0}%', { 0: cause.stepPct })}>
              <span style={{ flexGrow: 100 - cause.stepPct }} data-end="source" />
              <span style={{ flexGrow: cause.stepPct }} data-end="target" />
            </span>
          )}
          {cause.stepPct !== null && <span className="t-caption c-secondary">{t('도착 {0}%', { 0: cause.stepPct })}</span>}
        </li>
        <li className={v.chainArrow} aria-hidden="true"><Icon name="arrow-right" /></li>
        <li className={`${v.chainBox} ${v.toned}`} data-tone={cause.by === 'human' ? 'neutral' : 'danger'}>
          <span className="t-caption">{t('원인')}</span>
          <span className="t-label-md">{what}</span>
          {tripped.map((metric) => (
            <span key={metric.id} className="t-caption">
              {metric.id === 'error' ? t('오류율 {0} > 기준 {1}', { 0: pct(metric.target), 1: pct(metric.limit) }) : t('p95 {0} > 기준 {1}', { 0: ms(metric.target), 1: ms(metric.limit) })}
            </span>
          ))}
        </li>
        <li className={v.chainArrow} aria-hidden="true"><Icon name="arrow-right" /></li>
        <li className={v.chainBox}>
          <span className="t-caption c-tertiary">{t('한 일')}</span>
          <span className="t-label-md">{cause.by === 'auto' ? t('자동 롤백') : t('롤백')}</span>
          <span className="t-caption c-secondary">{t('트래픽을 출발로')}</span>
        </li>
        <li className={v.chainArrow} aria-hidden="true"><Icon name="arrow-right" /></li>
        <li className={`${v.chainBox} ${v.toned}`} data-tone={done ? 'success' : 'info'}>
          <span className="t-caption">{t('지금')}</span>
          <span className="t-label-md">{done ? t('출발 100%') : t('되돌리는 중')}</span>
          {cause.at && <span className="t-caption">{new Date(cause.at).toLocaleTimeString(localeTag(), { hour12: false })}</span>}
        </li>
      </ol>
      {cause.metrics.length > 0 ? (
        <div className={v.gauges}>
          {cause.metrics.map((metric) => <Gauge key={metric.id} metric={metric} />)}
        </div>
      ) : (
        help?.error && <p className={`${v.causeText} t-body-sm c-secondary`}>{help.error}</p>
      )}
      {cause.samples !== null && <p className="t-caption c-tertiary">{t('판정에 쓴 요청 {0}건', { 0: cause.samples.toLocaleString('en-US') })}</p>}
    </div>
  );
}

// 카드 하나에 보이는 칸 수. 나머지는 "외 N칸" (근거 칸 "읽은 값"에 모두 있다)
const CARD_ROWS = 5;

/**
 * 명세 카드: 요소(구성요소·진입·연결·점검)마다 한 장. filled 장까지는 확인한 카드라 파랑으로 채우고 체크를 그린다.
 * 채우는 장이 바뀌면 그 카드가 보이도록 큰 카드 안을 스크롤한다
 */
export function SpecCards({ cards, filled }: { cards: SpecCard[]; filled: number }) {
  const list = useRef<HTMLOListElement>(null);
  useEffect(() => {
    if (filled <= 0 || filled > cards.length) return;
    const card = list.current?.children[filled - 1] as HTMLElement | undefined;
    card?.scrollIntoView({ block: 'nearest', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }, [filled, cards.length]);
  return (
    <ol ref={list} className={`${v.specCards} scroll-fade`}>
      {cards.map((card, index) => {
        const more = card.rows.length - CARD_ROWS;
        return (
          <li key={card.id} className={v.specCard} data-done={index < filled || undefined} style={{ '--i': index } as CSSProperties}>
            <span className={v.specFill} aria-hidden="true" />
            <span className={v.specHead}>
              <span className={v.specIcon}>
                <Icon name={card.icon} />
              </span>
              <span className={v.specTitle}>
                <span className="t-label-md">{card.title}</span>
                <span className="t-caption c-tertiary">{[card.kind, card.review > 0 ? t('확인 {0}칸', { 0: card.review }) : null].filter(Boolean).join(' · ')}</span>
              </span>
              <span className={v.tick} aria-label={index < filled ? t('확인함') : undefined}>
                <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
                  <path d="M20 6 9 17l-5-5" />
                </svg>
              </span>
            </span>
            <ul className={v.specRows}>
              {card.rows.slice(0, CARD_ROWS).map((row) => (
                <li key={row.key} className={v.specRow} data-review={row.review || undefined} data-prose={row.prose || undefined}>
                  <span className="t-caption">{row.name}</span>
                  <span className={row.prose ? 't-body-sm' : 't-code-sm'} title={row.value || undefined}>
                    {row.unread ? t('읽지 못함') : row.value || '—'}
                  </span>
                </li>
              ))}
            </ul>
            {more > 0 && <span className={`${v.specMore} t-caption c-tertiary`}>{t('외 {0}칸', { 0: more })}</span>}
          </li>
        );
      })}
    </ol>
  );
}

/** 확정 애니메이션: play() 가 카드를 하나씩 채우고, 다 채우면 끝난다. reset() 은 처음으로 */
export function useSweep(count: number) {
  const [filled, setFilled] = useState(0);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const play = () =>
    new Promise<void>((resolve) => {
      window.clearTimeout(timer.current);
      const step = sweepStepMs(count);
      let shown = 0;
      setFilled(0);
      const tick = () => {
        shown += 1;
        setFilled(shown);
        timer.current = window.setTimeout(shown >= count ? resolve : tick, shown >= count ? 480 : step);
      };
      timer.current = window.setTimeout(tick, 80);
    });
  const reset = () => {
    window.clearTimeout(timer.current);
    setFilled(0);
  };
  return { filled, play, reset };
}
