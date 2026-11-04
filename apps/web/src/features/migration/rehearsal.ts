import type { ChecklistEntry } from '../../components/ui/Checklist';
import {
  REHEARSAL_FAILURE_CLASS,
  REHEARSAL_FAILURE_CODES,
  type FidelityItem,
  type FidelityItemId,
  type FidelityMatrix,
  type FidelityStatus,
  type RehearsalCheckId,
  type RehearsalFailureClass,
  type RehearsalFailureCode,
  type RehearsalResult,
  type RehearsalRun,
  type RehearsalSkip,
  type SandboxRunPhase,
} from '../../lib/rehearsal-types';
import type { MigrationStatus, MigrationView } from '../../lib/types';
import { t } from '../../lib/i18n';

// vCluster 리허설: deploying 안, GitOps 커밋 직전에 같은 매니페스트를 일회용 가상 클러스터에 먼저 올린다.
// 화면은 이 파일의 판단만 쓴다. 시험은 test/rehearsal-model.test.ts

/** 격리 문구. 사람이 승인한 문장이라 화면과 발표에 그대로 쓴다. 바꾸지 않는다. */
export const ISOLATION_TEXT =
  t('리허설은 플랫폼 안의 일회용 가상 클러스터에서 돕니다. 전용 노드에 한 번에 한 회사만 올라가고, 인터넷·클라우드 메타데이터·플랫폼 DB에 닿지 못하며, 고객 자격 증명은 들어가지 않습니다.');

/** 지난 시도 줄 머리 문장. 줄 내용은 그대로 보이되 지금 판정이 아니라고 먼저 말한다. */
export const STALE_TEXT = t('지난 배포 시도의 기록입니다. 이번 시도의 판정이 아닙니다.');

/** 빌린 권한 한 줄. 리허설 자체는 고객 권한을 쓰지 않고, 이미지 복사만 출발 관찰 역할을 빌린다. */
export const BORROW_TEXT = t('리허설은 고객 권한을 쓰지 않습니다. 이미지 복사만 출발 관찰 역할을 15분 빌립니다.');

export const PHASE_LABEL: Record<SandboxRunPhase, string> = {
  creating: t('샌드박스 만들기'),
  applying: t('같은 매니페스트 올리기'),
  checking: t('검사'),
  deleting: t('샌드박스 지우기'),
  done: t('끝'),
};
const PHASES: SandboxRunPhase[] = ['creating', 'applying', 'checking', 'deleting'];
/** 단계 이름. 화면이 모르는 단계(옛 서버의 mirroring 등)는 비운다 */
export const phaseLabel = (phase: string | null | undefined) => (phase && phase in PHASE_LABEL ? PHASE_LABEL[phase as SandboxRunPhase] : '');

export const CHECK_LABEL: Record<RehearsalCheckId, string> = {
  sandbox_ready: t('샌드박스 준비'),
  dry_run: t('원본 미리 적용(dry-run)'),
  target_policy: t('도착 파드 보안 규칙'),
  quota: t('도착 네임스페이스 한도'),
  apply: t('적용'),
  rollout: t('롤아웃'),
  restarts: t('재시작 없음'),
  ready: t('준비 상태'),
  job_complete: t('Job 끝남'),
  service_http: t('서비스 응답'),
  edge_http: t('서비스 사이 연결'),
  db_seen: t('DB 닿음'),
  unsupported_kind: t('지원하는 종류만'),
};

export const FIDELITY_LABEL: Record<FidelityItemId, string> = {
  manifests: t('매니페스트'),
  namespace: t('네임스페이스'),
  k8s_version: t('쿠버네티스 버전'),
  objects: t('객체 목록'),
  target_pod_security: t('도착 파드 보안'),
  sandbox_pod_security: t('샌드박스 파드 보안'),
  images: t('이미지'),
  replicas: t('복제 수'),
  requests: t('요청 자원'),
  scheduling: t('배치 규칙'),
  service_type: t('서비스 종류'),
  storage: t('저장소'),
  secrets: t('비밀 이름'),
  secret_values: t('비밀 값'),
  database: 'DB',
  ingress: t('진입'),
  tunnel: t('터널'),
  cloud_identity: t('클라우드 권한(ID)'),
  network: t('네트워크'),
  quota: t('한도'),
  runtime_isolation: t('런타임 격리'),
  hpa_scaling: t('자동 늘리기(HPA)'),
  cronjob_runs: t('예약 작업 실행'),
  daemonsets: t('데몬셋'),
  data: t('데이터'),
  traffic: t('실제 트래픽'),
  node_arch: t('노드 아키텍처'),
};

export const FIDELITY_GROUP: Record<FidelityStatus, string> = {
  identical: t('같게 확인한 것'),
  substituted: t('바꿔서 확인한 것'),
  not_checked: t('확인하지 못한 것'),
};

export const SKIP_TEXT: Record<RehearsalSkip, string> = {
  non_k8s: t('도착이 쿠버네티스가 아니라(ECS·Cloud Run·VM) 리허설하지 않았습니다.'),
  no_cluster: t('도착 클러스터 정보가 아직 없어 리허설하지 않았습니다.'),
  unsupported_target: t('리허설을 지원하지 않는 도착입니다. EKS·GKE·온프레 k3s 도착만 리허설합니다.'),
  disabled: t('이 플랫폼에서 리허설이 꺼져 있어 리허설 없이 배포했습니다.'),
  mock: t('흉내 배포라 리허설하지 않았습니다.'),
};

export const isRehearsalCode = (code: string | null | undefined): code is RehearsalFailureCode =>
  !!code && (REHEARSAL_FAILURE_CODES as readonly string[]).includes(code);

export const failureClassOf = (code: string | null | undefined): RehearsalFailureClass | null =>
  isRehearsalCode(code) ? REHEARSAL_FAILURE_CLASS[code] : null;

export type RehearsalState = 'none' | 'waiting' | 'running' | 'passed' | 'reused' | 'skipped' | 'failed' | 'error' | 'stale';

export function rehearsalState(run: RehearsalRun | null | undefined, stale = false): RehearsalState {
  if (!run) return 'none';
  if (stale) return 'stale';
  switch (run.status) {
    case 'queued':
      return 'waiting';
    case 'running':
      return 'running';
    case 'passed':
      return run.reusedFrom ? 'reused' : 'passed';
    case 'skipped':
      return 'skipped';
    case 'failed':
      return 'failed';
    case 'error':
      return 'error';
  }
}

/** 지난 시도의 줄인가 (서버 run.stale). 지난 줄은 지금 판정으로 말하지 않는다. */
export const isStaleRun = (run: Pick<RehearsalRun, 'stale'> | null | undefined) => run?.stale === true;

/**
 * 진행 단계 카드 "앱 배포" 칸 오른쪽 한 마디. 지난 시도의 줄이면(배포 중일 때 말고) 붙이지 않는다.
 * 배포 중인데 줄이 없으면 워커가 이미지를 복사하는 중이라(줄은 그 뒤에 생긴다) "리허설 준비".
 */
export function rehearsalStepDetail(run: RehearsalRun | null | undefined, stale = false, status?: MigrationStatus): string | undefined {
  const state = rehearsalState(run, stale);
  switch (state) {
    case 'none':
      return status === 'deploying' ? t('리허설 준비') : undefined;
    case 'stale':
      return status === 'deploying' ? t('리허설 준비') : undefined;
    case 'waiting':
      return t('리허설 준비');
    case 'running':
      return t('리허설 중');
    case 'passed':
      return t('리허설 통과');
    case 'reused':
      return t('리허설 재사용');
    case 'skipped':
      return t('리허설 건너뜀');
    case 'failed':
    case 'error':
      return t('리허설에서 멈춤');
  }
}

/** 리허설 카드 머리줄 오른쪽 요약. */
export function rehearsalSummary(run: RehearsalRun | null | undefined, stale = false): string {
  const state = rehearsalState(run, stale);
  if (state === 'running' && phaseLabel(run?.phase)) return t('도는 중 · {0}', { 0: phaseLabel(run?.phase) });
  const SUMMARY: Record<RehearsalState, string> = {
    none: t('아직 없음'),
    waiting: t('차례 기다림'),
    running: t('도는 중'),
    passed: t('통과'),
    reused: t('앞선 통과 재사용'),
    skipped: t('건너뜀'),
    failed: t('실패'),
    error: t('오류'),
    stale: t('지난 시도 기록'),
  };
  return SUMMARY[state];
}

/** 도는 동안의 단계. 이미지 복사는 워커, 나머지는 샌드박스 쪽이 한다. */
export function phaseEntries(run: Pick<RehearsalRun, 'status' | 'phase'>): ChecklistEntry[] {
  const at = run.status === 'queued' ? -1 : run.phase ? PHASES.indexOf(run.phase as SandboxRunPhase) : 0;
  const finished = run.phase === 'done' || run.status === 'passed';
  return PHASES.map((phase, index) => ({
    label: PHASE_LABEL[phase],
    status: finished || index < at ? 'done' : index === at ? 'active' : 'pending',
  }));
}

/** 검사 줄 이름. 대상이 이름과 같으면 한 번만 쓴다. 참고 줄은 표시한다. */
const checkLabel = (check: RehearsalResult['checks'][number]) => {
  const name = CHECK_LABEL[check.id] ?? check.id;
  const subject = check.subject && check.subject !== name ? ` · ${check.subject}` : '';
  return `${name}${subject}${check.required ? '' : t(' (참고)')}`;
};

/**
 * 검사 줄. 판정을 가른 실패(필수)는 이유와 함께 따로, 나머지는 판정에 드는 것 먼저 limit 개까지 목록으로.
 * 실패 이유는 길어서 목록 오른쪽에 두지 않고 줄 아래에 둔다.
 */
export function checkEntries(result: Pick<RehearsalResult, 'checks'>, limit = 5) {
  const failed = result.checks.filter((check) => check.required && !check.ok).map((check) => ({ label: checkLabel(check), detail: check.detail }));
  const rest = result.checks.filter((check) => !(check.required && !check.ok));
  const rank = (check: RehearsalResult['checks'][number]) => (check.required ? 0 : check.ok ? 1 : 2);
  const sorted = [...rest].sort((a, b) => rank(a) - rank(b));
  const items: ChecklistEntry[] = sorted.slice(0, limit).map((check) => ({
    label: checkLabel(check),
    status: check.ok ? 'done' : 'paused',
  }));
  return { failed, items, more: Math.max(0, sorted.length - limit) };
}

/** 충실도 표를 세 묶음으로. 빈 묶음은 뺀다. 표는 고치지 않고 그대로 보인다. */
export function fidelityGroups(matrix: FidelityMatrix | null | undefined): { status: FidelityStatus; title: string; items: FidelityItem[] }[] {
  if (!matrix) return [];
  const order: FidelityStatus[] = ['identical', 'substituted', 'not_checked'];
  return order
    .map((status) => ({ status, title: FIDELITY_GROUP[status], items: matrix.items.filter((item) => item.status === status) }))
    .filter((group) => group.items.length > 0);
}

/** 커널 격리 한 줄. gVisor 같은 RuntimeClass 가 있으면 커널 분리, 없으면 같은 커널에 전용 노드. */
export function isolationLine(sandbox: Pick<RehearsalResult['sandbox'], 'runtimeClass' | 'podSecurity' | 'mock'>): string {
  const kernel = sandbox.runtimeClass ? t('커널 분리({0})', { 0: sandbox.runtimeClass }) : t('같은 커널, 전용 노드');
  return [kernel, t('파드 보안 {0}', { 0: sandbox.podSecurity }), sandbox.mock ? t('흉내 샌드박스') : null].filter(Boolean).join(' · ');
}

/** 걸린 시간(초). 끝났으면 시작부터 끝까지, 도는 중이면 지금까지. */
export function elapsedSec(run: Pick<RehearsalRun, 'createdAt' | 'startedAt' | 'finishedAt'>, now = Date.now()): number {
  const start = Date.parse(run.startedAt ?? run.createdAt);
  const end = run.finishedAt ? Date.parse(run.finishedAt) : now;
  return Math.max(0, Math.round((end - start) / 1000));
}

/**
 * 기한 줄 이름. deadlineAt 은 지금 단계의 기한이다: 줄을 서는 동안은 줄 서기 기한(최대 60분),
 * agent-worker 가 집으면 실행 기한(REHEARSAL_TIMEOUT_SEC)으로 바뀐다. 그래서 남은 시간이 집히는 순간 다른 값으로 뛸 수 있다.
 */
export function deadlineLabel(run: Pick<RehearsalRun, 'status'>): string | null {
  if (run.status === 'queued') return t('줄 서기 기한');
  if (run.status === 'running') return t('실행 기한');
  return null;
}

/** REHEARSAL_TIMEOUT 이 어디서 났는지 (감사 detail.rehearsal.stage): 줄 서기(queue) / 실행(run) */
export function timeoutStageText(stage: string | null | undefined): string | null {
  if (stage === 'queue') return t('샌드박스가 아직 돌지 못함 (줄 서기 기한 넘김)');
  if (stage === 'run') return t('실행 중 시간 초과');
  return null;
}

/** 남은 기한(초). 기한이 없거나 끝난 줄이면 null. */
export function remainingSec(run: Pick<RehearsalRun, 'deadlineAt' | 'finishedAt'>, now = Date.now()): number | null {
  if (!run.deadlineAt || run.finishedAt) return null;
  return Math.max(0, Math.round((Date.parse(run.deadlineAt) - now) / 1000));
}

export const formatSec = (sec: number) => (sec < 1 ? t('1초 미만') : sec < 60 ? t('{0}초', { 0: sec }) : t('{0}분 {1}초', { 0: Math.floor(sec / 60), 1: sec % 60 }));

// 리허설 줄이 있을 수 있는 상태: deploying 과 그 뒤. 멈춘·실패한 이전은 멈춘 칸으로 본다
const AFTER_DEPLOY = ['deploying', 'syncing', 'shifting', 'cutover', 'rollback_window', 'cleanup', 'completed'];

/** 리허설을 읽을지. 배포 단계에 닿기 전이면 줄이 없으니 부르지 않는다. */
export function rehearsalRelevant(migration: Pick<MigrationView, 'status' | 'pausedFrom' | 'failedAtStatus'>): boolean {
  if (migration.status === 'paused') return !!migration.pausedFrom && AFTER_DEPLOY.includes(migration.pausedFrom);
  if (migration.status === 'failed') return !!migration.failedAtStatus && AFTER_DEPLOY.includes(migration.failedAtStatus);
  return AFTER_DEPLOY.includes(migration.status);
}

/** 다시 읽는 간격. 리허설이 도는 deploying 동안만 빠르게, 나머지는 한 번. */
export const rehearsalPollMs = (status: MigrationView['status']) => (status === 'deploying' ? 2_000 : null);

/** 큰 카드 한 줄 (deploying 일 때). 줄이 없으면 null. */
export function rehearsalHeroLine(run: RehearsalRun | null | undefined, stale = false): string | null {
  const state = rehearsalState(run, stale);
  if (state === 'none') return t('고객 클러스터에 올리기 전에 리허설을 준비하고 있습니다 · 이미지 복사');
  if (state === 'running' || state === 'waiting')
    return t('고객 클러스터에 올리기 전에 일회용 가상 클러스터에서 먼저 리허설하고 있습니다{0}', { 0: phaseLabel(run?.phase) ? ` · ${phaseLabel(run?.phase)}` : '' });
  if (state === 'passed' || state === 'reused') return t('리허설을 통과해 같은 매니페스트를 도착 클러스터에 올리고 있습니다');
  if (state === 'skipped' && run?.skip) return SKIP_TEXT[run.skip];
  if (state === 'stale') return t('이번 배포 시도의 리허설을 준비하고 있습니다. 옆의 리허설 카드는 지난 시도의 기록입니다');
  return null;
}
