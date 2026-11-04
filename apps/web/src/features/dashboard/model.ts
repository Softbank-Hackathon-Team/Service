import type { ResourceCategory } from '../../lib/resourceMap';
import { HUMAN_STEP, HUMAN_WAIT, isTerminal, toneOf, type Tone } from '../../lib/status';
import type { EnvironmentView, EnvStatus, MigrationStatus, MigrationView } from '../../lib/types';

export type Health = EnvStatus['health'];
export type BadgeTone = 'neutral' | 'warning' | 'success' | 'info' | 'danger';

/** GET /environments/:id/inventory 중 건강을 세는 데 쓰는 칸. */
export type CloudInventory = {
  status: 'ok' | 'partial' | 'unavailable';
  reason: string | null;
  source: string;
  region: string | null;
  groups: {
    category?: ResourceCategory;
    service?: string;
    error?: string | null;
    items: { name: string; status: string | null; detail?: string | null }[];
  }[];
};

export type EnvObservation = {
  health: Health;
  mock: boolean;
  resources: number;
  region: string | null;
  problem: string | null;
};

const BAD_STATUS = /fail|error|notready|unhealthy|crashloop|suspend|stopp|terminat|degrad/i;
const TEST_ENV = /^(load|e2e|test|tmp)-/i;

export const realEnvs = (envs: EnvironmentView[]) => envs.filter((env) => !TEST_ENV.test(env.name));

export const fromStatus = (status: EnvStatus): EnvObservation => ({
  health: status.health,
  mock: status.mock,
  resources: status.resources.length,
  region: status.region,
  problem: status.health === 'degraded' ? '자원 상태가 불안정합니다' : null,
});

export function fromInventory(cloud: CloudInventory): EnvObservation {
  const items = cloud.groups.flatMap((group) => group.items);
  const bad = items.filter((item) => item.status && BAD_STATUS.test(item.status));
  const health: Health =
    cloud.status === 'unavailable' ? 'unknown' : cloud.status === 'partial' || bad.length > 0 ? 'degraded' : 'healthy';
  const first = bad[0];
  const problem =
    cloud.status === 'unavailable'
      ? (cloud.reason ?? '자원을 읽지 못했습니다')
      : first
        ? `${first.name} ${first.status}${bad.length > 1 ? ` 외 ${bad.length - 1}개` : ''}`
        : cloud.status === 'partial'
          ? (cloud.reason ?? '일부만 읽었습니다')
          : null;
  return { health, mock: cloud.source === 'azure-mock', resources: items.length, region: cloud.region, problem };
}

const needsLook = (env: EnvironmentView, seen: EnvObservation | undefined) =>
  env.connectionStatus !== 'connected' || seen?.health !== 'healthy';

export function envHeadline(envs: EnvironmentView[], observed: Record<string, EnvObservation>): string {
  if (envs.length === 0) return '연결된 환경이\n없습니다';
  const issues = envs.filter((env) => needsLook(env, observed[env.id])).length;
  return issues > 0 ? `환경 ${envs.length}개 중\n${issues}개를 확인해 주세요` : `환경 ${envs.length}개가\n정상입니다`;
}

export type MigrationBucket = 'human' | 'running' | 'done';

export const bucketOf = ({ status }: Pick<MigrationView, 'status'>): MigrationBucket =>
  isTerminal(status) ? 'done' : HUMAN_STEP.includes(status) || HUMAN_WAIT.includes(status) ? 'human' : 'running';

const DONE_LIMIT = 5;
const byRecent = (a: MigrationView, b: MigrationView) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '');

export function groupMigrations(items: MigrationView[], doneLimit = DONE_LIMIT): Record<MigrationBucket, MigrationView[]> {
  const sorted = [...items].sort(byRecent);
  return {
    human: sorted.filter((item) => bucketOf(item) === 'human'),
    running: sorted.filter((item) => bucketOf(item) === 'running'),
    done: sorted.filter((item) => bucketOf(item) === 'done').slice(0, doneLimit),
  };
}

/** 줄이 어느 묶음으로 옮겨 갔는지 비교하는 값. 달라지면 줄을 움직인다. */
export const bucketSignature = (items: MigrationView[]) =>
  items.map((item) => `${item.id}:${bucketOf(item)}`).sort().join('|');

/** 큰 소식이 없을 때 목록 맨 위에 쓰는 한 줄. 검토가 필요한 이전이 있으면 쓰지 않는다. */
export function listNote(groups: Record<MigrationBucket, MigrationView[]>): string | null {
  if (groups.human.length > 0) return null;
  if (groups.running.length > 0) return '지금 사람이 할 일은 없습니다.';
  return groups.done.length > 0 ? '진행 중인 마이그레이션이 없습니다.' : '아직 마이그레이션이 없습니다. 새 마이그레이션을 시작해 보세요.';
}

const HUMAN_ACTION: Partial<Record<MigrationStatus, string>> = {
  spec_review: '명세 확정',
  awaiting_approval: '계획 승인',
  approved: '실행 다시 시작',
  paused: '멈춘 마이그레이션 확인',
  failed: '실패 확인',
  rejected: '거절된 계획 처리',
  stale: '낡은 계획 처리',
};

export const humanAction = (status: MigrationStatus) => HUMAN_ACTION[status] ?? null;

const BADGE_OF: Record<Tone, BadgeTone> = { run: 'info', wait: 'warning', bad: 'danger', done: 'success', ok: 'success' };
export const statusBadge = (status: MigrationStatus): BadgeTone => BADGE_OF[toneOf(status)];
