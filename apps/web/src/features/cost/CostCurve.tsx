import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { Icon } from '../../components/ui/Icon';
import { api } from '../../lib/api';
import { errorText } from '../../lib/errors';
import { or404 } from '../../lib/http';
import { PROVIDER_SHORT } from '../../lib/status';
import type { EnvEstimate, MigrationCostView } from '../../lib/types';
import { usePoll } from '../../lib/usePoll';
import { curveCost, curveOf, RPS_MAX, RPS_MIN, RPS_SAMPLES, rpsAt, rpsLabel, segments, smoothPath, valueAt, X_TICKS, xOf, yTicks } from './curve';
import c from './CostCurve.module.css';
import { t } from '../../lib/i18n';

// 계획 승인 "월 비용 (추정)" 카드 한 장 (11/08 사용자 결정): 비용 화면으로 옮기거나 펼치지 않고 이 안에서 설명한다.
//   x = 초당 피크 요청, y = 한 달 비용. 지금 환경(출발) = 회색 곡선, 옮길 환경(도착) = 파란 곡선 (부드럽게 이은 단조 곡선).
//   세로 막대를 끌어(또는 ←→) 그 트래픽에서 두 환경 비용을 본다. 온프레는 처음 갖추는 하드웨어 고정비를 뺀다.
// 점은 POST /cost/estimate 를 요청 수마다 불러 얻고(조건 바꿔 보기와 같은 계산), 막대가 멈춘 곳은 그 요청 수로 한 번 더 불러 정확한 값을 쓴다.

type Sample = { rps: number; envs: EnvEstimate[] };

const PAD = { left: 48, right: 12, top: 14, bottom: 24 };

/** 칸 크기를 따라 그린다 (글자가 늘어나지 않게 viewBox 대신 실제 픽셀) */
function useBox() {
  // 칸은 데이터가 온 뒤에야 생기므로 ref 대신 칸이 붙는 때를 state 로 받는다
  const [el, ref] = useState<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    if (!el) return;
    const read = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    read();
    const observer = new ResizeObserver(read);
    observer.observe(el);
    return () => observer.disconnect();
  }, [el]);
  return { ref, ...size };
}

const money = (v: number | null) => (v === null ? t('계산 불가') : `$${Math.round(v).toLocaleString('en-US')}`);
const STEP = 1.12;

export function CostCurve({ migrationId, view }: { migrationId: string; view: MigrationCostView | null }) {
  const spec = usePoll(() => or404(api.migrationSpec(migrationId)), null, [migrationId]);
  const specView = spec.data;
  const from = view?.pair.from;
  const to = view?.pair.to;
  const profile = view?.estimate.profile ?? 'startup';
  const ready = !!(specView?.complete && from && to);
  const [samples, setSamples] = useState<Sample[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cursor, setCursor] = useState<number | null>(null);
  const [exact, setExact] = useState<{ rps: number; source: number | null; target: number | null } | null>(null);
  const at = cursor ?? view?.estimate.peakRps ?? 100;
  const box = useBox();
  const dragging = useRef(false);

  const body = (rps: number) => ({ spec: specView!.spec, from, targets: [...new Set([from!, to!])], traffic: { peakRps: rps }, profile, applyCredits: false });

  // 곡선 점: 요청 수마다 한 번씩 (명세 판이 바뀌면 다시)
  useEffect(() => {
    if (!ready) return;
    let gone = false;
    Promise.all(RPS_SAMPLES.map((rps) => api.estimate(body(rps)).then((estimate) => ({ rps, envs: estimate.envs }))))
      .then((result) => !gone && (setSamples(result), setError(null)))
      .catch((reason: unknown) => !gone && setError(errorText(reason)));
    return () => {
      gone = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, specView?.version, from, to, profile]);

  // 막대가 멈춘 곳은 그 요청 수로 정확히 (끄는 동안은 곡선 값)
  useEffect(() => {
    if (!ready) return;
    let gone = false;
    const timer = window.setTimeout(() => {
      api.estimate(body(at)).then(
        (estimate) => {
          if (gone) return;
          const of = (provider: string) => curveCost(estimate.envs.find((env) => env.provider === provider));
          setExact({ rps: at, source: of(from!), target: of(to!) });
        },
        () => undefined,
      );
    }, 280);
    return () => {
      gone = true;
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, at, specView?.version, from, to, profile]);

  if (!view || !from || !to) return <p className="t-body-md c-tertiary">{t('비용을 계산하고 있습니다.')}</p>;
  if (specView && !specView.complete) return <p className="t-body-md c-tertiary">{t('명세가 완성되면 곡선을 그립니다.')}</p>;

  const source = samples ? curveOf(samples, from) : [];
  const target = samples ? curveOf(samples, to) : [];
  const fixed = exact && exact.rps === at ? exact : null;
  const srcVal = fixed ? fixed.source : valueAt(source, at);
  const dstVal = fixed ? fixed.target : valueAt(target, at);
  const delta = srcVal !== null && dstVal !== null ? srcVal - dstVal : null;
  const onprem = from === 'onprem' || to === 'onprem';

  const max = Math.max(1, ...[...source, ...target].map((p) => p.usd ?? 0), srcVal ?? 0, dstVal ?? 0);
  const ticks = yTicks(max);
  const top = ticks[ticks.length - 1]!;
  const plotW = Math.max(0, box.w - PAD.left - PAD.right);
  const plotH = Math.max(0, box.h - PAD.top - PAD.bottom);
  const X = (rps: number) => PAD.left + xOf(rps) * plotW;
  const Y = (usd: number) => PAD.top + (1 - usd / top) * plotH;
  const path = (points: typeof source) => segments(points).map((run) => smoothPath(run.map((p) => ({ x: X(p.rps), y: Y(p.usd) })))).join(' ');

  const move = (event: PointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    setCursor(rpsAt((event.clientX - rect.left - PAD.left) / Math.max(1, plotW)));
  };
  const key = (event: KeyboardEvent<SVGSVGElement>) => {
    const next = event.key === 'ArrowRight' ? at * STEP : event.key === 'ArrowLeft' ? at / STEP : event.key === 'Home' ? RPS_MIN : event.key === 'End' ? RPS_MAX : null;
    if (next === null) return;
    event.preventDefault();
    setCursor(Math.min(RPS_MAX, Math.max(RPS_MIN, Math.round(next === at * STEP ? Math.max(at + 1, next) : next))));
  };

  return (
    <div className={c.card}>
      <div className={c.readout}>
        <span className={c.end} data-end="source">
          <span className="t-caption c-secondary">{PROVIDER_SHORT[from]} · {view.source?.name ?? t('출발')}</span>
          <span className="t-metric-lg">{money(srcVal)}</span>
        </span>
        <Icon name="arrow-right" />
        <span className={c.end} data-end="target">
          <span className="t-caption c-secondary">{PROVIDER_SHORT[to]} · {view.target?.name ?? t('도착')}</span>
          <span className="t-metric-lg">{money(dstVal)}</span>
        </span>
        {delta !== null && Math.round(delta) !== 0 && (
          <span className={`${c.delta} t-label-md`} data-save={delta > 0 || undefined}>
            {delta > 0 ? t('월 {0} 아낌', { 0: money(delta) }) : t('월 {0} 더 듦', { 0: money(-delta) })}
          </span>
        )}
      </div>
      <div ref={box.ref} className={c.plot}>
        {box.w > 0 && box.h > 0 && (
          <svg
            width={box.w}
            height={box.h}
            className={c.svg}
            role="slider"
            tabIndex={0}
            aria-label={t('초당 피크 요청')}
            aria-valuemin={RPS_MIN}
            aria-valuemax={RPS_MAX}
            aria-valuenow={at}
            aria-valuetext={t('초당 피크 {0} 요청', { 0: at.toLocaleString('en-US') })}
            onPointerDown={(event) => {
              dragging.current = true;
              event.currentTarget.setPointerCapture(event.pointerId);
              move(event);
            }}
            onPointerMove={(event) => dragging.current && move(event)}
            onPointerUp={() => {
              dragging.current = false;
            }}
            onKeyDown={key}
          >
            {ticks.map((tick) => (
              <g key={tick}>
                <line className={c.grid} x1={PAD.left} x2={box.w - PAD.right} y1={Y(tick)} y2={Y(tick)} />
                <text className={`${c.axis} t-caption`} x={PAD.left - 8} y={Y(tick)} textAnchor="end" dominantBaseline="middle">
                  ${tick >= 1000 ? `${Number((tick / 1000).toFixed(1))}k` : tick}
                </text>
              </g>
            ))}
            {X_TICKS.map((tick) => (
              <text key={tick} className={`${c.axis} t-caption`} x={X(tick)} y={box.h - 6} textAnchor={tick === RPS_MAX ? 'end' : tick === RPS_MIN ? 'start' : 'middle'}>
                {rpsLabel(tick)}
              </text>
            ))}
            {/* 계획이 가정한 피크 (막대를 처음 둔 곳) */}
            <line className={c.plan} x1={X(view.estimate.peakRps)} x2={X(view.estimate.peakRps)} y1={PAD.top} y2={PAD.top + plotH} />
            <path className={c.curve} data-end="source" d={path(source)} />
            <path className={c.curve} data-end="target" d={path(target)} />
            <line className={c.cursor} x1={X(at)} x2={X(at)} y1={PAD.top - 6} y2={PAD.top + plotH} />
            <rect className={c.handle} x={X(at) - 5} y={PAD.top - 10} width={10} height={10} rx={3} />
            {srcVal !== null && <circle className={c.dot} data-end="source" cx={X(at)} cy={Y(srcVal)} r={5} />}
            {dstVal !== null && <circle className={c.dot} data-end="target" cx={X(at)} cy={Y(dstVal)} r={5} />}
          </svg>
        )}
      </div>
      <p className={`${c.foot} t-caption c-tertiary`}>
        <span>{t('초당 피크 {0} 요청', { 0: at.toLocaleString('en-US') })}</span>
        {onprem && <span>{t('온프레 하드웨어 고정비 제외')}</span>}
        {!samples && !error && <span>{t('곡선을 그리고 있습니다.')}</span>}
        {error && <span className="c-danger">{error}</span>}
      </p>
    </div>
  );
}
