import { go } from '../../app/routes';
import { api } from '../../lib/api';
import { anyMigration } from '../../lib/events';
import { isTerminal, LABEL } from '../../lib/status';
import type { MigrationView } from '../../lib/types';
import { usePoll } from '../../lib/usePoll';
import { realMigrations } from '../dashboard/model';
import s from '../common/page.module.css';
import { t } from '../../lib/i18n';

const byRecent = (a: MigrationView, b: MigrationView) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '');

/** 고른 번호가 없으면 진행 중인 이전 중 가장 최근 것, 없으면 가장 최근 것. */
export function chooseMigration(items: MigrationView[], id: string | null): MigrationView | null {
  if (id) return items.find((item) => item.id === id) ?? null;
  const sorted = [...items].sort(byRecent);
  return sorted.find((item) => !isTerminal(item.status)) ?? sorted[0] ?? null;
}

/** 이전 한 건 기준으로 보는 화면들이 함께 쓴다. 상단 바의 선택 칸까지 돌려준다. */
export function useChosenMigration(page: 'audit' | 'agent', id: string | null) {
  const migrations = usePoll(api.listMigrations, 5_000, [], { signal: anyMigration });
  const envs = usePoll(api.listEnvironments, null, []);
  const all = migrations.data ?? [];
  // 고르기 칸에는 숨긴 환경이 낀 이전을 빼고 보인다. 주소로 고른 번호는 숨긴 것이라도 그대로 연다
  const visible = realMigrations(all, envs.data) ?? all;
  const chosen = chooseMigration(id ? all : visible, id);
  const items = chosen && !visible.includes(chosen) ? [chosen, ...visible] : visible;
  const envName = (envId: string) => envs.data?.find((env) => env.id === envId)?.name ?? envId.slice(0, 8);
  const routeOf = (item: MigrationView) => `${envName(item.sourceEnvId)} → ${envName(item.targetEnvId)}`;
  const picker = items.length > 0 && (
    <select
      className={`${s.select} t-label-md`}
      aria-label={t('마이그레이션 고르기')}
      value={chosen?.id ?? ''}
      onChange={(event) => go(`${page}/${event.target.value}`)}
    >
      {items.map((item) => (
        <option key={item.id} value={item.id}>
          {routeOf(item)} · {LABEL[item.status]}
        </option>
      ))}
    </select>
  );
  return { chosen, picker, loading: migrations.loading, error: migrations.error, routeOf };
}
