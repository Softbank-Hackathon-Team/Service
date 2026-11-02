import { useEffect, useMemo, useState } from 'react';
import type { BentoLayout } from '../../components/layout/ConsoleLayout';
import { FoldTile, Hero, Stack } from '../../components/layout/tiles';
import { Badge, BarPill } from '../../components/ui/controls';
import { go } from '../../app/routes';
import { api } from '../../lib/api';
import { errorText } from '../../lib/errors';
import { or404 } from '../../lib/http';
import { PROVIDER_SHORT } from '../../lib/status';
import type { EnvEstimate, FullEstimate, MigrationCostView, Provider } from '../../lib/types';
import { usePoll } from '../../lib/usePoll';
import { usd } from '../migration/model';
import { costCaveats, envCaption, ORIGIN } from './model';
import { ShellLayout } from '../shell/ShellLayout';
import s from '../common/page.module.css';

const LAYOUT: BentoLayout = { columns: ['fill', 'wide'], areas: 'hero side' };
const TARGETS: Provider[] = ['aws', 'gcp', 'onprem'];

function EnvBars({ envs, cheapest }: { envs: EnvEstimate[]; cheapest: Provider | null }) {
  const max = Math.max(1, ...envs.map((env) => env.monthlyUsd ?? 0));
  return (
    <ul className={s.bars}>
      {envs.map((env) => (
        <li key={env.provider} className={s.barRow}>
          <span className={s.barHead}>
            <span className="t-label-md">
              {PROVIDER_SHORT[env.provider]} {env.provider === 'onprem' && <Badge>가정값</Badge>} {env.provider === 'azure_mock' && <Badge>모의</Badge>} {env.provider === cheapest && <Badge tone="success">최저</Badge>}
            </span>
            <span className="t-code-md">{env.feasible ? usd(env.monthlyUsd) : '불가'}</span>
          </span>
          <span className={s.barTrack}>
            <span className={s.barFill} style={{ width: `${((env.monthlyUsd ?? 0) / max) * 100}%` }} />
          </span>
          {env.nodeSku && <span className="t-caption c-tertiary">{env.nodeSku} × {env.nodes}</span>}
          {envCaption(env) && <span className={`t-caption ${env.feasible ? 'c-tertiary' : 'c-warning'}`}>{envCaption(env)}</span>}
        </li>
      ))}
    </ul>
  );
}

/** 가격표가 어디서 왔고 언제 것인지. 숫자를 믿어도 되는지는 여기서 판단한다. */
function PriceSources({ view }: { view: MigrationCostView }) {
  const { estimate, priceSources } = view;
  return (
    <FoldTile title="가격 근거" summary={estimate.priceStale ? '오래된 가격' : `기준일 ${estimate.priceAsOf.slice(0, 10)}`} defaultOpen={estimate.priceStale}>
      {priceSources.length > 0 ? (
        <ul className={s.rows}>
          {priceSources.map((source) => (
            <li key={source.vendor} className={s.row}>
              <span className="t-label-md">{PROVIDER_SHORT[source.vendor]}</span>
              <span className={`${s.rowValue} t-caption c-tertiary`}>
                {ORIGIN[source.origin]} · {source.fetchedAt.slice(0, 10)}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className={`${s.note} t-body-sm c-tertiary`}>가격표 출처 기록이 아직 없습니다.</p>
      )}
      {estimate.priceStale && <p className={`${s.note} t-body-sm c-warning`}>7일 넘게 새 가격을 받지 못했습니다. 승인을 막지는 않습니다.</p>}
    </FoldTile>
  );
}

/** 조건을 바꿔 보는 칸. 서버에 저장하지 않는다. */
function Simulator({ migrationId, from, initialRps }: { migrationId: string; from: Provider | undefined; initialRps: number }) {
  const spec = usePoll(() => or404(api.migrationSpec(migrationId)), null, [migrationId]);
  const [rps, setRps] = useState(initialRps);
  const [profile, setProfile] = useState<'startup' | 'finance'>('startup');
  const [result, setResult] = useState<FullEstimate | null>(null);
  const [error, setError] = useState<string | null>(null);
  const specView = spec.data;
  const body = useMemo(
    () => (specView?.complete ? { spec: specView.spec, from, targets: TARGETS, traffic: { peakRps: rps }, profile, applyCredits: false } : null),
    [specView, from, rps, profile],
  );
  useEffect(() => {
    if (!body) return;
    let gone = false;
    const timer = window.setTimeout(() => {
      api.estimate(body).then(
        (estimate) => {
          if (!gone) {
            setResult(estimate);
            setError(null);
          }
        },
        (reason: unknown) => {
          if (!gone) setError(errorText(reason));
        },
      );
    }, 300);
    return () => {
      gone = true;
      window.clearTimeout(timer);
    };
  }, [body]);
  return (
    <FoldTile title="조건 바꿔 보기" summary={`초당 ${rps.toLocaleString('en-US')} 요청`}>
      {specView && !specView.complete ? (
        <p className={`${s.note} t-body-sm c-tertiary`}>명세가 완성되면 조건을 바꿔 볼 수 있습니다.</p>
      ) : (
        <div className={s.form}>
          <label className={s.formRow}>
            <span className="t-label-md">피크 요청</span>
            <input className={s.range} type="range" min={1} max={8000} step={1} value={rps} aria-label="초당 피크 요청" onChange={(event) => setRps(Number(event.target.value))} />
          </label>
          <label className={s.formRow}>
            <span className="t-label-md">보안 수준</span>
            <select className={`${s.select} t-label-md`} value={profile} onChange={(event) => setProfile(event.target.value as 'startup' | 'finance')}>
              <option value="startup">기본</option>
              <option value="finance">강화</option>
            </select>
          </label>
          {error && <p className="t-body-sm c-danger">{error}</p>}
          {result && <EnvBars envs={result.envs} cheapest={result.cheapest} />}
          {result && result.breakpoints.length > 0 && (
            <ul className={s.rows}>
              {result.breakpoints.map((point) => (
                <li key={point.fromRps} className={s.row}>
                  <span className="t-body-sm">초당 {point.fromRps.toLocaleString('en-US')} 요청부터</span>
                  <Badge>{PROVIDER_SHORT[point.cheapest]}가 최저</Badge>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </FoldTile>
  );
}

export function CostPage({ id }: { id: string }) {
  const cost = usePoll(() => or404(api.migrationCost(id)), 30_000, [id]);
  const view = cost.data;
  const diff = view?.pair.monthlyUsd ?? null;
  const title = !view
    ? cost.error ? '비용을\n계산하지 못했습니다' : '비용을\n계산하고 있습니다'
    : diff === null ? '한쪽 비용을\n계산할 수 없습니다'
    : diff >= 0 ? `옮기면 월 ${usd(diff)}\n아낍니다` : `옮기면 월 ${usd(-diff)}\n더 듭니다`;
  return (
    <ShellLayout layout={LAYOUT} barLeft={<BarPill label="이전으로" icon="rollback" onClick={() => go(`migrations/${id}`)} />}>
      <Hero
        tone="run"
        meta={view ? (view.specFrom === 'demo' ? '예시 앱 기준' : view.origin === 'stored' ? '승인 때 저장한 추정' : '미리보기') : '비용'}
        title={title}
        foot="공개 가격표와 가정으로 낸 추정입니다. 청구서가 아닙니다. 온프레 값은 가정입니다"
      >
        {view && (
          <ul className={s.heroStats}>
            <li><span className="t-metric-lg">{usd(view.pair.sourceMonthlyUsd)}</span><span className="t-caption c-tertiary">{view.source?.name ?? '출발'}</span></li>
            <li><span className="t-metric-lg">{usd(view.pair.targetMonthlyUsd)}</span><span className="t-caption c-tertiary">{view.target?.name ?? '도착'}</span></li>
          </ul>
        )}
        {view && costCaveats(view).map((line) => (
          <p key={line} className="t-body-md c-warning">{line}</p>
        ))}
      </Hero>
      <Stack area="side">
        {view?.estimate && (
          <FoldTile title="환경별 월 비용" summary={`피크 초당 ${view.estimate.peakRps} 요청`}>
            <EnvBars envs={view.estimate.envs} cheapest={view.estimate.cheapest} />
          </FoldTile>
        )}
        {view && <PriceSources view={view} />}
        {view?.estimate && <Simulator key={view.estimate.peakRps} migrationId={id} from={view.pair.from} initialRps={view.estimate.peakRps} />}
      </Stack>
    </ShellLayout>
  );
}
