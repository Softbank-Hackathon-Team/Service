import { go } from '../../app/routes';
import type { BentoLayout } from '../../components/layout/ConsoleLayout';
import { ActionRow, FoldTile, Hero, Stack } from '../../components/layout/tiles';
import { ActionPill, BarPill } from '../../components/ui/controls';
import { api } from '../../lib/api';
import { anyMigration } from '../../lib/events';
import { errorText } from '../../lib/errors';
import { usePoll } from '../../lib/usePoll';
import { MigrationRow } from '../dashboard/DashboardPage';
import { groupMigrations, realMigrations, type MigrationBucket } from '../dashboard/model';
import { ShellLayout } from '../shell/ShellLayout';
import s from '../common/page.module.css';
import { t } from '../../lib/i18n';

const LAYOUT: BentoLayout = { columns: ['fill', 'side'], areas: 'hero list' };
// 히스토리는 끝난 기록이라 접어 둔다 (대시보드 히스토리 카드와 같음)
const BUCKETS: { id: MigrationBucket; label: string; defaultOpen: boolean }[] = [
  { id: 'human', label: t('검토 필요'), defaultOpen: true },
  { id: 'running', label: t('진행 중'), defaultOpen: true },
  { id: 'done', label: t('히스토리'), defaultOpen: false },
];

export function MigrationsPage() {
  const migrations = usePoll(api.listMigrations, 3_000, [], { signal: anyMigration });
  const envs = usePoll(api.listEnvironments, null, []);
  // 숨긴 환경이 낀 마이그레이션은 뺀다. 환경 목록을 읽기 전에는 빈 목록으로 둔다
  const visible = realMigrations(migrations.data ?? [], envs.data) ?? [];
  const groups = groupMigrations(visible, Number.POSITIVE_INFINITY);
  const envName = (id: string) => envs.data?.find((env) => env.id === id)?.name ?? id.slice(0, 8);
  const total = visible.length;
  const title = groups.human.length > 0
    ? t('검토가 필요한 마이그레이션이\n{0}건 있습니다', { 0: groups.human.length })
    : groups.running.length > 0
      ? t('{0}건이\n진행 중입니다', { 0: groups.running.length })
      : total > 0 ? t('진행 중인 마이그레이션이\n없습니다') : t('아직 마이그레이션이\n없습니다');
  return (
    <ShellLayout layout={LAYOUT}>
      <Hero tone="run" meta={t('마이그레이션')} step={String(total)} title={title} foot={t('최근 50건을 보여 줍니다. 끝난 마이그레이션은 감사 기록이라 지우지 않습니다')}>
        {migrations.error != null && !migrations.data && (
          <>
            <p className={`${s.error} t-body-md`}>{errorText(migrations.error)}</p>
            <BarPill label={t('다시 시도')} icon="refresh" onClick={() => void migrations.reload()} />
          </>
        )}
      </Hero>
      <Stack area="list">
        {BUCKETS.map(({ id, label, defaultOpen }) => (
          <FoldTile key={id} title={label} summary={t('{0}건', { 0: groups[id].length })} defaultOpen={defaultOpen}>
            {groups[id].length > 0 ? (
              <ul className={s.rows}>
                {groups[id].map((migration) => (
                  <MigrationRow key={migration.id} migration={migration} envName={envName} />
                ))}
              </ul>
            ) : (
              <p className={`${s.note} t-body-sm c-tertiary`}>{t('없습니다.')}</p>
            )}
          </FoldTile>
        ))}
        <ActionRow>
          <ActionPill label={t('새 마이그레이션 시작')} icon="plus" onClick={() => go('migrations/new')} />
        </ActionRow>
      </Stack>
    </ShellLayout>
  );
}
