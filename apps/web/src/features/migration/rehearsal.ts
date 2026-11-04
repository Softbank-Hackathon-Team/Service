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
import type { MigrationView } from '../../lib/types';

// vCluster 리허설: deploying 안, GitOps 커밋 직전에 같은 매니페스트를 일회용 가상 클러스터에 먼저 올린다.
// 화면은 이 파일의 판단만 쓴다. 시험은 test/rehearsal-model.test.ts

/** 격리 문구. 사람이 승인한 문장이라 화면과 발표에 그대로 쓴다. 바꾸지 않는다. */
export const ISOLATION_TEXT =
  '리허설은 플랫폼 안의 일회용 가상 클러스터에서 돕니다. 전용 노드에 한 번에 한 회사만 올라가고, 인터넷·클라우드 메타데이터·플랫폼 DB에 닿지 못하며, 고객 자격 증명은 들어가지 않습니다.';

/** 빌린 권한 한 줄. 리허설 자체는 고객 권한을 쓰지 않고, 이미지 복사만 출발 관찰 역할을 빌린다. */
export const BORROW_TEXT = '리허설은 고객 권한을 쓰지 않습니다. 이미지 복사만 출발 관찰 역할을 15분 빌립니다.';

export const PHASE_LABEL: Record<SandboxRunPhase, string> = {
  mirroring: '이미지 복사',
  creating: '샌드박스 만들기',
  applying: '같은 매니페스트 올리기',
  checking: '검사',
  deleting: '샌드박스 지우기',
  done: '끝',
};
const PHASES: SandboxRunPhase[] = ['mirroring', 'creating', 'applying', 'checking', 'deleting'];

export const CHECK_LABEL: Record<RehearsalCheckId, string> = {
  sandbox_ready: '샌드박스 준비',
  dry_run: '원본 미리 적용(dry-run)',
  target_policy: '도착 파드 보안 규칙',
  quota: '도착 네임스페이스 한도',
  apply: '적용',
  rollout: '롤아웃',
  restarts: '재시작 없음',
  ready: '준비 상태',
  job_complete: 'Job 끝남',
  service_http: '서비스 응답',
  edge_http: '서비스 사이 연결',
  db_seen: 'DB 닿음',
  unsupported_kind: '지원하는 종류만',
};

export const FIDELITY_LABEL: Record<FidelityItemId, string> = {
  manifests: '매니페스트',
  namespace: '네임스페이스',
  k8s_version: '쿠버네티스 버전',
  objects: '객체 목록',
  target_pod_security: '도착 파드 보안',
  sandbox_pod_security: '샌드박스 파드 보안',
  images: '이미지',
  replicas: '복제 수',
  requests: '요청 자원',
  scheduling: '배치 규칙',
  service_type: '서비스 종류',
  storage: '저장소',
  secrets: '비밀 이름',
  secret_values: '비밀 값',
  database: 'DB',
  ingress: '진입',
  tunnel: '터널',
  cloud_identity: '클라우드 권한(ID)',
  network: '네트워크',
  quota: '한도',
  runtime_isolation: '런타임 격리',
  hpa_scaling: '자동 늘리기(HPA)',
  cronjob_runs: '예약 작업 실행',
  daemonsets: '데몬셋',
  data: '데이터',
  traffic: '실제 트래픽',
  node_arch: '노드 아키텍처',
};

export const FIDELITY_GROUP: Record<FidelityStatus, string> = {
  identical: '같게 확인한 것',
  substituted: '바꿔서 확인한 것',
  not_checked: '확인하지 못한 것',
};

export const SKIP_TEXT: Record<RehearsalSkip, string> = {
  non_k8s: '도착이 쿠버네티스가 아니라(ECS·Cloud Run·VM) 리허설하지 않았습니다.',
  no_cluster: '도착 클러스터 정보가 아직 없어 리허설하지 않았습니다.',
  unsupported_target: '리허설을 지원하지 않는 도착입니다. EKS·GKE·온프레 k3s 도착만 리허설합니다.',
  disabled: '이 플랫폼에서 리허설이 꺼져 있어 리허설 없이 배포했습니다.',
  mock: '흉내 배포라 리허설하지 않았습니다.',
};

export const isRehearsalCode = (code: string | null | undefined): code is RehearsalFailureCode =>
  !!code && (REHEARSAL_FAILURE_CODES as readonly string[]).includes(code);

export const failureClassOf = (code: string | null | undefined): RehearsalFailureClass | null =>
  isRehearsalCode(code) ? REHEARSAL_FAILURE_CLASS[code] : null;

/**
 * 지금 배포 시도의 줄이 아니라 지난 시도의 실패 줄인가. 재개하면 deploying 으로 돌아오지만 새 줄이 생기기 전에는 지난 줄이 가장 새것이다.
 * DRAFT(ai): 서버가 "지난 시도" 칸을 내기 전까지의 짐작. deploying 인데 실패·오류로 끝난 줄이 이전이 마지막으로 바뀐 때보다 먼저 만들어졌으면 지난 시도로 본다.
 */
export function isStaleRun(run: Pick<RehearsalRun, 'status' | 'createdAt'>, migration: Pick<MigrationView, 'status' | 'updatedAt'>): boolean {
  if (migration.status !== 'deploying' || !migration.updatedAt) return false;
  if (run.status !== 'failed' && run.status !== 'error') return false;
  return Date.parse(run.createdAt) < Date.parse(migration.updatedAt);
}

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

/** 진행 단계 카드 "앱 배포" 칸 오른쪽 한 마디. 줄이 없으면 붙이지 않는다. */
export function rehearsalStepDetail(run: RehearsalRun | null | undefined, stale = false): string | undefined {
  const state = rehearsalState(run, stale);
  switch (state) {
    case 'none':
      return undefined;
    case 'waiting':
    case 'stale':
      return '리허설 준비';
    case 'running':
      return '리허설 중';
    case 'passed':
      return '리허설 통과';
    case 'reused':
      return '리허설 재사용';
    case 'skipped':
      return '리허설 건너뜀';
    case 'failed':
    case 'error':
      return '리허설에서 멈춤';
  }
}

/** 리허설 카드 머리줄 오른쪽 요약. */
export function rehearsalSummary(run: RehearsalRun | null | undefined, stale = false): string {
  const state = rehearsalState(run, stale);
  if (state === 'running' && run?.phase) return `도는 중 · ${PHASE_LABEL[run.phase]}`;
  const SUMMARY: Record<RehearsalState, string> = {
    none: '아직 없음',
    waiting: '차례 기다림',
    running: '도는 중',
    passed: '통과',
    reused: '앞선 통과 재사용',
    skipped: '건너뜀',
    failed: '실패',
    error: '오류',
    stale: '새 시도 준비',
  };
  return SUMMARY[state];
}

/** 도는 동안의 단계. 이미지 복사는 워커, 나머지는 샌드박스 쪽이 한다. */
export function phaseEntries(run: Pick<RehearsalRun, 'status' | 'phase'>): ChecklistEntry[] {
  const at = run.status === 'queued' ? -1 : run.phase ? PHASES.indexOf(run.phase) : 0;
  const finished = run.phase === 'done' || run.status === 'passed';
  return PHASES.map((phase, index) => ({
    label: PHASE_LABEL[phase],
    status: finished || index < at ? 'done' : index === at ? 'active' : 'pending',
  }));
}

/** 검사 줄. 판정에 드는 실패를 먼저, 참고 줄은 뒤에. limit 을 넘으면 남은 수를 돌려준다. */
export function checkEntries(result: Pick<RehearsalResult, 'checks'>, limit = 8): { items: ChecklistEntry[]; more: number } {
  const rank = (check: RehearsalResult['checks'][number]) => (check.required ? (check.ok ? 1 : 0) : 2);
  const sorted = [...result.checks].sort((a, b) => rank(a) - rank(b));
  const items = sorted.slice(0, limit).map((check) => ({
    label: `${CHECK_LABEL[check.id] ?? check.id}${check.subject ? ` · ${check.subject}` : ''}${check.required ? '' : ' (참고)'}`,
    status: (check.ok ? 'done' : check.required ? 'failed' : 'paused') as ChecklistEntry['status'],
    detail: check.ok ? undefined : check.detail.slice(0, 80) || undefined,
  }));
  return { items, more: Math.max(0, sorted.length - limit) };
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
  const kernel = sandbox.runtimeClass ? `커널 분리(${sandbox.runtimeClass})` : '같은 커널, 전용 노드';
  return [kernel, `파드 보안 ${sandbox.podSecurity}`, sandbox.mock ? '흉내 샌드박스' : null].filter(Boolean).join(' · ');
}

/** 걸린 시간(초). 끝났으면 시작부터 끝까지, 도는 중이면 지금까지. */
export function elapsedSec(run: Pick<RehearsalRun, 'createdAt' | 'startedAt' | 'finishedAt'>, now = Date.now()): number {
  const start = Date.parse(run.startedAt ?? run.createdAt);
  const end = run.finishedAt ? Date.parse(run.finishedAt) : now;
  return Math.max(0, Math.round((end - start) / 1000));
}

/** 남은 기한(초). 기한이 없거나 끝난 줄이면 null. */
export function remainingSec(run: Pick<RehearsalRun, 'deadlineAt' | 'finishedAt'>, now = Date.now()): number | null {
  if (!run.deadlineAt || run.finishedAt) return null;
  return Math.max(0, Math.round((Date.parse(run.deadlineAt) - now) / 1000));
}

export const formatSec = (sec: number) => (sec < 60 ? `${sec}초` : `${Math.floor(sec / 60)}분 ${sec % 60}초`);

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
  if (state === 'running' || state === 'waiting')
    return `고객 클러스터에 올리기 전에 일회용 가상 클러스터에서 먼저 리허설하고 있습니다${run?.phase ? ` · ${PHASE_LABEL[run.phase]}` : ''}`;
  if (state === 'passed' || state === 'reused') return '리허설을 통과해 같은 매니페스트를 도착 클러스터에 올리고 있습니다';
  if (state === 'skipped' && run?.skip) return SKIP_TEXT[run.skip];
  if (state === 'stale') return '지난 리허설은 멈췄습니다. 새 샌드박스에서 처음부터 다시 돕니다';
  return null;
}
