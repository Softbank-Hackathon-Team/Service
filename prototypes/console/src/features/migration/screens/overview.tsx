import { useState } from 'react';
import { ConsoleLayout, type BentoLayout } from '../../../components/layout/ConsoleLayout';
import { Hero, StatTile, Tile, TileHeader, TileLink } from '../../../components/layout/tiles';
import { ActionPill, Badge, BarPill, LiveIndicator } from '../../../components/ui/controls';
import { Icon } from '../../../components/ui/Icon';
import { Timeline } from '../../../components/ui/Timeline';
import {
  AGENT_LIMITS,
  AGENT_RUNS,
  AGENT_TIMELINE,
  APP_NAME,
  CONNECT_METHOD,
  ENV_APP,
  ENVS,
  MEMBERS,
  MIGRATION_LIST,
  STACK_BY_ENV,
  THREATS,
} from '../mock';
import { routeLabel, ScreenLayout, type ScreenProps } from './shared';
import s from './screens.module.css';

const LOGIN: BentoLayout = { columns: '1fr', rows: '1fr', areas: ['hero'] };

export function LoginScreen({ flow }: ScreenProps) {
  return (
    <ConsoleLayout
      layout={LOGIN}
      headline="GitHub로 로그인하세요"
      sub="비밀번호를 저장하지 않습니다. 회사 멤버면 그 회사 안의 일을 모두 할 수 있습니다."
      actions={<ActionPill label="GitHub로 계속" icon="github" onClick={() => flow.go('dashboard')} />}
    >
      <Hero
        tone="run"
        meta="Kross AI"
        step="→"
        title={'돌고 있는 앱을\n멈추지 않고 옮깁니다'}
        foot="누가 요청하고 누가 승인했는지 모두 기록합니다"
      />
    </ConsoleLayout>
  );
}

const DASHBOARD: BentoLayout = {
  columns: '520fr 480fr 372fr',
  rows: '1fr 1fr',
  areas: ['hero migrations envs', 'hero migrations threats'],
};

export function DashboardScreen({ flow }: ScreenProps) {
  const { connected, migrationScreen, acknowledged } = flow.state;
  const started = migrationScreen !== 'connect';
  const active = THREATS.filter((threat) => !acknowledged[threat.id]).length;
  return (
    <ScreenLayout
      flow={flow}
      layout={DASHBOARD}
      barRight={<LiveIndicator />}
      headline="무엇을 할까요?"
      sub="환경과 이전 현황, 사람 차례인 일을 모았습니다."
      actions={<ActionPill label="새 이전 시작" icon="plus" onClick={flow.newMigration} />}
    >
      <Hero tone="run" meta="사람 차례" step={`${started ? 2 : 1}`} title={'승인을 기다리는\n이전이 있습니다'} foot="사람이 누르는 것은 명세 확정, 승인, 실행 시작 세 번입니다">
        <div className={s.heroList}>
          <button type="button" className={s.heroRow} onClick={() => flow.jump('approve')}>
            <span className="t-h3">billing-api 계획 승인</span>
            <Icon name="chevron" />
          </button>
          {started && (
            <button type="button" className={s.heroRow} onClick={() => flow.openTab('migration')}>
              <span className="t-h3">{APP_NAME} 이어서 보기</span>
              <Icon name="chevron" />
            </button>
          )}
        </div>
      </Hero>
      <Tile area="migrations" compact scroll>
        <TileHeader title="이전 목록" />
        <ul className={s.plainList}>
          {started && (
            <li>
              <button type="button" className={s.listButton} onClick={() => flow.openTab('migration')}>
                <span className={s.stackedRow}>
                  <span className="t-label-md">{APP_NAME}</span>
                  <span className="t-caption c-tertiary">{routeLabel(flow).split(' · ')[1]}</span>
                </span>
                <Badge tone="info">진행 중</Badge>
              </button>
            </li>
          )}
          {MIGRATION_LIST.map((migration) => (
            <li key={migration.id} className={s.listStatic}>
              <span className={s.stackedRow}>
                <span className="t-label-md">{migration.app}</span>
                <span className="t-caption c-tertiary">{migration.route}</span>
                <span className={s.progressTrack} aria-hidden="true">
                  <span className={s.progressFill} style={{ width: `${migration.progress}%` }} />
                </span>
              </span>
              <Badge tone={migration.status === '완료' ? 'success' : 'warning'}>{migration.status}</Badge>
            </li>
          ))}
        </ul>
      </Tile>
      <Tile area="envs" compact spread>
        <TileHeader title="환경" action={<TileLink label="모두 보기" onClick={() => flow.go('environments')} />} />
        <ul className={s.plainList}>
          {ENVS.map((env) => (
            <li key={env} className={s.plainRow}>
              <span className="t-label-md">{env}</span>
              <Badge tone={connected[env] ? 'success' : 'neutral'}>{connected[env] ? '연결됨' : '연결 안 됨'}</Badge>
            </li>
          ))}
        </ul>
      </Tile>
      <StatTile area="threats" icon="alert" value={`${active}`} unit="건" label="확인하지 않은 위협" compact />
    </ScreenLayout>
  );
}

const ENVIRONMENTS: BentoLayout = {
  columns: 'repeat(4, 1fr)',
  rows: '1fr',
  areas: ['env0 env1 env2 env3'],
};

export function EnvironmentsScreen({ flow }: ScreenProps) {
  const { source, target, connected, connecting, traffic, migrationScreen } = flow.state;
  const started = migrationScreen !== 'connect';
  const trafficOf = (env: string) => {
    if (!started) return env === 'AWS' ? 100 : 0;
    if (env === source) return 100 - traffic;
    return env === target ? traffic : 0;
  };
  return (
    <ScreenLayout
      flow={flow}
      layout={ENVIRONMENTS}
      barRight={<LiveIndicator />}
      headline="환경을 한눈에 봅니다"
      sub="앱이 켜져 있는지, 버전, 트래픽 비율, 이전 상태를 자동으로 갱신합니다."
      actions={<ActionPill label="새 이전 시작" icon="plus" onClick={flow.newMigration} />}
    >
      {ENVS.map((env, index) => {
        const app = ENV_APP[env];
        const isConnected = connected[env];
        return (
          <Tile key={env} area={`env${index}`} compact spread>
            <TileHeader title={env} action={<Badge tone={isConnected ? 'success' : 'neutral'}>{isConnected ? '연결됨' : '연결 안 됨'}</Badge>} />
            <p className={s.summaryValue}>
              <span className="t-metric-xl">{trafficOf(env)}</span>
              <span className="t-h3 c-secondary">% 트래픽</span>
            </p>
            <ul className={s.plainList}>
              <li className={s.plainRow}>
                <span className="t-body-sm c-secondary">앱</span>
                <span className="t-label-md">{app.up ? '켜짐' : '꺼짐'}</span>
              </li>
              <li className={s.plainRow}>
                <span className="t-body-sm c-secondary">버전</span>
                <span className="t-code-sm">{app.version}</span>
              </li>
              <li className={s.plainRow}>
                <span className="t-body-sm c-secondary">이전</span>
                <span className="t-label-md">{started && (env === source || env === target) ? (env === source ? '출발' : '도착') : '없음'}</span>
              </li>
            </ul>
            <div className={s.stackedRow}>
              {STACK_BY_ENV[env].map(([name, value]) => (
                <span key={name} className="t-caption c-tertiary">
                  {name} {value}
                </span>
              ))}
            </div>
            {isConnected ? (
              <span className="t-caption c-tertiary">읽기·변경 권한 15분씩 빌림</span>
            ) : (
              <BarPill
                label={connecting === env ? '확인 중' : `연결 · ${CONNECT_METHOD[env].how}`}
                icon="plus"
                onClick={connecting === env ? undefined : () => flow.connect(env)}
              />
            )}
          </Tile>
        );
      })}
    </ScreenLayout>
  );
}

const SETTINGS: BentoLayout = {
  columns: '880fr 492fr',
  rows: '1fr',
  areas: ['members invite'],
};

export function SettingsScreen({ flow }: ScreenProps) {
  const [members, setMembers] = useState(MEMBERS);
  const [handle, setHandle] = useState('');
  const invite = () => {
    const value = handle.trim();
    if (!value) return;
    setMembers([...members, { name: '초대 중', handle: value }]);
    setHandle('');
  };
  return (
    <ScreenLayout flow={flow} layout={SETTINGS}>
      <Tile area="members" compact scroll>
        <TileHeader title="멤버" action={<Badge>역할 없음</Badge>} />
        <ul className={s.plainList}>
          {members.map((member) => (
            <li key={member.handle} className={s.threatRow}>
              <span className={s.stackedRow}>
                <span className="t-label-md">{member.name}</span>
                <span className="t-code-sm c-tertiary">{member.handle}</span>
              </span>
              <button
                type="button"
                className={`${s.closeButton} t-label-sm`}
                onClick={() => setMembers(members.filter((item) => item.handle !== member.handle))}
              >
                제거
              </button>
            </li>
          ))}
        </ul>
      </Tile>
      <Tile area="invite" compact spread>
        <TileHeader title="멤버 초대" />
        <p className="t-body-md c-secondary">회사 멤버면 승인까지 모두 할 수 있습니다. 제거하면 즉시 접속이 끊깁니다.</p>
        <input
          className={s.textInput}
          value={handle}
          placeholder="GitHub 아이디"
          aria-label="GitHub 아이디"
          onChange={(event) => setHandle(event.target.value)}
        />
        <BarPill label="초대" icon="plus" onClick={invite} />
      </Tile>
    </ScreenLayout>
  );
}

const AGENT: BentoLayout = {
  columns: '520fr 480fr 372fr',
  rows: '1fr 1fr',
  areas: ['hero timeline runs', 'hero timeline limits'],
};

export function AgentScreen({ flow }: ScreenProps) {
  const { agentRun } = flow.state;
  const running = agentRun === 'running';
  return (
    <ScreenLayout
      flow={flow}
      layout={AGENT}
      barLeft={<BarPill label={routeLabel(flow)} />}
      headline="AI 점검을 돌립니다"
      sub="샌드박스 안에서만 움직입니다. 수정안은 검사를 통과해야 PR이 되고, 합치는 것은 사람이 합니다."
      actions={
        <ActionPill
          label={running ? '점검 중' : agentRun === 'done' ? '다시 점검' : 'AI 점검 실행'}
          icon="bot"
          disabled={running}
          onClick={() => flow.patch({ agentRun: 'running' })}
        />
      }
    >
      <Hero tone="run" meta="AI 에이전트" step="AI" title={'격리된 곳에서\n점검하고 제안합니다'} foot="제안, 바꿀 것 없음, 포기 셋 중 하나로 끝납니다">
        <label className={s.fieldText}>
          <span className="t-body-sm">무엇을 볼까요? (선택, 2000자까지)</span>
          <textarea className={s.textarea} rows={3} maxLength={2000} placeholder="예: 메모리 부족으로 재시작이 반복됩니다" />
        </label>
      </Hero>
      <Tile area="timeline" compact scroll>
        <TileHeader title="에이전트가 한 일" action={running ? <Badge tone="info">실행 중</Badge> : undefined} />
        <Timeline items={AGENT_TIMELINE} />
      </Tile>
      <Tile area="runs" compact scroll>
        <TileHeader title="최근 실행" />
        <ul className={s.plainList}>
          {AGENT_RUNS.map((run) => (
            <li key={run.kind} className={s.stackedRow}>
              <span className={s.plainRow}>
                <span className="t-label-md">{run.kind}</span>
                <Badge tone={run.status === '제안' ? 'info' : 'success'}>{run.status}</Badge>
              </span>
              <span className="t-body-sm c-secondary">{run.detail}</span>
            </li>
          ))}
        </ul>
      </Tile>
      <Tile area="limits" compact spread>
        <TileHeader title="한도" />
        <ul className={s.plainList}>
          {AGENT_LIMITS.map(([name, value]) => (
            <li key={name} className={s.plainRow}>
              <span className="t-body-sm c-secondary">{name}</span>
              <span className="t-label-md">{value}</span>
            </li>
          ))}
        </ul>
      </Tile>
    </ScreenLayout>
  );
}
