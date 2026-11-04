import type { LedgerRow } from '../../lib/security-types';
import type { EnvironmentView, MigrationView, Provider } from '../../lib/types';

// 계정 화면의 판단. 시험은 test/settings-model.test.ts

/** 계정 화면 카드 순서. 등록한 환경이 없어도 네 카드를 다 보인다 */
export const PROVIDER_ORDER: Provider[] = ['aws', 'gcp', 'azure_mock', 'onprem'];

/** 환경을 벤더별로 묶는다. 이름 순 */
export function envsByProvider(envs: EnvironmentView[]): Record<Provider, EnvironmentView[]> {
  const out = { aws: [], gcp: [], azure_mock: [], onprem: [] } as Record<Provider, EnvironmentView[]>;
  for (const env of [...envs].sort((a, b) => a.name.localeCompare(b.name))) out[env.provider].push(env);
  return out;
}

export type Borrowed = { purpose: LedgerRow['purpose']; step: string | null; expiresAt: string; migrationId: string };

/**
 * 환경마다 지금 빌려 쓰는 임시 권한. 환경 단위 API 가 없어서 진행 중인 마이그레이션의 임시 권한 장부에서 고른다.
 * 장부 줄에는 환경이 없고 벤더만 있다. 한 마이그레이션의 출발·도착은 벤더가 달라서(같은 벤더 이전은 지원 범위 밖) 벤더로 환경을 가린다.
 * 같은 환경에 여러 줄이면 가장 늦게 끝나는 것 하나.
 */
export function borrowedByEnv(
  envs: Pick<EnvironmentView, 'id' | 'provider'>[],
  ledgers: { migration: Pick<MigrationView, 'id' | 'sourceEnvId' | 'targetEnvId'>; rows: LedgerRow[] }[],
  now = Date.now(),
): Record<string, Borrowed> {
  const out: Record<string, Borrowed> = {};
  for (const { migration, rows } of ledgers) {
    for (const row of rows) {
      if (row.status !== 'active' || row.expiredButActive || Date.parse(row.expiresAt) <= now) continue;
      const env = [migration.sourceEnvId, migration.targetEnvId]
        .map((id) => envs.find((item) => item.id === id))
        .find((item) => item?.provider === row.provider);
      if (!env) continue;
      const prev = out[env.id];
      if (!prev || Date.parse(row.expiresAt) > Date.parse(prev.expiresAt))
        out[env.id] = { purpose: row.purpose, step: row.step ?? row.stage, expiresAt: row.expiresAt, migrationId: migration.id };
    }
  }
  return out;
}

/** 남은 분 (올림). 1분 안이면 1 */
export const minutesLeft = (expiresAt: string, now = Date.now()) => Math.max(1, Math.ceil((Date.parse(expiresAt) - now) / 60_000));
