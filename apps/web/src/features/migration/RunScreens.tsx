import { useState } from 'react';
import { ActionRow, FoldTile, Hero, Stack } from '../../components/layout/tiles';
import { ActionPill, BarPill } from '../../components/ui/controls';
import { TrafficBar } from '../../components/ui/TrafficBar';
import { api } from '../../lib/api';
import { errorText } from '../../lib/errors';
import { stopReasonOf } from '../../lib/failure';
import { or404 } from '../../lib/http';
import { LIVE_REASON } from '../../lib/liveTraffic';
import { isTerminal, LABEL } from '../../lib/status';
import { latestMeasurements, MEASURE_LABEL } from '../../lib/timelineDetail';
import { useNow } from '../../lib/useNow';
import { usePoll } from '../../lib/usePoll';
import { AgentFold, useAgentReview } from '../agent/AgentResult';
import { failureAnalysisOf } from '../agent/model';
import { LeftoverFold, StopFold, TrafficReportFold } from './EvidenceFolds';
import { canRollback, formatClock, runTitle, shiftNote, trafficPercent } from './model';
import { isRehearsalCode, rehearsalHeroLine } from './rehearsal';
import { RehearsalFolds, useRehearsal } from './RehearsalFold';
import { SecurityFold } from './SecurityCard';
import { ConfirmPill, Frame, useAction, useCostConsent, type ScreenProps } from './shared';
import s from '../common/page.module.css';
import { t } from '../../lib/i18n';

const routeEnds = (route: string) => {
  const [source = t('출발'), target = t('도착')] = route.split(' → ');
  return { source, target };
};

function useTraffic({ id, status }: ScreenProps['migration']) {
  const active = status === 'shifting';
  const shift = usePoll(() => or404(api.trafficShift(id)), isTerminal(status) ? null : active ? 1000 : 5000, [id, active]);
  return { percent: trafficPercent(status, shift.data ?? null), note: shiftNote(status, shift.data ?? null) };
}

/** 앱 앞 프록시가 직접 센 값. 없으면 없다고만 적는다. 컷오버 동안 붙잡았다 보낸 요청은 끊김 없이 넘겼다는 근거라 따로 적는다. */
function LiveFold({ migration }: Pick<ScreenProps, 'migration'>) {
  const live = usePoll(() => api.liveTraffic(migration.id), isTerminal(migration.status) ? null : 1000, [migration.id]);
  const view = live.data;
  const available = view?.available === true;
  const failed = available && view.fail > 0;
  return (
    <FoldTile title={t('가동 중 앱')} summary={available ? (failed ? t('실패 {0}건', { 0: view.fail }) : t('실패 없음')) : t('숫자 없음')}>
      {available ? (
        <>
          <ul className={s.stats}>
            <li>
              <span className="t-metric-lg">{view.total.toLocaleString('en-US')}</span>
              <span className="t-caption c-tertiary">{t('요청')}</span>
            </li>
            <li>
              <span className={`t-metric-lg ${failed ? 'c-danger' : ''}`}>{view.fail.toLocaleString('en-US')}</span>
              <span className="t-caption c-tertiary">{t('실패')}</span>
            </li>
            <li>
              <span className="t-metric-lg">{view.p95Ms ?? '–'}</span>
              <span className="t-caption c-tertiary">p95 ms</span>
            </li>
          </ul>
          {view.held > 0 && (
            <ul className={s.rows}>
              <li className={s.row}>
                <span className="t-label-md">{t('컷오버 때 잠깐 붙잡은 요청')}</span>
                <span className={`${s.rowValue} t-code-sm c-secondary`}>
                  {t('{0}건 · 최대 {1}ms', { 0: view.held.toLocaleString('en-US'), 1: Math.round(view.maxHoldMs) })}
                </span>
              </li>
            </ul>
          )}
        </>
      ) : (
        <p className={`${s.note} t-body-sm c-tertiary`}>{view?.reason ? LIVE_REASON[view.reason] : t('앱 요청 숫자를 읽지 못했습니다.')}</p>
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
    <FoldTile key={items.length > 0 ? 'has' : 'none'} title={t('측정값')} summary={items.length > 0 ? t('{0}개', { 0: items.length }) : t('아직 없음')} defaultOpen={items.length > 0}>
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
        <p className={`${s.note} t-body-sm c-tertiary`}>{t('복제와 컷오버 단계에서 생깁니다.')}</p>
      )}
    </FoldTile>
  );
}

const ACTORS: Record<string, string> = { worker: t('워커'), api: 'API', system: t('시스템') };

function TimelineFold({ migration }: Pick<ScreenProps, 'migration'>) {
  const timeline = useTimeline(migration);
  const moves = timeline.data?.items.filter((item) => item.kind === 'transition') ?? [];
  return (
    <FoldTile title={t('타임라인')} summary={t('전이 {0}번', { 0: moves.length })} defaultOpen={false}>
      <ul className={s.rows}>
        {[...moves].reverse().map((item) => (
          <li key={item.seq} className={s.row}>
            <span className="t-label-md">{item.to && item.to in LABEL ? LABEL[item.to as keyof typeof LABEL] : item.action}</span>
            <span className="t-caption c-tertiary">
              {ACTORS[item.actor] ?? t('사람')} · {new Date(item.at).toTimeString().slice(0, 8)}
            </span>
          </li>
        ))}
      </ul>
    </FoldTile>
  );
}

function RollbackPill({ migration, busy, onConfirm }: Pick<ScreenProps, 'migration'> & { busy: boolean; onConfirm: () => void }) {
  if (!canRollback(migration)) return null;
  return <ConfirmPill label={t('롤백')} confirmLabel={t('출발로 되돌리기')} icon="rollback" tone="danger" disabled={busy} onConfirm={onConfirm} />;
}

export function RunningScreen({ migration, route, onChanged }: ScreenProps) {
  const { source, target } = routeEnds(route);
  const traffic = useTraffic(migration);
  const { busy, error, run } = useAction(onChanged);
  const rehearsal = useRehearsal(migration);
  const deploying = migration.status === 'deploying';
  // 처음 읽는 동안은 줄이 없는 것과 구별이 안 돼서 아무것도 쓰지 않는다
  const rehearsalLine = deploying && !rehearsal.loading ? rehearsalHeroLine(rehearsal.run, rehearsal.stale) : null;
  return (
    <Frame migration={migration} route={route}>
      <Hero tone="run" meta={LABEL[migration.status]} title={runTitle(migration.status)}>
        <TrafficBar source={source} target={target} targetPercent={traffic.percent} />
        {traffic.note && <p className="t-body-md c-secondary">{traffic.note}</p>}
        {rehearsalLine && <p className="t-body-md c-secondary">{rehearsalLine}</p>}
      </Hero>
      <Stack area="side">
        <RehearsalFolds migration={migration} run={rehearsal.run} stale={rehearsal.stale} defaultOpen={deploying} />
        <LiveFold migration={migration} />
        <MeasureFold migration={migration} />
        <TimelineFold migration={migration} />
        <SecurityFold migration={migration} />
        <ActionRow notice={error}>
          <RollbackPill migration={migration} busy={busy} onConfirm={() => void run(() => api.rollback(migration.id))} />
        </ActionRow>
      </Stack>
    </Frame>
  );
}

function useCountdown(endsAt: string | null | undefined) {
  const now = useNow(1000);
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
        meta={t('롤백 대기')}
        title={over ? t('자원을\n정리하고 있습니다') : t('{0}로\n되돌릴 수 있는 시간입니다', { 0: source })}
        foot={over ? t('이제 되돌릴 수 없습니다') : t('시간이 끝나면 임시 자원을 지우고 되돌릴 수 없습니다')}
      >
        {!over && <span className={`${s.clock} t-metric-2xl`}>{formatClock(left)}</span>}
        <TrafficBar source={source} target={target} targetPercent={100} />
      </Hero>
      <Stack area="side">
        <LiveFold migration={migration} />
        <MeasureFold migration={migration} />
        <TimelineFold migration={migration} />
        <SecurityFold migration={migration} />
        {!over && (
          <ActionRow notice={error}>
            <RollbackPill migration={migration} busy={busy} onConfirm={() => void run(() => api.rollback(migration.id))} />
            {asking && <BarPill label={t('그만두기')} onClick={() => setAsking(false)} />}
            <ActionPill
              label={busy ? t('보내는 중') : asking ? t('되돌릴 수 없습니다. 회수하기') : t('리소스 회수')}
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
  const { percent } = useTraffic(migration);
  const { busy, error, code, run } = useAction(onChanged);
  const consent = useCostConsent(code);
  const review = useAgentReview(migration.id);
  const [cleared, setCleared] = useState(false);
  // 서버 규칙(apps/api control.ts): 실패 코드 없이 멈춘 경우만 재개에 "원인이 풀렸다" 확인이 필요하다.
  //   실패 코드로 멈춘 경우만 재시도 한도를 센다 → 넘으면 비용 동의(useCostConsent) 뒤 다시 보낸다
  const byRule = !migration.failureCode;
  const reason = stopReasonOf(migration.failureCode, migration.status);
  const rehearsal = useRehearsal(migration);
  return (
    <Frame migration={migration} route={route}>
      <Hero
        tone="stop"
        meta={migration.pausedFrom ? t('{0}에서 멈춤', { 0: LABEL[migration.pausedFrom] }) : t('멈춤')}
        title={reason?.title ?? t('작업이\n멈췄습니다')}
        foot={t('지금 트래픽 비율을 그대로 유지합니다')}
      >
        <div className={s.heroPanel}>
          <TrafficBar source={source} target={target} targetPercent={percent} />
        </div>
      </Hero>
      <Stack area="side">
        {reason && <StopFold migration={migration} reason={reason} into="paused" analysis={failureAnalysisOf(review.data)} />}
        <RehearsalFolds migration={migration} run={rehearsal.run} stale={rehearsal.stale} defaultOpen={isRehearsalCode(migration.failureCode)} />
        <AgentFold migrationId={migration.id} review={review} />
        <LiveFold migration={migration} />
        <TimelineFold migration={migration} />
        <SecurityFold migration={migration} />
        <ActionRow
          notice={consent.notice(error)}
          before={
            byRule ? (
              <label className={`${s.resumeCheck} t-body-md`}>
                <input type="checkbox" checked={cleared} onChange={(event) => setCleared(event.target.checked)} />
                {t('멈춘 원인이 풀렸습니다')}
              </label>
            ) : (
              consent.check
            )
          }
        >
          <RollbackPill migration={migration} busy={busy} onConfirm={() => void run(() => api.rollback(migration.id))} />
          <ActionPill
            label={busy ? t('보내는 중') : consent.accept ? t('고객 부담으로 재개') : t('마이그레이션 재개')}
            icon="play"
            disabled={busy || (byRule && !cleared) || consent.waiting}
            onClick={() => void run(() => api.resume(migration.id, byRule ? cleared : undefined, consent.accept))}
          />
        </ActionRow>
      </Stack>
    </Frame>
  );
}

export function RollingBackScreen({ migration, route }: ScreenProps) {
  const { source, target } = routeEnds(route);
  const { percent } = useTraffic(migration);
  const reason = stopReasonOf(migration.failureCode, migration.status);
  return (
    <Frame migration={migration} route={route}>
      <Hero
        tone="stop"
        meta={reason ? t('자동 롤백 · {0}', { 0: reason.label }) : t('롤백')}
        title={t('{0}로\n되돌리고 있습니다', { 0: source })}
        foot={t('되돌린 뒤 이 마이그레이션이 도착에 만든 자원을 지웁니다')}
      >
        <div className={s.heroPanel}>
          <TrafficBar source={source} target={target} targetPercent={percent} />
        </div>
      </Hero>
      <Stack area="side">
        {reason && <StopFold migration={migration} reason={reason} into="rolling_back" />}
        <LiveFold migration={migration} />
        <MeasureFold migration={migration} />
        <TimelineFold migration={migration} />
        <SecurityFold migration={migration} />
      </Stack>
    </Frame>
  );
}

/** 증적 리포트를 새 탭에 연다. 버튼 줄은 화면이 Stack 안에 직접 둔다. */
function useReport(id: string) {
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
  return { error, open };
}

export function RolledBackScreen({ migration, route }: ScreenProps) {
  const { source } = routeEnds(route);
  const report = useReport(migration.id);
  const reason = stopReasonOf(migration.failureCode, migration.status);
  return (
    <Frame migration={migration} route={route}>
      <Hero tone="run" meta={reason ? t('자동 롤백 완료 · {0}', { 0: reason.label }) : t('롤백 완료')} title={t('트래픽을 모두\n{0}로 되돌렸습니다', { 0: source })} foot={t('이 마이그레이션이 도착에 만든 자원은 자동으로 지웁니다')} />
      <Stack area="side">
        <LeftoverFold migration={migration} title={t('도착에 남은 자원')} />
        {reason && <StopFold migration={migration} reason={reason} into="rolling_back" defaultOpen={false} />}
        <TrafficReportFold migration={migration} />
        <TimelineFold migration={migration} />
        <SecurityFold migration={migration} />
        <ActionRow notice={report.error}>
          <ActionPill label={t('증적 리포트')} icon="download" onClick={() => void report.open()} />
        </ActionRow>
      </Stack>
    </Frame>
  );
}

export function CleanupScreen({ migration, route }: ScreenProps) {
  const { source } = routeEnds(route);
  return (
    <Frame migration={migration} route={route}>
      <Hero tone="done" meta={t('정리')} title={t('{0}의 임시 자원을\n지우고 있습니다', { 0: source })} foot={t('이제 되돌릴 수 없습니다')} />
      <Stack area="side">
        <MeasureFold migration={migration} />
        <SecurityFold migration={migration} />
      </Stack>
    </Frame>
  );
}

export function DoneScreen({ migration, route }: ScreenProps) {
  const { target } = routeEnds(route);
  const report = useReport(migration.id);
  const rehearsal = useRehearsal(migration);
  return (
    <Frame migration={migration} route={route}>
      <Hero tone="done" meta={t('완료')} title={t('멈추지 않고\n{0}로 옮겼습니다', { 0: target })} foot={t('누가 요청하고 승인했는지 모두 기록했습니다')} />
      <Stack area="side">
        <LiveFold migration={migration} />
        <TrafficReportFold migration={migration} />
        <RehearsalFolds migration={migration} run={rehearsal.run} stale={rehearsal.stale} defaultOpen={false} />
        <MeasureFold migration={migration} />
        <TimelineFold migration={migration} />
        <SecurityFold migration={migration} />
        <ActionRow notice={report.error}>
          <ActionPill label={t('증적 리포트')} icon="download" onClick={() => void report.open()} />
        </ActionRow>
      </Stack>
    </Frame>
  );
}
