import type { BentoLayout } from '../../../components/layout/ConsoleLayout';
import { Hero, StatTile, Tile, TileHeader } from '../../../components/layout/tiles';
import { Checklist } from '../../../components/ui/Checklist';
import { ActionPill, Badge, BarPill, LiveIndicator } from '../../../components/ui/controls';
import { Icon } from '../../../components/ui/Icon';
import { Timeline } from '../../../components/ui/Timeline';
import { TrafficBar } from '../../../components/ui/TrafficBar';
import { formatClock, migrationSteps, rollbackAvailability, type MigrationState } from '../flow';
import { AGENT_TIMELINE, CLEANUP_STEPS, MERGE_ENTRY, ROLLBACK_CAUSE, ROLLBACK_STEPS } from '../mock';
import { ChecklistTile, routeLabel, ScreenLayout, SecurityTile, type ScreenProps } from './shared';
import s from './screens.module.css';

const RUNNING: BentoLayout = {
  columns: '310fr 310fr 376fr 336fr',
  rows: '440fr 200fr',
  areas: ['hero hero steps security', 'failed latency steps security'],
};

const runningTitle = ({ stage, traffic, target, observeSeconds }: MigrationState) => {
  switch (stage) {
    case 'provisioning':
      return `${target}에\n자원을 만들고 있습니다`;
    case 'deploying':
      return `${target}에\n앱을 배포하고 있습니다`;
    case 'syncing':
      return 'DB를 복제하며\n따라잡고 있습니다';
    case 'observing':
      return `컷오버 전 관찰 중\n남은 ${observeSeconds}초`;
    case 'cutover':
      return 'DB 쓰기 담당을\n넘기고 있습니다';
    default:
      return traffic === 0 ? '복제를 마치고\n전환을 준비합니다' : `트래픽의 ${traffic}%가\n${target}로 갔습니다`;
  }
};

export function RunningScreen({ flow }: ScreenProps) {
  const { state } = flow;
  const { source, target, traffic, metricsAvailable } = state;
  const rollback = rollbackAvailability(state);
  return (
    <ScreenLayout
      flow={flow}
      layout={RUNNING}
      barLeft={<BarPill label={routeLabel(flow)} />}
      barRight={<LiveIndicator />}
      headline="새 앱으로 옮기는 중"
      sub={rollback.why ?? '문제가 보이면 언제든 되돌릴 수 있습니다.'}
      actions={<ActionPill label="롤백" icon="rollback" tone="danger" disabled={!rollback.allowed} onClick={() => flow.rollback()} />}
    >
      <Hero
        tone="run"
        meta="이전 진행"
        step="07"
        title={runningTitle(state)}
        foot="오류율이 1%를 넘거나 응답 시간이 2배를 넘으면 자동으로 되돌립니다"
      >
        <TrafficBar source={source} target={target} targetPercent={traffic} surface="hero" />
      </Hero>
      <ChecklistTile title="진행 단계" items={migrationSteps('running', state)} />
      <StatTile area="failed" icon="check" value={metricsAvailable ? '0' : '없음'} unit={metricsAvailable ? '건' : undefined} label={metricsAvailable ? '실패 요청' : '숫자 없음: 지표가 아직 안 옴'} compact />
      <StatTile area="latency" icon="migrate" value={metricsAvailable ? '1.2' : '없음'} unit={metricsAvailable ? '배' : undefined} label={metricsAvailable ? '응답 시간 p95, 출발 대비' : '숫자 없음: 표본 부족'} compact />
      <SecurityTile flow={flow} title="도착지 보안" />
    </ScreenLayout>
  );
}

const PAUSED: BentoLayout = {
  columns: '880fr 492fr',
  rows: '470fr 170fr',
  areas: ['hero steps', 'hero traffic'],
};

export function PausedScreen({ flow }: ScreenProps) {
  const { source, target, traffic } = flow.state;
  return (
    <ScreenLayout
      flow={flow}
      layout={PAUSED}
      barLeft={<BarPill label={routeLabel(flow)} />}
      barRight={
        <>
          <LiveIndicator />
          <BarPill label="가드레일" icon="shield" onClick={() => flow.go('guardrails')} />
        </>
      }
      headline="이전을 멈췄습니다"
      sub="에이전트는 원인을 찾아 수정안까지 제안합니다. 적용은 사람이 합니다."
      actions={
        <>
          <BarPill label="롤백" icon="rollback" tone="danger" onClick={() => flow.rollback()} />
          <ActionPill label="에이전트 수정안 받기" icon="bot" onClick={() => flow.go('fix', { merge: 'open' })} />
        </>
      }
    >
      <Hero
        tone="stop"
        meta="가드레일이 막았습니다"
        step="!"
        title={'DB 포트가\n전체에 열립니다'}
        foot="이 상태로는 더 옮기지 않습니다. 지금 트래픽 비율은 그대로 유지합니다"
      >
        <code className={`${s.causeCode} t-code-md`}>tcp/5432 → 0.0.0.0/0</code>
      </Hero>
      <ChecklistTile title="진행 단계" items={migrationSteps('paused', flow.state)} />
      <Tile area="traffic" compact spread>
        <TileHeader title="지금 트래픽" />
        <TrafficBar source={source} target={target} targetPercent={traffic} />
        <p className="t-body-md c-secondary">실패 요청 0건, 사용자 영향 없음</p>
      </Tile>
    </ScreenLayout>
  );
}

const FIX: BentoLayout = {
  columns: '470fr 500fr 382fr',
  rows: '1fr 1fr',
  areas: ['hero timeline checked', 'hero timeline unchecked'],
};

const CHECKED = ['5432 포트가 내부망에만 열림', '앱에서 DB 연결 테스트 통과', '보안 표 재검사 통과'];
const UNCHECKED = ['운영 부하에서의 연결 수', '클라우드 방화벽 규칙 (에이전트 권한 밖)', '샌드박스 밖 네트워크 경로'];

function Bullets({ icon, items }: { icon: 'check' | 'help'; items: string[] }) {
  return (
    <ul className={s.bullets}>
      {items.map((item) => (
        <li key={item} className={`${s.bullet} t-body-md`}>
          <Icon name={icon} />
          {item}
        </li>
      ))}
    </ul>
  );
}

export function FixScreen({ flow }: ScreenProps) {
  const { merge } = flow.state;
  const merged = merge === 'merged';
  return (
    <ScreenLayout
      flow={flow}
      layout={FIX}
      barLeft={<BarPill label={routeLabel(flow)} />}
      barRight={<LiveIndicator />}
      headline={merged ? '합친 것을 확인했습니다' : '에이전트가 수정안을 제안했습니다'}
      sub={merged ? '이제 멈췄던 자리에서 이어 갑니다.' : '클라우드에서 연 방화벽은 사람이 되돌리고, 이 PR은 사람이 합칩니다.'}
      actions={
        <>
          <BarPill label="롤백" icon="rollback" tone="danger" onClick={() => flow.rollback()} />
          {merged ? (
            <ActionPill label="이전 재개" icon="play" onClick={flow.resumeMigration} />
          ) : (
            <ActionPill
              label={merge === 'detecting' ? '합침 확인 중' : 'GitHub에서 합치기'}
              icon="git-pr"
              disabled={merge === 'detecting'}
              onClick={flow.mergeFix}
            />
          )}
        </>
      }
    >
      <Hero
        tone={merged ? 'run' : 'stop'}
        meta={merged ? '수정 반영됨' : '에이전트 수정안 · PR #12'}
        step="!"
        title={merged ? '이어서\n옮길 수 있습니다' : '수정안:\n이 한 줄을 고칩니다'}
        foot="에이전트는 샌드박스에서만 실행했고, 운영 환경은 읽지 않았습니다"
      >
        <code className={`${s.diff} t-code-md`}>
          <span className={s.diffRemoved}>- cidr: 0.0.0.0/0</span>
          <span>+ cidr: 10.20.0.0/16</span>
        </code>
      </Hero>
      <Tile area="timeline" compact scroll>
        <TileHeader title="에이전트가 한 일" />
        <Timeline items={merged ? [...AGENT_TIMELINE, MERGE_ENTRY] : AGENT_TIMELINE} />
      </Tile>
      <Tile area="checked" compact spread>
        <TileHeader title="확인한 것" action={<Badge tone="success">{CHECKED.length}개</Badge>} />
        <Bullets icon="check" items={CHECKED} />
      </Tile>
      <Tile area="unchecked" compact spread>
        <TileHeader title="확인하지 못한 것" action={<Badge tone="warning">{UNCHECKED.length}개</Badge>} />
        <Bullets icon="help" items={UNCHECKED} />
      </Tile>
    </ScreenLayout>
  );
}

const WINDOW: BentoLayout = {
  columns: '462fr 462fr 428fr',
  rows: '430fr 210fr',
  areas: ['hero hero steps', 'failed latency steps'],
};

export function RollbackWindowScreen({ flow }: ScreenProps) {
  const { source, target, windowSeconds } = flow.state;
  const clock = formatClock(windowSeconds);
  const expired = windowSeconds === 0;
  return (
    <ScreenLayout
      flow={flow}
      layout={WINDOW}
      barLeft={<BarPill label={routeLabel(flow)} />}
      barRight={<LiveIndicator />}
      headline="이상이 있으면 되돌리세요"
      sub={`시간이 끝나면 자동으로 ${source}의 임시 자원을 지우고 빌린 권한을 돌려줍니다.`}
      actions={<ActionPill label="롤백" icon="rollback" tone="danger" disabled={expired} onClick={() => flow.rollback()} />}
    >
      <Hero
        tone="run"
        meta={`${target}가 트래픽을 모두 받고 있습니다`}
        step="08"
        title="되돌릴 수 있는 시간"
        foot={`이 시간이 끝나기 전에는 언제든 ${source}로 되돌릴 수 있습니다`}
      >
        <p className="t-metric-2xl" role="timer" aria-label={`남은 시간 ${clock}`}>
          {clock}
        </p>
      </Hero>
      <ChecklistTile title="진행 단계" items={migrationSteps('window', flow.state, '시간 끝나면')} />
      <StatTile area="failed" icon="check" value="0" unit="건" label="실패 요청" compact />
      <StatTile area="latency" icon="migrate" value="1.1" unit="배" label="응답 시간 p95, 출발 대비" compact />
    </ScreenLayout>
  );
}

const STEPS_ONLY: BentoLayout = {
  columns: '880fr 492fr',
  rows: '1fr',
  areas: ['hero steps'],
};

function progressItems(labels: string[], step: number) {
  return labels.map((label, index) => ({
    label,
    status: index < step ? ('done' as const) : index === step ? ('active' as const) : ('pending' as const),
  }));
}

export function CleanupScreen({ flow }: ScreenProps) {
  const { source, cleanupStep } = flow.state;
  return (
    <ScreenLayout
      flow={flow}
      layout={STEPS_ONLY}
      barLeft={<BarPill label={routeLabel(flow)} />}
      headline="임시로 만든 것을 지웁니다"
      sub="정리를 시작하면 되돌릴 수 없습니다."
      actions={<ActionPill label="자동으로 진행 중" icon="refresh" disabled />}
    >
      <Hero tone="done" meta="정리" step="09" title={`${source}의 임시 자원을\n지우고 있습니다`} foot="남은 줄이 0개여야 완료합니다" />
      <Tile area="steps" tone="inverse" compact>
        <h3 className="t-h3" style={{ marginBottom: 'var(--space-8)' }}>
          정리 단계
        </h3>
        <Checklist items={progressItems(CLEANUP_STEPS, cleanupStep)} />
      </Tile>
    </ScreenLayout>
  );
}

export function RollingBackScreen({ flow }: ScreenProps) {
  const { source, target, rollbackCause, rollbackStep, traffic } = flow.state;
  const cause = ROLLBACK_CAUSE[rollbackCause];
  return (
    <ScreenLayout
      flow={flow}
      layout={STEPS_ONLY}
      barLeft={<BarPill label={routeLabel(flow)} />}
      barRight={<LiveIndicator />}
      headline={`${source}로 되돌리는 중`}
      sub="쓰기는 계속 출발 DB로 갑니다. 도착 환경은 원인 조사를 위해 지우지 않습니다."
      actions={<ActionPill label="자동으로 진행 중" icon="refresh" disabled />}
    >
      <Hero tone="stop" meta={rollbackCause === 'manual' ? '수동 롤백' : '자동 롤백'} step="←" title={cause.title} foot={cause.detail}>
        <code className={`${s.causeCode} t-code-md`}>{cause.code}</code>
        <TrafficBar source={source} target={target} targetPercent={rollbackStep > 2 ? 0 : traffic} surface="hero" />
      </Hero>
      <Tile area="steps" tone="inverse" compact>
        <h3 className="t-h3" style={{ marginBottom: 'var(--space-8)' }}>
          롤백 다섯 단계
        </h3>
        <Checklist items={progressItems(ROLLBACK_STEPS, rollbackStep)} />
      </Tile>
    </ScreenLayout>
  );
}
