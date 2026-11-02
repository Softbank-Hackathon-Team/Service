import { useEffect, useRef, useState, type ReactNode } from 'react';
import { go } from '../../app/routes';
import { withTransition } from '../../app/transition';
import { ActionRow, FoldTile, Hero, Stack } from '../../components/layout/tiles';
import { ActionPill, Badge, BarPill } from '../../components/ui/controls';
import { Icon } from '../../components/ui/Icon';
import { api } from '../../lib/api';
import { errorText } from '../../lib/errors';
import { is404, or404 } from '../../lib/http';
import { LABEL } from '../../lib/status';
import { lastPrecheckBounce } from '../../lib/timelineDetail';
import type { MigrationView, PrecheckItem } from '../../lib/types';
import { usePoll } from '../../lib/usePoll';
import { pollMs, screenOf, specRows, stepGate, stepName, usd, type MigrationScreen } from './model';
import { DoneScreen, CleanupScreen, PausedScreen, RolledBackScreen, RollingBackScreen, RunningScreen, WindowScreen } from './RunScreens';
import { ConfirmPill, Frame, useAction, type ScreenProps } from './shared';
import s from '../common/page.module.css';

const LEVEL: Record<PrecheckItem['level'], { label: string; tone: 'danger' | 'warning' | 'neutral' }> = {
  block: { label: '막힘', tone: 'danger' },
  warn: { label: '주의', tone: 'warning' },
  info: { label: '참고', tone: 'neutral' },
};

function ImportingScreen({ migration, route }: ScreenProps) {
  return (
    <Frame migration={migration} hasSide={false} route={route}>
      <Hero tone="run" meta="구성 읽기" title={'운영 중인 앱을\n읽고 있습니다'} foot="읽기만 합니다. 아무것도 바꾸지 않습니다" />
    </Frame>
  );
}

function SpecScreen({ migration, route, onChanged }: ScreenProps) {
  const spec = usePoll(() => or404(api.migrationSpec(migration.id)), null, [migration.id, migration.version]);
  const timeline = usePoll(() => or404(api.timeline(migration.id)), null, [migration.id, migration.version]);
  const { busy, error, run } = useAction(onChanged);
  const view = spec.data;
  const rows = view ? specRows(view) : [];
  const review = rows.filter((row) => row.review);
  const bounce = timeline.data ? lastPrecheckBounce(timeline.data.items) : null;
  const blocks = bounce?.items.filter((item) => item.level === 'block') ?? [];

  return (
    <Frame migration={migration} route={route}>
      <Hero
        tone={blocks.length > 0 ? 'stop' : 'run'}
        meta={blocks.length > 0 ? '사전 점검에서 돌아옴' : `명세 v${view?.version ?? ''}`}
        title={
          blocks.length > 0
            ? `막힌 항목 ${blocks.length}개를\n풀어야 합니다`
            : review.length > 0
              ? `${review.length}칸을 확인하고\n확정해 주세요`
              : '이 명세로\n옮길까요?'
        }
        foot={view?.source === 'ai_draft' ? 'AI가 추측한 초안입니다. 사람이 확정하기 전에는 계획에 쓰지 않습니다' : '확정하면 사전 점검을 시작합니다'}
      >
        {blocks.map((item) => (
          <div key={item.id} className={s.heroPanel}>
            <span className="t-label-md">{item.message}</span>
            {item.fix && <span className="t-body-sm c-secondary">{item.fix}</span>}
          </div>
        ))}
        {blocks.length === 0 &&
          review.map((row) => (
            <div key={row.path} className={s.reviewRow}>
              <span className="t-label-md">{row.name}</span>
              <span className={`${s.rowValue} t-code-md`}>{row.value}</span>
            </div>
          ))}
      </Hero>
      <Stack area="side">
        <FoldTile title="읽은 값" summary={view ? `${rows.length}칸` : '읽는 중'}>
          {view ? (
            <ul className={s.rows}>
              {rows.map((row) => (
                <li key={row.path} className={s.row}>
                  <span className={`t-label-md ${row.review ? 'c-warning' : ''}`}>{row.name}</span>
                  <span className={`${s.rowValue} t-code-sm c-secondary`}>{row.value}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className={`${s.note} t-body-sm c-secondary`}>{spec.loading ? '명세를 읽고 있습니다.' : '아직 명세가 없습니다.'}</p>
          )}
        </FoldTile>
        <ActionRow notice={error}>
          <ConfirmPill label="취소" confirmLabel="이전 취소" icon="x" disabled={busy} onConfirm={() => void run(() => api.cancel(migration.id))} />
          <ActionPill label={busy ? '보내는 중' : '명세 확정'} icon="check" disabled={busy || !view} onClick={() => void run(() => api.confirmSpec(migration.id))} />
        </ActionRow>
      </Stack>
    </Frame>
  );
}

function PreparingScreen({ migration, route }: ScreenProps) {
  const checking = migration.status === 'prechecking';
  return (
    <Frame migration={migration} hasSide={false} route={route}>
      <Hero
        tone="run"
        meta={LABEL[migration.status]}
        title={checking ? '이 앱을 옮길 수\n있는지 봅니다' : '계획서를\n만들고 있습니다'}
        foot="끝나면 계획서와 승인 버튼이 나옵니다"
      />
    </Frame>
  );
}

function ApproveScreen({ migration, route, onChanged }: ScreenProps) {
  const plan = usePoll(() => api.latestPlan(migration.id), null, [migration.id, migration.version]);
  const cost = usePoll(() => or404(api.migrationCost(migration.id)), null, [migration.id]);
  const resources = usePoll(() => or404(api.planResources(migration.id)), null, [migration.id]);
  const { busy, error, run } = useAction(() => {
    onChanged();
    void plan.reload();
  });
  const doc = plan.data;
  const pair = cost.data?.pair;
  const warns = doc?.precheck.filter((item) => item.level !== 'info').length ?? 0;
  const expired = doc ? Date.parse(doc.expiresAt) <= Date.now() : false;

  return (
    <Frame migration={migration} route={route}>
      <Hero
        tone={expired ? 'stop' : 'run'}
        meta="계획서"
        title={expired ? '승인 시간이\n지났습니다' : '승인하면\n이대로만 실행합니다'}
        foot={doc ? `유효 시각 ${new Date(doc.expiresAt).toLocaleString('ko-KR', { hour12: false })}` : undefined}
      >
        {doc && <code className={`${s.code} t-code-md`}>{doc.planHash.slice(0, 32)}</code>}
        {doc && (
          <p className="t-body-md c-secondary">
            오류율이 {doc.rollbackCriteria.errorRatePct}%를 넘거나 응답 시간이 {doc.rollbackCriteria.p95Multiplier}배를 넘으면 자동으로 되돌립니다
          </p>
        )}
      </Hero>
      <Stack area="side">
        <FoldTile title="월 비용" summary={cost.data?.origin === 'stored' ? '추정' : '미리보기'}>
          <div className={s.costLine}>
            <span className="t-metric-lg">{usd(pair?.sourceMonthlyUsd)}</span>
            <Icon name="arrow-right" />
            <span className="t-metric-lg">{usd(pair?.targetMonthlyUsd)}</span>
          </div>
          <p className={`${s.note} t-body-sm c-secondary`}>공개 가격표로 낸 추정입니다. 청구서가 아닙니다.</p>
          <div className={s.note}>
            <BarPill label="비용 자세히" icon="chevron" onClick={() => go(`migrations/${migration.id}/cost`)} />
          </div>
        </FoldTile>
        <FoldTile title="실행 단계" summary={doc ? `${doc.steps.length}단계` : '읽는 중'}>
          <ul className={s.rows}>
            {doc?.steps.map((step) => (
              <li key={step.id} className={s.row}>
                <span className="t-label-md">{stepName(step.id)}</span>
                <span className={`${s.rowValue} t-caption c-tertiary`}>{stepGate(step)}</span>
              </li>
            ))}
          </ul>
        </FoldTile>
        <FoldTile key={`precheck-${warns > 0}`} title="사전 점검" summary={warns > 0 ? `확인 ${warns}건` : `${doc?.precheck.length ?? 0}건`} defaultOpen={warns > 0}>
          <ul className={s.rows}>
            {doc?.precheck.map((item) => (
              <li key={item.id} className={s.row}>
                <span className="t-body-sm">{item.message}</span>
                <Badge tone={LEVEL[item.level].tone}>{LEVEL[item.level].label}</Badge>
              </li>
            ))}
          </ul>
        </FoldTile>
        <FoldTile title="자원 대응" summary={resources.data ? `${resources.data.rows.length}개` : ''} defaultOpen={false}>
          <ul className={s.rows}>
            {resources.data?.rows.filter((row) => row.method !== 'out_of_scope').map((row) => (
              <li key={row.category} className={s.row}>
                <span className="t-label-md">{row.label}</span>
                <span className={`${s.rowValue} t-caption c-tertiary`}>
                  {row.source?.service ?? '없음'} → {row.target?.service ?? '없음'}
                </span>
              </li>
            ))}
          </ul>
        </FoldTile>
        <ActionRow notice={error ?? (plan.error != null && !doc ? errorText(plan.error) : null)}>
          <ConfirmPill label="취소" confirmLabel="이전 취소" icon="x" disabled={busy} onConfirm={() => void run(() => api.cancel(migration.id))} />
          {doc && <ConfirmPill label="거절" confirmLabel="계획 거절" icon="ban" disabled={busy} onConfirm={() => void run(() => api.decide(doc.planId, 'reject', doc.planHash))} />}
          <ActionPill
            label={busy ? '보내는 중' : '이 계획 승인'}
            icon="check"
            disabled={busy || !doc || expired}
            onClick={() => doc && void run(() => api.decide(doc.planId, 'approve', doc.planHash))}
          />
        </ActionRow>
      </Stack>
    </Frame>
  );
}

function ApprovedScreen({ migration, route, onChanged }: ScreenProps) {
  const plan = usePoll(() => or404(api.latestPlan(migration.id)), null, [migration.id]);
  const { busy, error, run } = useAction(onChanged);
  const busyEnv = error?.includes('다른 이전') ?? false;
  return (
    <Frame migration={migration} route={route}>
      <Hero
        tone={busyEnv ? 'stop' : 'run'}
        meta={busyEnv ? '환경 사용 중' : '승인됨'}
        title={busyEnv ? '다른 이전이\n환경을 쓰고 있습니다' : '승인했습니다.\n버튼 하나만 남았습니다'}
        foot="이 지문의 계획만 실행합니다"
      >
        {plan.data && <code className={`${s.code} t-code-md`}>{plan.data.planHash.slice(0, 32)}</code>}
      </Hero>
      <Stack area="side">
        <ActionRow notice={busyEnv ? null : error}>
          <ConfirmPill label="취소" confirmLabel="이전 취소" icon="x" disabled={busy} onConfirm={() => void run(() => api.cancel(migration.id))} />
          <ActionPill label={busy ? '보내는 중' : '실행 시작'} icon="play" disabled={busy} onClick={() => void run(() => api.start(migration.id))} />
        </ActionRow>
      </Stack>
    </Frame>
  );
}

const STOPPED: Record<'rejected' | 'stale', { meta: string; title: string; foot: string }> = {
  rejected: { meta: '거절', title: '고객 환경에는\n아무것도 안 바꿨습니다', foot: '거절한 사람을 감사 기록에 남겼습니다' },
  stale: { meta: '낡은 계획', title: '승인 시간이\n지났습니다', foot: '본 것과 다른 내용이 실행되지 않도록 막았습니다' },
};

function StoppedScreen({ migration, route, onChanged, kind }: ScreenProps & { kind: 'rejected' | 'stale' }) {
  const { busy, error, run } = useAction(onChanged);
  const copy = STOPPED[kind];
  return (
    <Frame migration={migration} route={route}>
      <Hero tone="stop" meta={copy.meta} title={copy.title} foot={copy.foot} />
      <Stack area="side">
        <FoldTile title="다음에 할 일">
          <p className={`${s.note} t-body-md c-secondary`}>이 이전을 끝내고 새로 시작해 주세요.</p>
        </FoldTile>
        <ActionRow notice={error}>
          <ActionPill label={busy ? '보내는 중' : '이 이전 끝내기'} icon="x" disabled={busy} onClick={() => void run(() => api.cancel(migration.id))} />
        </ActionRow>
      </Stack>
    </Frame>
  );
}

function FailedScreen({ migration, route, onChanged }: ScreenProps) {
  const { busy, error, run } = useAction(onChanged);
  const [cleaned, setCleaned] = useState(false);
  return (
    <Frame migration={migration} route={route}>
      <Hero
        tone="stop"
        meta={migration.failedAtStatus ? `${LABEL[migration.failedAtStatus]}에서 실패` : '실패'}
        title={'작업이\n끝나지 못했습니다'}
      >
        {migration.failureCode && <code className={`${s.code} t-code-md`}>{migration.failureCode}</code>}
      </Hero>
      <Stack area="side">
        <FoldTile title="끝내기 전에">
          <p className={`${s.note} t-body-sm c-secondary`}>만들다 남은 자원이 있을 수 있습니다. 직접 정리한 뒤 끝내 주세요.</p>
          <label className={`${s.check} t-body-md`}>
            <input type="checkbox" checked={cleaned} onChange={(event) => setCleaned(event.target.checked)} />
            남은 자원을 정리했습니다
          </label>
        </FoldTile>
        <ActionRow notice={error}>
          <ActionPill label={busy ? '보내는 중' : '이 이전 끝내기'} icon="x" disabled={busy || !cleaned} onClick={() => void run(() => api.cancel(migration.id, true))} />
        </ActionRow>
      </Stack>
    </Frame>
  );
}

function CancelledScreen({ migration, route }: ScreenProps) {
  return (
    <Frame migration={migration} hasSide={false} route={route}>
      <Hero tone="run" meta="취소" title={'이 이전은\n여기서 끝났습니다'} foot="환경 잠금을 풀었습니다" />
    </Frame>
  );
}

const SCREENS: Record<Exclude<MigrationScreen, 'rejected' | 'stale'>, (props: ScreenProps) => ReactNode> = {
  importing: ImportingScreen,
  spec: SpecScreen,
  preparing: PreparingScreen,
  approve: ApproveScreen,
  approved: ApprovedScreen,
  failed: FailedScreen,
  cancelled: CancelledScreen,
  running: RunningScreen,
  window: WindowScreen,
  paused: PausedScreen,
  rollingBack: RollingBackScreen,
  rolledBack: RolledBackScreen,
  cleanup: CleanupScreen,
  done: DoneScreen,
};

export function MigrationPage({ id }: { id: string }) {
  const [status, setStatus] = useState<MigrationView['status'] | undefined>();
  const poll = usePoll(() => api.getMigration(id), pollMs(status), [id], { keepOnError: false });
  const envs = usePoll(api.listEnvironments, null, []);

  // 화면이 바뀔 때만 카드를 움직인다. 같은 화면 안의 갱신은 그대로 둔다.
  const [shown, setShown] = useState<MigrationView | null>(null);
  const shownScreen = useRef<MigrationScreen | null>(null);
  useEffect(() => {
    const next = poll.data;
    if (!next) return;
    setStatus(next.status);
    const screen = screenOf(next.status);
    const moved = shownScreen.current !== null && shownScreen.current !== screen;
    shownScreen.current = screen;
    if (moved) withTransition(() => setShown(next));
    else setShown(next);
  }, [poll.data]);

  if (!shown) {
    const missing = is404(poll.error);
    return (
      <Frame route="이전">
        <Hero
          tone={poll.error ? 'stop' : 'run'}
          meta="이전"
          title={poll.error ? (missing ? '이 이전을\n찾을 수 없습니다' : '이전을\n읽지 못했습니다') : '이전을\n읽고 있습니다'}
        />
      </Frame>
    );
  }

  const name = (envId: string) => envs.data?.find((env) => env.id === envId)?.name ?? envId.slice(0, 8);
  const props: ScreenProps = {
    migration: shown,
    route: `${name(shown.sourceEnvId)} → ${name(shown.targetEnvId)}`,
    onChanged: () => void poll.reload(),
  };
  const screen = screenOf(shown.status);
  if (screen === 'rejected' || screen === 'stale') return <StoppedScreen {...props} kind={screen} />;
  const Screen = SCREENS[screen];
  return <Screen {...props} />;
}
