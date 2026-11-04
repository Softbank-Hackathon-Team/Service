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

const DASHBOARD: BentoLayout = { columns: ['fill', 'side'], areas: 'hero migrations' };

const HEALTH: Record<Health, { label: string; tone: 'success' | 'warning' | 'neutral' }> = {
  healthy: { label: '정상', tone: 'success' },
  degraded: { label: '불안정', tone: 'warning' },
  unknown: { label: '확인 불가', tone: 'neutral' },
};

const BUCKETS: { id: MigrationBucket; label: string; defaultOpen: boolean }[] = [
  { id: 'human', label: '검토 필요', defaultOpen: true },
  { id: 'running', label: '진행 중', defaultOpen: true },
  { id: 'done', label: '히스토리', defaultOpen: false },
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
  const detail = !seen ? (connected ? '확인 중' : null) : seen.health === 'unknown' ? null : [`자원 ${seen.resources}개`, seen.region].filter(Boolean).join(' · ');
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
          {seen?.mock && <Badge>모의</Badge>}
        </span>
      </div>
      {detail && <p className="t-body-sm c-secondary">{detail}</p>}
      {problem && <p className={`t-body-sm ${seen?.health === 'unknown' ? 'c-secondary' : 'c-warning'}`}>{problem}</p>}
      </button>
    </li>
  );
}

export function MigrationRow({ migration, envName }: { migration: MigrationView; envName: (id: string) => string }) {
  const action = humanAction(migration.status);
  const running = bucketOf(migration) === 'running';
  return (
    <li style={{ viewTransitionName: `migration-${migration.id}` }}>
      <button type="button" className={s.migrationRow} onClick={() => go(`migrations/${migration.id}`)}>
        <span className={s.migrationText}>
          <span className="t-label-md">{action ?? LABEL[migration.status]}</span>
          <span className="t-caption c-tertiary">
            {envName(migration.sourceEnvId)} → {envName(migration.targetEnvId)}
          </span>
          {running && (
            <span className={s.progress} aria-hidden="true">
              <span style={{ width: `${progressPct(migration)}%` }} />
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
        meta="현재 환경"
        step={String(list.length)}
        title={
          loadingEnvs
            ? '환경을\n확인하고 있습니다'
            : envs.error && !envs.data
              ? '환경을\n읽지 못했습니다'
              : envHeadline(list, seen)
        }
      >
        {envs.error && !envs.data ? (
          <BarPill label="다시 시도" icon="refresh" onClick={() => void envs.reload()} />
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
          <FoldTile title="이전 목록">
            <div className={s.listError}>
              <p className="t-body-md c-secondary">이전 목록을 읽지 못했습니다.</p>
              <BarPill label="다시 시도" icon="refresh" onClick={() => void migrations.reload()} />
            </div>
          </FoldTile>
        ) : (
          BUCKETS.map(({ id, label, defaultOpen }) => (
            <FoldTile key={id} title={label} summary={`${groups[id].length}건`} defaultOpen={defaultOpen}>
              {groups[id].length > 0 ? (
                <ul className={s.migrationList}>
                  {groups[id].map((migration) => (
                    <MigrationRow key={migration.id} migration={migration} envName={envName} />
                  ))}
                </ul>
              ) : (
                <p className={`${s.empty} t-body-sm c-tertiary`}>
                  {(id === 'human' && migrations.data && note) || (id === 'running' ? '돌아가는 이전이 없습니다.' : '아직 없습니다.')}
                </p>
              )}
            </FoldTile>
          ))
        )}
        <ActionRow>
          <ActionPill label="새 이전 시작" icon="plus" onClick={() => go('migrations/new')} />
        </ActionRow>
      </Stack>
    </ShellLayout>
  );
}
