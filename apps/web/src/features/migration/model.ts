import type { TrafficShiftProgress } from '../../lib/liveTraffic';
import { HUMAN_STEP, isTerminal, LABEL } from '../../lib/status';
import { VALID, type EnvironmentView, type MigrationStatus, type MigrationView, type PlanStep, type TimelineItem } from '../../lib/types';
import type { ChecklistEntry } from '../../components/ui/Checklist';

export type MigrationSpec = {
  app?: { name?: string };
  service?: {
    image?: string;
    port?: number;
    healthPath?: string;
    replicas?: number;
    cpu?: string;
    memory?: string;
    secretRefs?: unknown[];
  };
  database?: { engine?: string; majorVersion?: string; storageGb?: number };
  ingress?: { hostname?: string };
};

export type MigrationSpecView = {
  migrationId: string;
  version: number;
  createdAt: string;
  source: 'accepted' | 'ai_draft';
  complete: boolean;
  spec: MigrationSpec;
  needsReview: string[];
};

export type MigrationScreen =
  | 'importing'
  | 'spec'
  | 'preparing'
  | 'approve'
  | 'approved'
  | 'rejected'
  | 'stale'
  | 'failed'
  | 'cancelled'
  | 'running'
  | 'window'
  | 'paused'
  | 'rollingBack'
  | 'rolledBack'
  | 'cleanup'
  | 'done';

const SCREEN_OF: Partial<Record<MigrationStatus, MigrationScreen>> = {
  draft: 'importing',
  importing: 'importing',
  spec_review: 'spec',
  prechecking: 'preparing',
  planning: 'preparing',
  awaiting_approval: 'approve',
  approved: 'approved',
  rejected: 'rejected',
  stale: 'stale',
  failed: 'failed',
  cancelled: 'cancelled',
  rollback_window: 'window',
  paused: 'paused',
  rolling_back: 'rollingBack',
  rolled_back: 'rolledBack',
  cleanup: 'cleanup',
  completed: 'done',
};

/** 서버 상태 22개를 화면으로 묶는다. 나머지 다섯 칸(자원 생성~컷오버)은 실행 화면이다. */
export const screenOf = (status: MigrationStatus): MigrationScreen => SCREEN_OF[status] ?? 'running';

const POLL = { worker: 700, human: 1500 };

export function pollMs(status: MigrationStatus | undefined): number | null {
  if (!status) return POLL.human;
  if (isTerminal(status)) return null;
  return HUMAN_STEP.includes(status) || status === 'rejected' || status === 'stale' || status === 'failed' || status === 'paused'
    ? POLL.human
    : POLL.worker;
}

const STEPS: { label: string; detail?: string; through: MigrationStatus[] }[] = [
  { label: '구성 읽기', through: ['draft', 'importing'] },
  { label: '명세 확정', detail: '사람', through: ['spec_review'] },
  { label: '사전 점검', through: ['prechecking'] },
  { label: '계획 만들기', through: ['planning'] },
  { label: '계획 승인', detail: '사람', through: ['awaiting_approval'] },
  { label: '실행 시작', detail: '사람', through: ['approved'] },
  { label: LABEL.provisioning, through: ['provisioning'] },
  { label: LABEL.deploying, through: ['deploying'] },
  { label: LABEL.syncing, through: ['syncing'] },
  { label: LABEL.shifting, through: ['shifting'] },
  { label: LABEL.cutover, through: ['cutover'] },
  { label: '롤백 대기', through: ['rollback_window'] },
  { label: LABEL.cleanup, through: ['cleanup'] },
];

/** 위치를 상태만으로 알 수 없는 이전. 타임라인에서 어느 칸에서 왔는지 찾는다. */
export const needsStepAnchor = ({ status, failedAtStatus }: Pick<MigrationView, 'status' | 'failedAtStatus'>) =>
  status === 'rolling_back' || status === 'rolled_back' || status === 'cancelled' || (status === 'failed' && !failedAtStatus);

/** 지금 상태로 들어오기 직전의 칸. 일시 정지를 거쳤으면 그 앞 칸을 본다. */
export function stepAnchorFrom(items: Pick<TimelineItem, 'kind' | 'from' | 'to'>[], status: MigrationStatus): MigrationStatus | null {
  const moves = items.filter((item) => item.kind === 'transition');
  let wanted: string = status;
  for (let index = moves.length - 1; index >= 0; index--) {
    const move = moves[index]!;
    if (move.to !== wanted) continue;
    if (move.from === 'paused' || move.from === 'rolling_back') wanted = move.from;
    else return move.from as MigrationStatus | null;
  }
  return null;
}

/** 진행 단계 카드. 모든 이전 화면이 같은 13칸을 쓰고, 멈춘 이전은 멈춘 칸을 표시한다. */
export function migrationSteps(
  migration: Pick<MigrationView, 'status' | 'pausedFrom' | 'failedAtStatus'>,
  anchor: MigrationStatus | null = null,
): ChecklistEntry[] {
  const { status } = migration;
  const stoppedAt: { at: MigrationStatus | null | undefined; mark: ChecklistEntry['status'] } | null =
    status === 'paused' ? { at: migration.pausedFrom, mark: 'paused' }
    : status === 'failed' ? { at: migration.failedAtStatus ?? anchor, mark: 'failed' }
    : status === 'rejected' ? { at: 'awaiting_approval', mark: 'failed' }
    : status === 'stale' ? { at: 'awaiting_approval', mark: 'paused' }
    : status === 'rolling_back' || status === 'rolled_back' || status === 'cancelled' ? { at: anchor, mark: 'paused' }
    : null;
  const current = stoppedAt ? stoppedAt.at : status;
  const at = status === 'completed' ? STEPS.length : current ? STEPS.findIndex((step) => step.through.includes(current)) : -1;
  return STEPS.map((step, index) => ({
    label: step.label,
    detail: step.detail,
    status: index < at ? 'done' : index === at ? (stoppedAt?.mark ?? 'active') : 'pending',
  }));
}

/** 지금 도착 쪽으로 가는 트래픽 비율. 전환 전에는 0, 컷오버 뒤에는 100이다. */
export function trafficPercent(status: MigrationStatus, shift: Pick<TrafficShiftProgress, 'available' | 'targetWeightPct' | 'observedWeightPct'> | null): number {
  const measured = shift?.available ? shift.observedWeightPct ?? shift.targetWeightPct : null;
  if (measured !== null && measured !== undefined) return measured;
  return status === 'cutover' || status === 'rollback_window' || status === 'cleanup' || status === 'completed' ? 100 : 0;
}

const RUN_TITLE: Partial<Record<MigrationStatus, string>> = {
  provisioning: '도착 환경을\n만들고 있습니다',
  deploying: '같은 앱을\n도착지에 띄우고 있습니다',
  syncing: 'DB를\n따라잡고 있습니다',
  shifting: '트래픽을\n옮기고 있습니다',
  cutover: 'DB 쓰기 담당을\n넘기고 있습니다',
};

export const runTitle = (status: MigrationStatus) => RUN_TITLE[status] ?? `${LABEL[status]}\n단계입니다`;

/** 서버 상태 표 기준으로 지금 롤백할 수 있는지. 창이 끝났으면 서버도 막는다. */
export function canRollback(migration: Pick<MigrationView, 'status' | 'rollbackWindowEndsAt'>, now = Date.now()): boolean {
  if (!VALID[migration.status].includes('rolling_back')) return false;
  if (migration.status !== 'rollback_window') return true;
  return migration.rollbackWindowEndsAt ? Date.parse(migration.rollbackWindowEndsAt) > now : false;
}

export function formatClock(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(safe / 60)).padStart(2, '0')}:${String(safe % 60).padStart(2, '0')}`;
}

export type SpecRow = { path: string; name: string; value: string; review: boolean };

export function specRows(view: Pick<MigrationSpecView, 'spec' | 'needsReview'>): SpecRow[] {
  const { app, service, database, ingress } = view.spec;
  const row = (path: string, name: string, value: string | number | undefined): SpecRow => ({
    path,
    name,
    value: value === undefined ? '비어 있음' : String(value),
    review: view.needsReview.some((field) => field === path || field.startsWith(`${path}.`)),
  });
  return [
    row('app.name', '앱 이름', app?.name),
    row('service.image', '이미지', service?.image),
    row('service.replicas', '복제 수', service?.replicas),
    row('service.cpu', 'CPU', service?.cpu),
    row('service.memory', '메모리', service?.memory),
    row('service.port', '포트', service?.port),
    row('service.healthPath', '상태 확인 경로', service?.healthPath),
    row(
      'database',
      '데이터베이스',
      database ? `${database.engine ?? 'postgres'} ${database.majorVersion ?? ''} · ${database.storageGb ?? '?'}GB` : undefined,
    ),
    row('ingress.hostname', '도메인', ingress?.hostname),
  ];
}

export const stepName = (id: PlanStep['id']) =>
  ({ provision: LABEL.provisioning, deploy: LABEL.deploying, sync: LABEL.syncing, shift: LABEL.shifting, cutover: LABEL.cutover, cleanup: LABEL.cleanup })[id];

const GATE_LABEL: Record<string, string> = {
  synced_healthy: '앱이 정상으로 뜸',
  'replication_lag_ms < 1000': '복제 지연 1초 미만',
};

export function stepGate(step: Pick<PlanStep, 'gate' | 'weights' | 'holdSec'>): string {
  return [step.gate ? (GATE_LABEL[step.gate] ?? step.gate) : null, step.weights?.length ? `${step.weights.join(' → ')}%` : null, step.holdSec ? `단계마다 ${step.holdSec}초` : null]
    .filter(Boolean)
    .join(' · ');
}

/** 고를 수 있는 환경: 연결되어 있어야 하고, 도착은 출발과 달라야 한다. */
export const canPick = (env: EnvironmentView, sourceId?: string | null) =>
  env.connectionStatus === 'connected' && env.id !== sourceId;

export const usd = (value: number | null | undefined) =>
  value === null || value === undefined ? '계산 불가' : `$${value.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
