import type { TrafficShiftProgress } from '../../lib/liveTraffic';
import { substituteRows } from '../../lib/resourceMap';
import { HUMAN_STEP, isTerminal, LABEL } from '../../lib/status';
import type { Judgement } from '../../lib/timelineDetail';
import {
  VALID,
  type ApprovalRowV2,
  type EnvApp,
  type EnvironmentView,
  type FootprintResource,
  type FootprintState,
  type MigrationStatus,
  type MigrationView,
  type PlanAcknowledgement,
  type PlanDoc,
  type PlanStep,
  type TimelineItem,
  type TrafficSummary,
} from '../../lib/types';
import type { ChecklistEntry } from '../../components/ui/Checklist';
import { t } from '../../lib/i18n';

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

/**
 * 화면 신호(SSE)만으로 이 이전 화면이 맞춰지는지. 신호는 상태가 바뀔 때만 온다.
 * 워커 단계는 상태가 그대로인 채 값이 바뀌므로(롤백 창 끝 시각 등) 신호가 살아 있어도 빠른 간격을 그대로 둔다.
 * 사람 차례·멈춘 상태는 사람이나 워커가 상태를 바꿀 때까지 바뀔 것이 없어서 신호에 맡기고 간격을 늘려도 된다.
 */
export const signalCovers = (status: MigrationStatus | undefined): boolean => pollMs(status) !== POLL.worker;

/**
 * "계획 다시 만들기"(POST /migrations/:id/replan)를 보여 줄지. 서버 규칙 그대로: stale·rejected 만.
 * failed 에서 다시 계획하는 길은 서버가 없앴다(409 INVALID_TRANSITION). 실패는 failureChoices 의 failure-decision 으로 고른다
 */
export function canReplan(migration: Pick<MigrationView, 'status' | 'failedAtStatus'>): boolean {
  return migration.status === 'stale' || migration.status === 'rejected';
}

/** failed 화면이 "다시 시도"를 보이는 실패 지점 */
export type RetryStage = 'importing' | 'prechecking' | 'planning' | 'provisioning';
const RETRY_STAGES: readonly MigrationStatus[] = ['importing', 'prechecking', 'planning', 'provisioning'];
// 서버 contracts ROLLBACK_ON_REJECT 의 반대: 이 지점 실패는 만든 자원이 없어 "거절"이 롤백이 아니라 끝내기(cancelled)다
const NOTHING_MADE: readonly MigrationStatus[] = ['importing', 'prechecking', 'planning'];

/**
 * failed 화면에서 고를 길 (POST /migrations/:id/failure-decision, apps/api control.ts).
 * retry: 실패 지점부터 다시 할 단계. 서버는 cutover·rolling_back 재시도도 받지만
 *   DRAFT(ai): 데이터·트래픽이 움직인 뒤라 화면은 그 둘에 다시 시도를 두지 않고 지금처럼 정리 확인 뒤 끝내기만 둔다.
 * nothingMade: 만든 자원이 없는 실패. 끝내기는 정리 확인 없이 failure-decision rollback(→ cancelled)으로 보낸다
 */
export function failureChoices(migration: Pick<MigrationView, 'status' | 'failedAtStatus'>): { retry: RetryStage | null; nothingMade: boolean } {
  const at = migration.status === 'failed' ? migration.failedAtStatus : null;
  return {
    retry: at && RETRY_STAGES.includes(at) ? (at as RetryStage) : null,
    nothingMade: !!at && NOTHING_MADE.includes(at),
  };
}

/** 승인 확인 항목(계획서 acknowledgements) 중 아직 체크하지 않은 것. 옛 계획서처럼 항목이 없으면 바로 승인할 수 있다. */
export function ackState(acks: readonly { id: string }[] | undefined, checked: ReadonlySet<string>) {
  const all = acks ?? [];
  const missing = all.filter((ack) => !checked.has(ack.id)).map((ack) => ack.id);
  return { total: all.length, missing, ready: missing.length === 0, ids: all.map((ack) => ack.id).filter((id) => checked.has(id)) };
}

/**
 * 승인 확인 항목을 확인하는 자리로 나눈다. 항목마다 자리는 하나다.
 * 상품 대체는 큰 카드의 대응 줄 끝 버튼, 나머지는 "승인 전에 확인" 목록의 체크. 둘 다 같은 체크 상태(ackState)를 바꾼다
 */
export function ackPlaces(acks: readonly PlanAcknowledgement[] | undefined) {
  const all = acks ?? [];
  return { substitutes: substituteRows(all), list: all.filter((ack) => ack.kind !== 'substitute') };
}

// 자원 하나를 가리키는 승인 줄 (명세 승인 줄 ApprovalRowV2 그대로: id `${kind}:${자원}`, ref = 자원). 글에는 자원 이름이 없다.
//   상품 대체는 큰 카드가 자원 이름을 따로 쓴다
const SUBJECT_ACK: Record<Exclude<ApprovalRowV2['kind'], 'substitute'>, true> = {
  runtime_change: true, build: true, tls_relaxed: true, host_access: true, public_bucket: true,
};
/** "승인 전에 확인" 줄이 가리키는 자원 이름. 같은 종류 줄이 여럿이면 이 이름으로만 구별된다. 자원 줄이 아니면 null */
export function ackSubject(ack: Pick<PlanAcknowledgement, 'kind' | 'ref'>): string | null {
  return ack.ref && ack.kind in SUBJECT_ACK ? ack.ref : null;
}

/** 승인 버튼 글자. 모자라면 무엇이 모자란지 말한다. */
export function approveLabel(o: { busy: boolean; expired: boolean; missing: number }): string {
  if (o.busy) return t('보내는 중');
  if (o.expired) return t('승인 시간 지남');
  if (o.missing > 0) return t('확인 {0}개 남음', { 0: o.missing });
  return t('승인하고 실행 시작');
}

// human: 사람이 눌러야 다음으로 가는 칸. 그 칸에 있으면 도는 표시 대신 입력을 기다리는 표시를 쓴다
type Step = { label: string; human?: boolean; through: MigrationStatus[] };

// 진행 단계는 두 묶음이다. 실행 전(사람이 명세를 확정하고 계획을 승인)과 실행(승인하면 바로 시작해 워커가 옮김).
// 카드는 지금 묶음 하나만 보여 준다. 묶음 번호는 보이지 않는다
const PREPARE_STEPS: Step[] = [
  { label: t('구성 읽기'), through: ['draft', 'importing'] },
  { label: t('명세 확정'), human: true, through: ['spec_review'] },
  { label: t('사전 점검'), through: ['prechecking'] },
  { label: t('계획 만들기'), through: ['planning'] },
  { label: t('계획 승인'), human: true, through: ['awaiting_approval'] },
];
// approved 는 승인 뒤 시작이 막혔을 때만(동시 진행 상한·환경 사용 중) 남는다. 그때는 자원 생성 칸이 사람 입력을 기다린다
const RUN_STEPS: Step[] = [
  { label: LABEL.provisioning, through: ['approved', 'provisioning'] },
  { label: LABEL.deploying, through: ['deploying'] },
  { label: LABEL.syncing, through: ['syncing'] },
  { label: LABEL.shifting, through: ['shifting'] },
  { label: LABEL.cutover, through: ['cutover'] },
  { label: t('롤백 대기'), through: ['rollback_window'] },
  { label: LABEL.cleanup, through: ['cleanup'] },
];
const RUN_STATES: readonly MigrationStatus[] = RUN_STEPS.flatMap((step) => step.through);

/** 진행 단계 카드가 보여 줄 묶음. 멈춘·끝난 마이그레이션은 멈춘 칸이 어느 묶음인지로 정한다. */
export function stepsPhase(migration: Pick<MigrationView, 'status' | 'pausedFrom' | 'failedAtStatus'>, anchor: MigrationStatus | null = null): 'prepare' | 'run' {
  const { status } = migration;
  if (status === 'completed' || status === 'paused' || status === 'rolling_back' || status === 'rolled_back') return 'run';
  if (status === 'failed') {
    const at = migration.failedAtStatus ?? anchor;
    return at && RUN_STATES.includes(at) ? 'run' : 'prepare';
  }
  if (status === 'cancelled') return anchor && RUN_STATES.includes(anchor) ? 'run' : 'prepare';
  return RUN_STATES.includes(status) ? 'run' : 'prepare';
}

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

/** 진행 단계 카드. 실행 전 5칸 또는 실행 7칸 중 지금 묶음을 쓰고, 멈춘 마이그레이션은 멈춘 칸을 표시한다. */
export function migrationSteps(
  migration: Pick<MigrationView, 'status' | 'pausedFrom' | 'failedAtStatus'>,
  anchor: MigrationStatus | null = null,
  /** 칸 오른쪽에 붙일 한 마디 (예: 앱 배포 칸의 "리허설 통과") */
  notes: Partial<Record<MigrationStatus, string>> = {},
): ChecklistEntry[] {
  const { status } = migration;
  const stoppedAt: { at: MigrationStatus | null | undefined; mark: ChecklistEntry['status'] } | null =
    status === 'paused' ? { at: migration.pausedFrom, mark: 'paused' }
    : status === 'failed' ? { at: migration.failedAtStatus ?? anchor, mark: 'failed' }
    : status === 'rejected' ? { at: 'awaiting_approval', mark: 'failed' }
    : status === 'stale' ? { at: 'awaiting_approval', mark: 'paused' }
    : status === 'rolling_back' || status === 'rolled_back' || status === 'cancelled' ? { at: anchor, mark: 'paused' }
    : null;
  const steps = stepsPhase(migration, anchor) === 'prepare' ? PREPARE_STEPS : RUN_STEPS;
  const current = stoppedAt ? stoppedAt.at : status;
  const at = status === 'completed' ? steps.length : current ? steps.findIndex((step) => step.through.includes(current)) : -1;
  // 승인했는데 시작이 막혀 approved 에 남았으면 자원 생성 칸은 사람이 다시 시작하기를 기다린다
  const waits = (step: Step) => step.human || status === 'approved';
  return steps.map((step, index) => ({
    label: step.label,
    detail: step.through.map((through) => notes[through]).find(Boolean) ?? (step.human ? t('사람') : undefined),
    status: index < at ? 'done' : index === at ? (stoppedAt?.mark ?? (waits(step) ? 'waiting' : 'active')) : 'pending',
  }));
}

/**
 * 트래픽 막대 밑 한 줄. 실측이 목표에 아직 못 미치면 퍼지는 중이라고 말한다.
 * 전환 기록이 없거나 트래픽 이동 단계가 아니면 쓰지 않는다 (막대가 이미 말한다).
 */
export function shiftNote(
  status: MigrationStatus,
  shift: Pick<TrafficShiftProgress, 'available' | 'targetWeightPct' | 'observedWeightPct' | 'reached'> | null,
): string | null {
  if (status !== 'shifting' || !shift?.available || shift.targetWeightPct === null) return null;
  if (shift.observedWeightPct === null) return t('목표 {0}% · 실측 아직 없음', { 0: shift.targetWeightPct });
  if (shift.reached === false) return t('목표 {0}%로 퍼지는 중 · 지금 {1}%', { 0: shift.targetWeightPct, 1: shift.observedWeightPct });
  return t('목표 {0}% · 실측 {1}%', { 0: shift.targetWeightPct, 1: shift.observedWeightPct });
}

const LEFT_STATES: FootprintState[] = ['left', 'unknown', 'running', 'standby', 'creating', 'stopping'];

export const FOOTPRINT_LABEL: Partial<Record<FootprintState, string>> = {
  left: t('남음'),
  unknown: t('생겼을 수 있음'),
  running: t('돌고 있음'),
  standby: t('대기 중'),
  creating: t('만드는 중'),
  stopping: t('걷는 중'),
};

/**
 * 끝난(실패·롤백·취소) 이전이 도착 환경에 남긴 자원. 서버가 이전 상태와 감사 기록으로 낸 목록이다.
 * 도착 환경 재고에 이 이전이 없으면 null(모름), 있는데 남은 것이 없으면 빈 목록이다.
 */
export function leftoversOf(apps: EnvApp[] | null | undefined, migrationId: string): FootprintResource[] | null {
  const app = apps?.find((item) => item.migrationId === migrationId && item.role === 'target');
  if (!app) return null;
  return app.resources.filter((resource) => LEFT_STATES.includes(resource.state));
}

/** 남은 자원 한 줄의 오른쪽 값. 만든 척(stub)만 한 자원은 그렇다고 붙인다. */
export const leftoverValue = (resource: Pick<FootprintResource, 'state' | 'evidence'>) =>
  [FOOTPRINT_LABEL[resource.state] ?? resource.state, resource.evidence === 'stub' ? t('흉내') : null].filter(Boolean).join(' · ');

const pct = (value: number) => `${Number(value.toFixed(2))}%`;

/** 멈춘·되돌린 순간의 트래픽 판정을 근거 줄로. 기준은 계획서의 되돌림 기준이다(없으면 숫자만). */
export function judgementRows(judgement: Judgement, criteria?: PlanDoc['rollbackCriteria'] | null): { name: string; value: string }[] {
  return [
    {
      name: t('도착 오류율'),
      value: t('{0} (출발 {1}{2})', { 0: pct(judgement.targetErrorRatePct), 1: pct(judgement.sourceErrorRatePct), 2: criteria ? t(' · 기준 {0}%', { 0: criteria.errorRatePct }) : '' }),
    },
    {
      name: t('도착 p95'),
      value: judgement.latencyMeasured === false ? t('지연 미측정')
        : t('{0}ms (출발 {1}ms{2})', { 0: Math.round(judgement.targetP95Ms), 1: Math.round(judgement.sourceP95Ms), 2: criteria ? t(' · 기준 {0}배', { 0: criteria.p95Multiplier }) : '' }),
    },
    { name: t('그때 도착 비율'), value: `${judgement.stepPct}%` },
    { name: t('판정에 쓴 요청'), value: t('{0}건', { 0: judgement.samples.toLocaleString('en-US') }) },
  ];
}

/** 증적 리포트의 트래픽 판정 요약을 근거 줄로. 서버가 값을 못 낸 칸(null)은 "아직 없음"으로 둔다. */
export function trafficReportRows(summary: TrafficSummary): { name: string; value: string }[] {
  return [
    { name: t('거친 비율'), value: summary.steps.length > 0 ? summary.steps.map((step) => `${step}%`).join(' → ') : t('아직 없음') },
    { name: t('판정'), value: t('{0}번 · 나쁨 {1}번', { 0: summary.judgements, 1: summary.bad }) },
    { name: t('최대 도착 오류율'), value: summary.maxTargetErrorRatePct === null ? t('아직 없음') : pct(summary.maxTargetErrorRatePct) },
    { name: t('최대 도착 p95'), value: summary.maxTargetP95Ms === null ? t('아직 없음') : `${Math.round(summary.maxTargetP95Ms)}ms` },
  ];
}

/** 지금 도착 쪽으로 가는 트래픽 비율. 전환 전에는 0, 컷오버 뒤에는 100이다. */
export function trafficPercent(status: MigrationStatus, shift: Pick<TrafficShiftProgress, 'available' | 'targetWeightPct' | 'observedWeightPct'> | null): number {
  const measured = shift?.available ? shift.observedWeightPct ?? shift.targetWeightPct : null;
  if (measured !== null && measured !== undefined) return measured;
  return status === 'cutover' || status === 'rollback_window' || status === 'cleanup' || status === 'completed' ? 100 : 0;
}

const RUN_TITLE: Partial<Record<MigrationStatus, string>> = {
  provisioning: t('도착 환경을\n만들고 있습니다'),
  deploying: t('같은 앱을\n도착지에 띄우고 있습니다'),
  syncing: t('DB를\n따라잡고 있습니다'),
  shifting: t('트래픽을\n옮기고 있습니다'),
  cutover: t('DB 쓰기 담당을\n넘기고 있습니다'),
};

export const runTitle = (status: MigrationStatus) => RUN_TITLE[status] ?? t('{0}\n단계입니다', { 0: LABEL[status] });

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
    value: value === undefined ? t('비어 있음') : String(value),
    review: view.needsReview.some((field) => field === path || field.startsWith(`${path}.`)),
  });
  return [
    row('app.name', t('앱 이름'), app?.name),
    row('service.image', t('이미지'), service?.image),
    row('service.replicas', t('복제 수'), service?.replicas),
    row('service.cpu', 'CPU', service?.cpu),
    row('service.memory', t('메모리'), service?.memory),
    row('service.port', t('포트'), service?.port),
    row('service.healthPath', t('상태 확인 경로'), service?.healthPath),
    row(
      'database',
      t('데이터베이스'),
      database ? `${database.engine ?? 'postgres'} ${database.majorVersion ?? ''} · ${database.storageGb ?? '?'}GB` : undefined,
    ),
    row('ingress.hostname', t('도메인'), ingress?.hostname),
  ];
}

export const stepName = (id: PlanStep['id']) =>
  ({ provision: LABEL.provisioning, deploy: LABEL.deploying, sync: LABEL.syncing, shift: LABEL.shifting, cutover: LABEL.cutover, cleanup: LABEL.cleanup })[id];

const GATE_LABEL: Record<string, string> = {
  synced_healthy: t('앱이 정상으로 뜸'),
  'replication_lag_ms < 1000': t('복제 지연 1초 미만'),
};

export function stepGate(step: Pick<PlanStep, 'gate' | 'weights' | 'holdSec'>): string {
  return [step.gate ? (GATE_LABEL[step.gate] ?? step.gate) : null, step.weights?.length ? `${step.weights.join(' → ')}%` : null, step.holdSec ? t('단계마다 {0}초', { 0: step.holdSec }) : null]
    .filter(Boolean)
    .join(' · ');
}

/** 고를 수 있는 환경: 연결되어 있어야 하고, 도착은 출발과 달라야 한다. */
export const canPick = (env: EnvironmentView, sourceId?: string | null) =>
  env.connectionStatus === 'connected' && env.id !== sourceId;

export const usd = (value: number | null | undefined) =>
  value === null || value === undefined ? t('계산 불가') : `$${value.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;


/**
 * 승인하면 바로 실행을 시작한다. 승인과 시작 사이에 상태가 잠깐 approved 로 보여도 승인 화면을 그대로 두고(autoStarting),
 * 시작이 막히면 그 이유 코드를 남겨 실행 대기 화면이 이어 받는다(startBlocked). 탭 하나 안의 기억이다.
 */
const starting = new Set<string>();
const blocked = new Map<string, string>();
export const autoStart = {
  begin: (id: string) => {
    starting.add(id);
    blocked.delete(id);
  },
  end: (id: string, code: string | null) => {
    starting.delete(id);
    if (code) blocked.set(id, code);
  },
  isStarting: (id: string) => starting.has(id),
  blockedCode: (id: string) => blocked.get(id) ?? null,
};
