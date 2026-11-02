import { useEffect, useState } from 'react';
import { ActionRow, FoldTile, Hero, Stack } from '../../components/layout/tiles';
import { ActionPill, BarPill } from '../../components/ui/controls';
import { TrafficBar } from '../../components/ui/TrafficBar';
import { api } from '../../lib/api';
import { errorText } from '../../lib/errors';
import { or404 } from '../../lib/http';
import { isTerminal, LABEL } from '../../lib/status';
import { latestMeasurements, MEASURE_LABEL } from '../../lib/timelineDetail';
import { usePoll } from '../../lib/usePoll';
import { AgentFold } from '../agent/AgentResult';
import { canRollback, formatClock, runTitle, trafficPercent } from './model';
import { ConfirmPill, Frame, useAction, type ScreenProps } from './shared';
import s from '../common/page.module.css';

const routeEnds = (route: string) => {
  const [source = '출발', target = '도착'] = route.split(' → ');
  return { source, target };
};

function useTraffic({ id, status }: ScreenProps['migration']) {
  const active = status === 'shifting';
  const shift = usePoll(() => or404(api.trafficShift(id)), isTerminal(status) ? null : active ? 1000 : 5000, [id, active]);
  return trafficPercent(status, shift.data ?? null);
}

/** 앱 앞 프록시가 직접 센 값. 없으면 없다고만 적는다. */
function LiveFold({ migration }: Pick<ScreenProps, 'migration'>) {
  const live = usePoll(() => api.liveTraffic(migration.id), isTerminal(migration.status) ? null : 1000, [migration.id]);
  const view = live.data;
  const available = view?.available === true;
  const failed = available && view.fail > 0;
  return (
    <FoldTile title="가동 중 앱" summary={available ? (failed ? `실패 ${view.fail}건` : '실패 없음') : '숫자 없음'}>
      {available ? (
        <ul className={s.stats}>
          <li>
            <span className="t-metric-lg">{view.total.toLocaleString('en-US')}</span>
            <span className="t-caption c-tertiary">요청</span>
          </li>
          <li>
            <span className={`t-metric-lg ${failed ? 'c-danger' : ''}`}>{view.fail.toLocaleString('en-US')}</span>
            <span className="t-caption c-tertiary">실패</span>
          </li>
          <li>
            <span className="t-metric-lg">{view.p95Ms ?? '–'}</span>
            <span className="t-caption c-tertiary">p95 ms</span>
          </li>
        </ul>
      ) : (
        <p className={`${s.note} t-body-sm c-tertiary`}>앱 요청 숫자를 읽지 못했습니다.</p>
      )}
    </FoldTile>
  );
}

function useTimeline(migration: ScreenProps['migration']) {
  return usePoll(() => or404(api.timeline(migration.id)), isTerminal(migration.status) ? null : 5000, [migration.id, migration.version]);
}

function MeasureFold({ migration }: Pick<ScreenProps, 'migration'>) {
  const timeline = useTimeline(migration);
  const items = timeline.data ? latestMeasurements(timeline.data.items) : [];
  return (
    // 값이 처음 생기면 펼쳐 보이게 다시 그린다. 그 뒤에는 사람이 접은 상태를 유지한다.
    <FoldTile key={items.length > 0 ? 'has' : 'none'} title="측정값" summary={items.length > 0 ? `${items.length}개` : '아직 없음'} defaultOpen={items.length > 0}>
      {items.length > 0 ? (
        <ul className={s.rows}>
          {items.map((item) => (
            <li key={item.name} className={s.row}>
              <span className="t-label-md">{MEASURE_LABEL[item.name] ?? item.name}</span>
              <span className="t-code-sm c-secondary">
                {item.value.toLocaleString('en-US')} {item.unit}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className={`${s.note} t-body-sm c-tertiary`}>복제와 컷오버 단계에서 생깁니다.</p>
      )}
    </FoldTile>
  );
}

const ACTORS: Record<string, string> = { worker: '워커', api: 'API', system: '시스템' };

function TimelineFold({ migration }: Pick<ScreenProps, 'migration'>) {
  const timeline = useTimeline(migration);
  const moves = timeline.data?.items.filter((item) => item.kind === 'transition') ?? [];
  return (
    <FoldTile title="타임라인" summary={`전이 ${moves.length}번`} defaultOpen={false}>
      <ul className={s.rows}>
        {[...moves].reverse().map((item) => (
          <li key={item.seq} className={s.row}>
            <span className="t-label-md">{item.to && item.to in LABEL ? LABEL[item.to as keyof typeof LABEL] : item.action}</span>
            <span className="t-caption c-tertiary">
              {ACTORS[item.actor] ?? '사람'} · {new Date(item.at).toTimeString().slice(0, 8)}
            </span>
          </li>
        ))}
      </ul>
    </FoldTile>
  );
}

function RollbackPill({ migration, busy, onConfirm }: Pick<ScreenProps, 'migration'> & { busy: boolean; onConfirm: () => void }) {
  if (!canRollback(migration)) return null;
  return <ConfirmPill label="롤백" confirmLabel="출발로 되돌리기" icon="rollback" tone="danger" disabled={busy} onConfirm={onConfirm} />;
}

export function RunningScreen({ migration, route, onChanged }: ScreenProps) {
  const { source, target } = routeEnds(route);
  const percent = useTraffic(migration);
  const { busy, error, run } = useAction(onChanged);
  return (
    <Frame migration={migration} route={route}>
      <Hero tone="run" meta={LABEL[migration.status]} title={runTitle(migration.status)}>
        <TrafficBar source={source} target={target} targetPercent={percent} />
      </Hero>
      <Stack area="side">
        <LiveFold migration={migration} />
        <MeasureFold migration={migration} />
        <TimelineFold migration={migration} />
        <ActionRow notice={error}>
          <RollbackPill migration={migration} busy={busy} onConfirm={() => void run(() => api.rollback(migration.id))} />
        </ActionRow>
      </Stack>
    </Frame>
  );
}

function useCountdown(endsAt: string | null | undefined) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return endsAt ? Math.max(0, (Date.parse(endsAt) - now) / 1000) : 0;
}

export function WindowScreen({ migration, route, onChanged }: ScreenProps) {
  const { source, target } = routeEnds(route);
  const left = useCountdown(migration.rollbackWindowEndsAt);
  const { busy, error, run } = useAction(onChanged);
  const [asking, setAsking] = useState(false);
  const over = left <= 0;
  return (
    <Frame migration={migration} route={route}>
      <Hero
        tone="done"
        meta="롤백 대기"
        title={over ? '자원을\n정리하고 있습니다' : `${source}로 되돌릴 수\n있는 시간입니다`}
        foot={over ? '이제 되돌릴 수 없습니다' : '시간이 끝나면 임시 자원을 지우고 되돌릴 수 없습니다'}
      >
        {!over && <span className={`${s.clock} t-metric-2xl`}>{formatClock(left)}</span>}
        <TrafficBar source={source} target={target} targetPercent={100} />
      </Hero>
      <Stack area="side">
        <LiveFold migration={migration} />
        <MeasureFold migration={migration} />
        <TimelineFold migration={migration} />
        {!over && (
          <ActionRow notice={error}>
            <RollbackPill migration={migration} busy={busy} onConfirm={() => void run(() => api.rollback(migration.id))} />
            {asking && <BarPill label="그만두기" onClick={() => setAsking(false)} />}
            <ActionPill
              label={busy ? '보내는 중' : asking ? '되돌릴 수 없습니다. 회수하기' : '리소스 회수'}
              icon="server"
              disabled={busy}
              onClick={() => {
                if (!asking) return setAsking(true);
                setAsking(false);
                void run(() => api.reclaim(migration.id));
              }}
            />
          </ActionRow>
        )}
      </Stack>
    </Frame>
  );
}

export function PausedScreen({ migration, route, onChanged }: ScreenProps) {
  const { source, target } = routeEnds(route);
  const percent = useTraffic(migration);
  const { busy, error, run } = useAction(onChanged);
  const [cleared, setCleared] = useState(false);
  const byRule = !migration.failureCode;
  return (
    <Frame migration={migration} route={route}>
      <Hero
        tone="stop"
        meta={migration.pausedFrom ? `${LABEL[migration.pausedFrom]}에서 멈춤` : '멈춤'}
        title={byRule ? '가드레일이\n이전을 멈췄습니다' : '작업이\n멈췄습니다'}
        foot="지금 트래픽 비율을 그대로 유지합니다"
      >
        {migration.failureCode && <code className={`${s.code} t-code-md`}>{migration.failureCode}</code>}
        <div className={s.heroPanel}>
          <TrafficBar source={source} target={target} targetPercent={percent} />
        </div>
      </Hero>
      <Stack area="side">
        <AgentFold migrationId={migration.id} />
        <LiveFold migration={migration} />
        <TimelineFold migration={migration} />
        <ActionRow
          notice={error}
          before={
            byRule && (
              <label className={`${s.resumeCheck} t-body-md`}>
                <input type="checkbox" checked={cleared} onChange={(event) => setCleared(event.target.checked)} />
                멈춘 원인이 풀렸습니다
              </label>
            )
          }
        >
          <RollbackPill migration={migration} busy={busy} onConfirm={() => void run(() => api.rollback(migration.id))} />
          <ActionPill
            label={busy ? '보내는 중' : '이전 재개'}
            icon="play"
            disabled={busy || (byRule && !cleared)}
            onClick={() => void run(() => api.resume(migration.id, byRule ? cleared : undefined))}
          />
        </ActionRow>
      </Stack>
    </Frame>
  );
}

export function RollingBackScreen({ migration, route }: ScreenProps) {
  const { source, target } = routeEnds(route);
  const percent = useTraffic(migration);
  return (
    <Frame migration={migration} route={route}>
      <Hero tone="stop" meta="롤백" title={`${source}로\n되돌리고 있습니다`} foot="도착 환경은 원인 조사를 위해 지우지 않습니다">
        {migration.failureCode && <code className={`${s.code} t-code-md`}>{migration.failureCode}</code>}
        <div className={s.heroPanel}>
          <TrafficBar source={source} target={target} targetPercent={percent} />
        </div>
      </Hero>
      <Stack area="side">
        <LiveFold migration={migration} />
        <MeasureFold migration={migration} />
        <TimelineFold migration={migration} />
      </Stack>
    </Frame>
  );
}

function ReportPill({ id }: { id: string }) {
  const [error, setError] = useState<string | null>(null);
  const open = async () => {
    setError(null);
    try {
      const url = URL.createObjectURL(new Blob([await api.reportHtml(id)], { type: 'text/html' }));
      window.open(url, '_blank', 'noopener');
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (reason) {
      setError(errorText(reason));
    }
  };
  return (
    <ActionRow notice={error}>
      <ActionPill label="증적 리포트" icon="download" onClick={() => void open()} />
    </ActionRow>
  );
}

export function RolledBackScreen({ migration, route }: ScreenProps) {
  const { source } = routeEnds(route);
  return (
    <Frame migration={migration} route={route}>
      <Hero tone="run" meta="롤백 완료" title={`트래픽을 모두\n${source}로 되돌렸습니다`} foot="도착 환경은 남겨 두었습니다" />
      <Stack area="side">
        <MeasureFold migration={migration} />
        <TimelineFold migration={migration} />
        <ReportPill id={migration.id} />
      </Stack>
    </Frame>
  );
}

export function CleanupScreen({ migration, route }: ScreenProps) {
  const { source } = routeEnds(route);
  return (
    <Frame migration={migration} route={route}>
      <Hero tone="done" meta="정리" title={`${source}의 임시 자원을\n지우고 있습니다`} foot="이제 되돌릴 수 없습니다" />
      <Stack area="side">
        <MeasureFold migration={migration} />
      </Stack>
    </Frame>
  );
}

export function DoneScreen({ migration, route }: ScreenProps) {
  const { target } = routeEnds(route);
  return (
    <Frame migration={migration} route={route}>
      <Hero tone="done" meta="완료" title={`멈추지 않고\n${target}로 옮겼습니다`} foot="누가 요청하고 승인했는지 모두 기록했습니다" />
      <Stack area="side">
        <LiveFold migration={migration} />
        <MeasureFold migration={migration} />
        <TimelineFold migration={migration} />
        <ReportPill id={migration.id} />
      </Stack>
    </Frame>
  );
}
