import { useEffect, useRef, useState } from 'react';
import { withTransition } from '../../app/transition';
import { go } from '../../app/routes';
import type { BentoLayout } from '../../components/layout/ConsoleLayout';
import { ActionRow, FoldTile, Hero, Stack } from '../../components/layout/tiles';
import { ActionPill, Badge, BarPill } from '../../components/ui/controls';
import { Icon } from '../../components/ui/Icon';
import { api } from '../../lib/api';
import { anyMigration } from '../../lib/events';
import { connectionReasonText } from '../../lib/failure';
import { isApiDown } from '../../lib/http';
import { CONN_LABEL, LABEL, PROVIDER_SHORT, progressPct } from '../../lib/status';
import type { EnvironmentView, MigrationView } from '../../lib/types';
import { usePoll } from '../../lib/usePoll';
import {
  bucketOf,
  bucketSignature,
  envHeadline,
  fromInventory,
  fromStatus,
  groupMigrations,
  humanAction,
  listNote,
  realEnvs,
  statusBadge,
  type EnvObservation,
  type Health,
  type MigrationBucket,
} from './model';
import { ShellLayout } from '../shell/ShellLayout';
import s from './DashboardPage.module.css';
import { t } from '../../lib/i18n';

const DASHBOARD: BentoLayout = { columns: ['fill', 'side'], areas: 'hero migrations' };

const HEALTH: Record<Health, { label: string; tone: 'success' | 'warning' | 'neutral' }> = {
  healthy: { label: t('정상'), tone: 'success' },
  degraded: { label: t('불안정'), tone: 'warning' },
  unknown: { label: t('확인 불가'), tone: 'neutral' },
};

// 검토를 기다리는 마이그레이션도 진행 중이다(사람 검토 때문에 멈춰 있을 뿐). 그래서 한 카드에 두고, 검토가 필요한 줄을 위에 둔다
const CARDS: { id: 'active' | 'done'; label: string; buckets: MigrationBucket[]; defaultOpen: boolean }[] = [
  { id: 'active', label: t('진행 중'), buckets: ['human', 'running'], defaultOpen: true },
  { id: 'done', label: t('히스토리'), buckets: ['done'], defaultOpen: false },
];

async function observe(env: EnvironmentView): Promise<EnvObservation> {
  const status = await api.envStatus(env.id).catch((reason: unknown) => {
    if (isApiDown(reason)) throw reason;
    return null;
  });
  if (status && (status.mock || status.health !== 'unknown' || status.resources.length > 0)) return fromStatus(status);
  return fromInventory((await api.envInventory(env.id)).cloud);
}

function EnvRow({ env, seen }: { env: EnvironmentView; seen: EnvObservation | undefined }) {
  const connected = env.connectionStatus === 'connected';
  const problem = connected ? seen?.problem : connectionReasonText(env.failureReason);
  const detail = !seen ? (connected ? t('확인 중') : null) : seen.health === 'unknown' ? null : [t('자원 {0}개', { 0: seen.resources }), seen.region].filter(Boolean).join(' · ');
  return (
    <li>
      <button type="button" className={s.envRow} onClick={() => go(`environments/${env.id}`)}>
      <div className={s.envHead}>
        <span className={s.envName}>
          <Icon name={env.provider === 'onprem' ? 'server' : 'cloud'} />
          <span className="t-h3">{env.name}</span>
          <span className="t-caption c-tertiary">{PROVIDER_SHORT[env.provider]}</span>
        </span>
        <span className={s.badges}>
          <Badge tone={connected ? 'neutral' : 'danger'}>{CONN_LABEL[env.connectionStatus]}</Badge>
          {connected && seen && <Badge tone={HEALTH[seen.health].tone}>{HEALTH[seen.health].label}</Badge>}
          {seen?.mock && <Badge>{t('모의')}</Badge>}
        </span>
      </div>
      {detail && <p className="t-body-sm c-secondary">{detail}</p>}
      {problem && <p className={`t-body-sm ${seen?.health === 'unknown' ? 'c-secondary' : 'c-warning'}`}>{problem}</p>}
      </button>
    </li>
  );
}

/** reviewTag: 검토를 기다리는 줄 제목 옆에 작은 회색 "검토 필요" 표시 (진행 중과 섞어 보여 주는 대시보드용) */
export function MigrationRow({ migration, envName, reviewTag = false }: { migration: MigrationView; envName: (id: string) => string; reviewTag?: boolean }) {
  const action = humanAction(migration.status);
  // 검토를 기다리는 줄도 진행 중이라 진행 막대를 보인다. 어느 칸에서 멈췄는지 모르면(목록에 멈춘 칸이 없을 때) 0% 로 오해하지 않게 그리지 않는다
  const pct = bucketOf(migration) !== 'done' ? progressPct(migration) : 0;
  const running = pct > 0;
  return (
    <li style={{ viewTransitionName: `migration-${migration.id}` }}>
      <button type="button" className={s.migrationRow} onClick={() => go(`migrations/${migration.id}`)}>
        <span className={s.migrationText}>
          <span className={s.titleRow}>
            <span className="t-label-md">{action ?? LABEL[migration.status]}</span>
            {reviewTag && bucketOf(migration) === 'human' && <span className={`${s.reviewTag} t-caption`}>{t('검토 필요')}</span>}
          </span>
          <span className="t-caption c-tertiary">
            {envName(migration.sourceEnvId)} → {envName(migration.targetEnvId)}
          </span>
          {running && (
            <span className={s.progress} aria-hidden="true">
              <span style={{ width: `${pct}%` }} />
            </span>
          )}
        </span>
        <span className={s.badges}>
          {action && <Badge tone={statusBadge(migration.status)}>{LABEL[migration.status]}</Badge>}
          <Icon name="chevron" />
        </span>
      </button>
    </li>
  );
}

export function DashboardPage() {
  const envs = usePoll(api.listEnvironments, 10_000, []);
  const migrations = usePoll(api.listMigrations, 3_000, [], { signal: anyMigration });
  const list = realEnvs(envs.data ?? []);
  const key = list.filter((env) => env.connectionStatus === 'connected').map((env) => env.id).join(',');
  const observed = usePoll(
    async () => {
      const connected = list.filter((env) => env.connectionStatus === 'connected');
      const results = await Promise.all(
        connected.map(async (env) => [env.id, await observe(env).catch(() => null)] as const),
      );
      return Object.fromEntries(results.filter((entry): entry is [string, EnvObservation] => entry[1] !== null));
    },
    15_000,
    [key],
  );

  // 줄이 다른 묶음으로 옮겨 갈 때만 전환을 걸어, 3초마다 읽을 때 화면이 흔들리지 않게 한다.
  const [shown, setShown] = useState<MigrationView[]>([]);
  const shownSignature = useRef('');
  useEffect(() => {
    const next = migrations.data;
    if (!next) return;
    const signature = bucketSignature(next);
    const moved = shownSignature.current !== '' && shownSignature.current !== signature;
    shownSignature.current = signature;
    if (moved) withTransition(() => setShown(next));
    else setShown(next);
  }, [migrations.data]);

  const groups = groupMigrations(shown);
  const note = listNote(groups);
  const envName = (id: string) => envs.data?.find((env) => env.id === id)?.name ?? id.slice(0, 8);
  const seen = observed.data ?? {};
  const loadingEnvs = envs.loading && !envs.data;

  return (
    <ShellLayout layout={DASHBOARD}>
      <Hero
        tone="run"
        meta={t('현재 환경')}
        step={String(list.length)}
        title={
          loadingEnvs
            ? t('환경을\n확인하고 있습니다')
            : envs.error && !envs.data
              ? t('환경을\n읽지 못했습니다')
              : envHeadline(list, seen)
        }
      >
        {envs.error && !envs.data ? (
          <BarPill label={t('다시 시도')} icon="refresh" onClick={() => void envs.reload()} />
        ) : (
          list.length > 0 && (
            <ul className={`${s.envList} scroll-fade`}>
              {list.map((env) => (
                <EnvRow key={env.id} env={env} seen={seen[env.id]} />
              ))}
            </ul>
          )
        )}
      </Hero>
      <Stack area="migrations">
        {migrations.error && !migrations.data ? (
          <FoldTile title={t('마이그레이션 목록')}>
            <div className={s.listError}>
              <p className="t-body-md c-secondary">{t('마이그레이션 목록을 읽지 못했습니다.')}</p>
              <BarPill label={t('다시 시도')} icon="refresh" onClick={() => void migrations.reload()} />
            </div>
          </FoldTile>
        ) : (
          CARDS.map(({ id, label, buckets, defaultOpen }) => {
            const items = buckets.flatMap((bucket) => groups[bucket]);
            return (
              <FoldTile key={id} title={label} summary={t('{0}건', { 0: items.length })} defaultOpen={defaultOpen}>
                {items.length > 0 ? (
                  <ul className={s.migrationList}>
                    {items.map((migration) => (
                      <MigrationRow key={migration.id} migration={migration} envName={envName} reviewTag />
                    ))}
                  </ul>
                ) : (
                  <p className={`${s.empty} t-body-sm c-tertiary`}>
                    {id === 'active' ? ((migrations.data && note) || t('돌아가는 마이그레이션이 없습니다.')) : t('아직 없습니다.')}
                  </p>
                )}
              </FoldTile>
            );
          })
        )}
        <ActionRow>
          <ActionPill label={t('새 마이그레이션 시작')} icon="plus" onClick={() => go('migrations/new')} />
        </ActionRow>
      </Stack>
    </ShellLayout>
  );
}
