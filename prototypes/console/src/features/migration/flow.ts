import type { ChecklistEntry } from '../../components/ui/Checklist';
import { INITIAL_CONNECTED, REPLICA_OPTIONS, RESOURCE_OPTIONS, type EnvId, type SecurityPhase } from './mock';

export const SCREEN_GROUPS = [
  {
    title: '시작',
    screens: [
      { id: 'login', label: '로그인' },
      { id: 'dashboard', label: '대시보드' },
      { id: 'environments', label: '환경' },
      { id: 'settings', label: '설정·멤버' },
    ],
  },
  {
    title: '준비',
    screens: [
      { id: 'connect', label: '출발 연결' },
      { id: 'connectFailed', label: '연결 실패' },
      { id: 'read', label: '읽기·도착 고르기' },
      { id: 'spec', label: '명세 확정' },
      { id: 'precheck', label: '사전 점검' },
      { id: 'blocked', label: '점검 막힘' },
    ],
  },
  {
    title: '승인',
    screens: [
      { id: 'approve', label: '계획 승인' },
      { id: 'cost', label: '비용 자세히' },
      { id: 'rejected', label: '거절' },
      { id: 'stale', label: '계획 낡음' },
      { id: 'approved', label: '실행 시작' },
      { id: 'envBusy', label: '환경 사용 중' },
    ],
  },
  {
    title: '실행',
    screens: [
      { id: 'running', label: '이전 중' },
      { id: 'noMetrics', label: '지표 없음' },
      { id: 'paused', label: '가드레일 멈춤' },
      { id: 'fix', label: '수정안' },
      { id: 'window', label: '롤백 대기' },
      { id: 'cleanup', label: '정리' },
      { id: 'done', label: '완료' },
    ],
  },
  {
    title: '문제',
    screens: [
      { id: 'rollingBack', label: '수동 롤백' },
      { id: 'autoRollback', label: '자동 롤백' },
      { id: 'rolledBack', label: '롤백 끝' },
      { id: 'failed', label: '실패' },
      { id: 'cancelled', label: '취소' },
    ],
  },
  {
    title: '살펴보기',
    screens: [
      { id: 'security', label: '보안 표' },
      { id: 'threats', label: '위협' },
      { id: 'guardrails', label: '가드레일' },
      { id: 'log', label: '감사 기록' },
      { id: 'agent', label: '에이전트' },
    ],
  },
  {
    title: '디자인',
    screens: [{ id: 'designSystem', label: '디자인 시스템' }],
  },
] as const;

export type ScreenId = (typeof SCREEN_GROUPS)[number]['screens'][number]['id'];

export const SCREEN_IDS = SCREEN_GROUPS.flatMap((group) => group.screens.map((screen) => screen.id as ScreenId));

export type NavTab = 'dashboard' | 'environments' | 'migration' | 'security' | 'log' | 'agent';

const NAV_OF: Partial<Record<ScreenId, NavTab>> = {
  dashboard: 'dashboard',
  environments: 'environments',
  security: 'security',
  threats: 'security',
  guardrails: 'security',
  log: 'log',
  agent: 'agent',
};

const OUTSIDE_MIGRATION: ScreenId[] = [
  'login',
  'dashboard',
  'environments',
  'settings',
  'security',
  'threats',
  'guardrails',
  'log',
  'agent',
  'designSystem',
];

export const navOf = (screen: ScreenId): NavTab | null =>
  screen === 'settings' || screen === 'login' || screen === 'designSystem' ? null : (NAV_OF[screen] ?? 'migration');

export const isMigrationScreen = (screen: ScreenId) => !OUTSIDE_MIGRATION.includes(screen);

export type TrafficPercent = 0 | 10 | 50 | 100;

export type Stage = 'provisioning' | 'deploying' | 'syncing' | 'shifting' | 'observing' | 'cutover';

export type RollbackCause = 'manual' | 'error' | 'latency';

export type MigrationState = {
  source: EnvId;
  target: EnvId;
  connected: Record<EnvId, boolean>;
  connecting: EnvId | null;
  replicas: { value: string; confirmed: boolean };
  resources: { value: string; confirmed: boolean };
  migrationScreen: ScreenId;
  precheckStep: number;
  stage: Stage;
  traffic: TrafficPercent;
  observeSeconds: number;
  metricsAvailable: boolean;
  envBusy: boolean;
  guardrailCleared: boolean;
  merge: 'open' | 'detecting' | 'merged';
  windowSeconds: number;
  rollbackCause: RollbackCause;
  rollbackStep: number;
  cleanupStep: number;
  cleanupConfirmed: boolean;
  attested: Record<string, boolean>;
  acknowledged: Record<string, boolean>;
  agentRun: 'idle' | 'running' | 'done';
  growth: 1 | 3;
  profile: 'basic' | 'strict';
  autoplay: boolean;
};

// DRAFT(ai): 프로토타입은 15분을 보여 주고, 리소스 회수 버튼으로 바로 끝낼 수 있다. 코드 기본값(3초, 데모 20초), 요구사항(5분)과 다르다.
export const ROLLBACK_WINDOW_SECONDS = 15 * 60;
export const OBSERVE_SECONDS = 30;

export const initialState: MigrationState = {
  source: 'AWS',
  target: 'GCP',
  connected: INITIAL_CONNECTED,
  connecting: null,
  replicas: { value: REPLICA_OPTIONS[0], confirmed: false },
  resources: { value: RESOURCE_OPTIONS[0], confirmed: false },
  migrationScreen: 'connect',
  precheckStep: 0,
  stage: 'shifting',
  traffic: 50,
  observeSeconds: OBSERVE_SECONDS,
  metricsAvailable: true,
  envBusy: false,
  guardrailCleared: true,
  merge: 'open',
  windowSeconds: ROLLBACK_WINDOW_SECONDS,
  rollbackCause: 'manual',
  rollbackStep: 0,
  cleanupStep: 0,
  cleanupConfirmed: false,
  attested: {},
  acknowledged: {},
  agentRun: 'idle',
  growth: 1,
  profile: 'basic',
  autoplay: false,
};

const CONFIRMED = {
  replicas: { value: REPLICA_OPTIONS[0], confirmed: true },
  resources: { value: RESOURCE_OPTIONS[0], confirmed: true },
};

/** 프로토타입 메뉴나 주소로 바로 들어왔을 때 그 화면이 말이 되도록 값을 맞춘다. */
export function presetFor(screen: ScreenId): Partial<MigrationState> {
  switch (screen) {
    case 'precheck':
      return { ...CONFIRMED, precheckStep: 4 };
    case 'approve':
    case 'cost':
    case 'rejected':
    case 'stale':
    case 'approved':
      return { ...CONFIRMED, envBusy: false };
    case 'envBusy':
      return { ...CONFIRMED, envBusy: true };
    case 'running':
      return { stage: 'shifting', traffic: 50, guardrailCleared: true, metricsAvailable: true };
    case 'noMetrics':
      return { stage: 'shifting', traffic: 50, guardrailCleared: true, metricsAvailable: false };
    case 'paused':
      return { stage: 'shifting', traffic: 10, guardrailCleared: false };
    case 'fix':
      return { stage: 'shifting', traffic: 10, guardrailCleared: false, merge: 'open' };
    case 'window':
      return { traffic: 100, guardrailCleared: true, windowSeconds: ROLLBACK_WINDOW_SECONDS };
    case 'cleanup':
      return { traffic: 100, guardrailCleared: true, cleanupStep: 1 };
    case 'done':
      return { traffic: 100, guardrailCleared: true };
    case 'rollingBack':
      return { rollbackCause: 'manual', rollbackStep: 2, traffic: 50 };
    case 'autoRollback':
      return { rollbackCause: 'error', rollbackStep: 2, traffic: 50 };
    case 'rolledBack':
      return { traffic: 0 };
    case 'failed':
      return { cleanupConfirmed: false };
    default:
      return {};
  }
}

const PLANNED_SCREENS: ScreenId[] = ['approve', 'cost', 'rejected', 'stale', 'approved', 'envBusy', 'rolledBack', 'failed', 'cancelled'];
const UNPLANNED_SCREENS: ScreenId[] = ['connect', 'connectFailed', 'read', 'spec', 'precheck', 'blocked'];

export function securityPhase(state: MigrationState): SecurityPhase {
  const screen = state.migrationScreen;
  if (UNPLANNED_SCREENS.includes(screen)) return 'none';
  if (PLANNED_SCREENS.includes(screen)) return 'planned';
  if (state.guardrailCleared || state.merge === 'merged') return 'verified';
  return state.traffic > 0 ? 'blocked' : 'planned';
}

/** 지금 롤백을 누를 수 있나. 못 누르면 이유를 함께 준다. 코드의 emergency.ts와 같은 규칙이다. */
export function rollbackAvailability(state: MigrationState): { allowed: boolean; why?: string } {
  if (state.stage === 'provisioning') return { allowed: false, why: '자원을 만드는 중에는 되돌릴 수 없습니다. 앱 배포가 시작되면 누르세요.' };
  if (state.stage === 'cutover') return { allowed: false, why: 'DB 전환 중에는 누를 수 없습니다. 끝나면 롤백 대기로 넘어갑니다.' };
  return { allowed: true };
}

type StepPhase = 'running' | 'paused' | 'window' | 'cleanup' | 'done';

const STAGE_ORDER: Stage[] = ['provisioning', 'deploying', 'syncing', 'shifting', 'observing', 'cutover'];

export function migrationSteps(phase: StepPhase, state: Pick<MigrationState, 'stage' | 'traffic'>, windowLabel?: string): ChecklistEntry[] {
  const { traffic } = state;
  const finished = phase !== 'running' && phase !== 'paused';
  const reached = finished ? STAGE_ORDER.length : STAGE_ORDER.indexOf(state.stage);
  const stepStatus = (index: number) => (finished || reached > index ? 'done' : reached === index ? 'active' : 'pending');

  const shifting = reached === 3 || reached === 4;
  const switching: ChecklistEntry =
    phase === 'paused'
      ? { status: 'paused', label: '트래픽 이동', detail: `${traffic}%에서 멈춤` }
      : finished || reached > 4
        ? { status: 'done', label: '트래픽 이동', detail: '100%' }
        : shifting
          ? { status: 'active', label: '트래픽 이동', detail: `${traffic}%` }
          : { status: 'pending', label: '트래픽 이동' };

  return [
    { status: 'done', label: '가져오기', detail: '12:01' },
    { status: 'done', label: '명세 확정', detail: '사람' },
    { status: 'done', label: '사전 점검', detail: '20개' },
    { status: 'done', label: '계획 승인', detail: '사람' },
    { status: stepStatus(0), label: '자원 만들기' },
    { status: stepStatus(1), label: '앱 배포' },
    { status: stepStatus(2), label: 'DB 복제', detail: reached >= 2 ? '지연 0.4초' : undefined },
    switching,
    { status: finished ? 'done' : stepStatus(5), label: 'DB 전환', detail: finished ? '쓰기 멈춤 3.2초' : undefined },
    phase === 'done'
      ? { status: 'done', label: '정리', detail: '임시 자원 0개' }
      : { status: phase === 'cleanup' ? 'active' : 'pending', label: '정리', detail: windowLabel },
  ];
}

export function formatClock(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}
