import type { LedgerRow } from '../../lib/security-types';
import type { EnvironmentView, MigrationView, Provider } from '../../lib/types';

// 계정 화면의 판단. 시험은 test/settings-model.test.ts

/** 계정 화면 카드 순서. 그 벤더에 연결을 마친 환경이 있을 때만 카드가 뜬다 */
export const PROVIDER_ORDER: Provider[] = ['aws', 'gcp', 'azure_mock', 'onprem'];

/**
 * 역할 부여(연결 확인 또는 온프레 Agent 접속)를 마친 환경. 계정 화면은 이것만 보인다.
 * 그 앞 단계(초안·고객 작업 대기·확인 중·실패·링크 만료)는 등록을 끝내지 않은 것이라 보이지 않고, 해제(disconnected)는 끝난 것이라 보이지 않는다
 */
export const isLinked = (env: Pick<EnvironmentView, 'connectionStatus'>) => env.connectionStatus === 'connected' || env.connectionStatus === 'unstable';

/** 환경을 벤더별로 묶는다. 이름 순 */
export function envsByProvider(envs: EnvironmentView[]): Record<Provider, EnvironmentView[]> {
  const out = { aws: [], gcp: [], azure_mock: [], onprem: [] } as Record<Provider, EnvironmentView[]>;
  for (const env of [...envs].sort((a, b) => a.name.localeCompare(b.name))) out[env.provider].push(env);
  return out;
}

export type Borrowed = { purpose: LedgerRow['purpose']; step: string | null; expiresAt: string; migrationId: string; expired: boolean };

const isLive = (row: LedgerRow, now: number) => row.status === 'active' && !row.expiredButActive && Date.parse(row.expiresAt) > now;
const isReturned = (row: LedgerRow) => row.status === 'revoked' || row.status === 'revoke_requested';

/**
 * 환경마다 빌린 임시 권한. 환경 단위 API 가 없어서 진행 중인 마이그레이션의 임시 권한 장부에서 고른다.
 * 장부 줄에는 환경이 없고 벤더만 있다. 한 마이그레이션의 출발·도착은 벤더가 달라서(같은 벤더 이전은 지원 범위 밖) 벤더로 환경을 가린다.
 * 살아 있는 줄이 있으면 가장 늦게 끝나는 것. 없으면 가장 최근에 빌린 줄이 만료된 것인지 본다 (다 쓰고 돌려준 줄이면 빌린 권한 없음)
 */
export function borrowedByEnv(
  envs: Pick<EnvironmentView, 'id' | 'provider'>[],
  ledgers: { migration: Pick<MigrationView, 'id' | 'sourceEnvId' | 'targetEnvId'>; rows: LedgerRow[] }[],
  now = Date.now(),
): Record<string, Borrowed> {
  const byEnv = new Map<string, { row: LedgerRow; migrationId: string }[]>();
  for (const { migration, rows } of ledgers) {
    for (const row of rows) {
      const env = [migration.sourceEnvId, migration.targetEnvId]
        .map((id) => envs.find((item) => item.id === id))
        .find((item) => item?.provider === row.provider);
      if (env) byEnv.set(env.id, [...(byEnv.get(env.id) ?? []), { row, migrationId: migration.id }]);
    }
  }
  const out: Record<string, Borrowed> = {};
  for (const [envId, rows] of byEnv) {
    const latest = (list: typeof rows, at: (row: LedgerRow) => string) =>
      list.reduce<(typeof rows)[number] | undefined>((best, item) => (!best || Date.parse(at(item.row)) > Date.parse(at(best.row)) ? item : best), undefined);
    const live = latest(rows.filter((item) => isLive(item.row, now)), (row) => row.expiresAt);
    const pick = live ?? latest(rows, (row) => row.issuedAt);
    if (!pick || (!live && isReturned(pick.row))) continue;
    const { row, migrationId } = pick;
    out[envId] = { purpose: row.purpose, step: row.step ?? row.stage, expiresAt: row.expiresAt, migrationId, expired: !live };
  }
  return out;
}

const SOON_MS = 60_000;
/** 빌린 권한 칸의 모습: 남은 분 / 곧 만료 (1분 이하) / 만료 (갱신 버튼). 분은 내림이라 실제보다 길게 말하지 않는다 */
export type BorrowState = { kind: 'left'; minutes: number } | { kind: 'soon' } | { kind: 'expired' };
export function borrowState(borrowed: Pick<Borrowed, 'expiresAt' | 'expired'>, now = Date.now()): BorrowState {
  const ms = Date.parse(borrowed.expiresAt) - now;
  if (borrowed.expired || ms <= 0) return { kind: 'expired' };
  if (ms <= SOON_MS) return { kind: 'soon' };
  return { kind: 'left', minutes: Math.floor(ms / 60_000) };
}
