import { go } from '../../app/routes';
import type { BentoLayout } from '../../components/layout/ConsoleLayout';
import { ActionRow, FoldTile, Hero, Stack } from '../../components/layout/tiles';
import { ActionPill, BarPill } from '../../components/ui/controls';
import { api } from '../../lib/api';
import { anyMigration } from '../../lib/events';
import { errorText } from '../../lib/errors';
import { usePoll } from '../../lib/usePoll';
import { MigrationRow } from '../dashboard/DashboardPage';
import { groupMigrations, type MigrationBucket } from '../dashboard/model';
import { ShellLayout } from '../shell/ShellLayout';
import s from '../common/page.module.css';

const LAYOUT: BentoLayout = { columns: ['fill', 'side'], areas: 'hero list' };
const BUCKETS: { id: MigrationBucket; label: string }[] = [
  { id: 'human', label: '검토 필요' },
  { id: 'running', label: '진행 중' },
  { id: 'done', label: '끝남' },
];

export function MigrationsPage() {
  const migrations = usePoll(api.listMigrations, 3_000, [], { signal: anyMigration });
  const envs = usePoll(api.listEnvironments, null, []);
  const groups = groupMigrations(migrations.data ?? [], Number.POSITIVE_INFINITY);
  const envName = (id: string) => envs.data?.find((env) => env.id === id)?.name ?? id.slice(0, 8);
  const total = migrations.data?.length ?? 0;
  const title = groups.human.length > 0
    ? `검토가 필요한 이전이\n${groups.human.length}건 있습니다`
    : groups.running.length > 0
      ? `${groups.running.length}건이\n진행 중입니다`
      : total > 0 ? '진행 중인 이전이\n없습니다' : '아직 이전이\n없습니다';
  return (
    <ShellLayout layout={LAYOUT}>
      <Hero tone="run" meta="이전" step={String(total)} title={title} foot="최근 50건을 보여 줍니다. 끝난 이전은 감사 기록이라 지우지 않습니다">
        {migrations.error != null && !migrations.data && (
          <>
            <p className={`${s.error} t-body-md`}>{errorText(migrations.error)}</p>
            <BarPill label="다시 시도" icon="refresh" onClick={() => void migrations.reload()} />
          </>
        )}
      </Hero>
      <Stack area="list">
        {BUCKETS.map(({ id, label }) => (
          <FoldTile key={id} title={label} summary={`${groups[id].length}건`}>
            {groups[id].length > 0 ? (
              <ul className={s.rows}>
                {groups[id].map((migration) => (
                  <MigrationRow key={migration.id} migration={migration} envName={envName} />
                ))}
              </ul>
            ) : (
              <p className={`${s.note} t-body-sm c-tertiary`}>없습니다.</p>
            )}
          </FoldTile>
        ))}
        <ActionRow>
          <ActionPill label="새 이전 시작" icon="plus" onClick={() => go('migrations/new')} />
        </ActionRow>
      </Stack>
    </ShellLayout>
  );
}
