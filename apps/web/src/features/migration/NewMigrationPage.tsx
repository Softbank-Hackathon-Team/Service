import { useState } from 'react';
import { go } from '../../app/routes';
import { withTransition } from '../../app/transition';
import type { BentoLayout } from '../../components/layout/ConsoleLayout';
import { ActionRow, FoldTile, Hero, Stack } from '../../components/layout/tiles';
import { Checklist, type ChecklistEntry } from '../../components/ui/Checklist';
import { ActionPill, Badge, BarPill } from '../../components/ui/controls';
import { Icon } from '../../components/ui/Icon';
import { api } from '../../lib/api';
import { errorText } from '../../lib/errors';
import { CATEGORY_LABEL } from '../../lib/resourceMap';
import { CONN_LABEL, PROVIDER_SHORT } from '../../lib/status';
import type { EnvironmentView } from '../../lib/types';
import { usePoll } from '../../lib/usePoll';
import { realEnvs, type CloudInventory } from '../dashboard/model';
import { ShellLayout } from '../shell/ShellLayout';
import { canPick } from './model';
import s from '../common/page.module.css';

// 출발을 고르기 전에도 칸은 그대로 두고, 고른 뒤에 찾은 자원이 오른쪽 칸을 채운다.
const LAYOUT: BentoLayout = { columns: ['fill', 'side'], areas: 'hero found' };

/** 이전을 만드는 순서. 근거 칸 맨 위에 두어 고르는 내내 지금 몇 번째인지 보인다. */
function CreateSteps({ source, reading, target }: { source?: string; reading?: boolean; target?: string }) {
  const items: ChecklistEntry[] = [
    { status: source ? 'done' : 'waiting', label: '출발 고르기', detail: source },
    { status: !source ? 'pending' : reading ? 'active' : 'done', label: '찾은 자원 확인' },
    { status: !source ? 'pending' : target ? 'done' : 'waiting', label: '도착 고르기', detail: target },
  ];
  const current = items.findIndex((item) => item.status !== 'done');
  return (
    <FoldTile title="새 이전" summary={`${current === -1 ? items.length : current + 1}/${items.length}`}>
      <div className={s.agent}>
        <Checklist items={items} />
      </div>
    </FoldTile>
  );
}

function EnvPick({ env, selected, disabled, onPick }: { env: EnvironmentView; selected?: boolean; disabled: boolean; onPick: () => void }) {
  const connected = env.connectionStatus === 'connected';
  return (
    <button
      type="button"
      aria-pressed={selected}
      disabled={disabled}
      className={`${s.pickRow} ${selected ? s.pickSelected : ''}`}
      onClick={onPick}
      style={{ viewTransitionName: `env-${env.id}` }}
    >
      <span className={s.pickName}>
        <Icon name={env.provider === 'onprem' ? 'server' : 'cloud'} />
        <span className="t-h3">{env.name}</span>
        <span className="t-caption">{PROVIDER_SHORT[env.provider]}</span>
      </span>
      {!connected && <Badge tone="danger">{CONN_LABEL[env.connectionStatus]}</Badge>}
    </button>
  );
}

export function FoundResources({ cloud }: { cloud: CloudInventory }) {
  if (cloud.status === 'unavailable') {
    return (
      <FoldTile title="찾은 자원" summary="읽지 못함">
        <p className={`${s.note} t-body-sm c-secondary`}>{cloud.reason ?? '자원을 읽지 못했습니다.'} 이전을 만들면 다시 읽습니다.</p>
      </FoldTile>
    );
  }
  return (
    <>
      {cloud.groups.filter((group) => group.items.length > 0 || group.error).map((group, index) => (
        <FoldTile
          key={`${group.category ?? ''}-${index}`}
          title={group.category ? CATEGORY_LABEL[group.category] : (group.service ?? '자원')}
          summary={group.error ? '읽지 못함' : `${group.items.length}개`}
        >
          {group.error ? (
            <p className={`${s.note} t-body-sm c-warning`}>{group.error}</p>
          ) : (
            <ul className={s.rows}>
              {group.items.map((item) => (
                <li key={item.name} className={s.row}>
                  <span className="t-label-md">{item.name}</span>
                  <span className="t-caption c-tertiary">{item.status ?? ''}</span>
                </li>
              ))}
            </ul>
          )}
        </FoldTile>
      ))}
    </>
  );
}

export function NewMigrationPage() {
  const envs = usePoll(api.listEnvironments, 10_000, []);
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [targetId, setTargetId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const list = realEnvs(envs.data ?? []);
  const source = list.find((env) => env.id === sourceId);
  const inventory = usePoll(sourceId ? () => api.envInventory(sourceId) : null, null, [sourceId]);

  if (!source) {
    const empty = !envs.loading && list.length === 0;
    return (
      <ShellLayout layout={LAYOUT}>
        <Hero tone="run" meta="새 이전" title={empty ? '연결된 환경이\n없습니다' : '어디에서\n옮길까요?'}>
          {envs.error != null && !envs.data && <p className={`${s.error} t-body-md`}>{errorText(envs.error)}</p>}
          <div className={s.pickList}>
            {list.map((env) => (
              <EnvPick key={env.id} env={env} disabled={!canPick(env)} onPick={() => withTransition(() => setSourceId(env.id))} />
            ))}
          </div>
        </Hero>
        <Stack area="found">
          <CreateSteps />
        </Stack>
      </ShellLayout>
    );
  }

  const create = async () => {
    if (!targetId) return;
    setBusy(true);
    setError(null);
    try {
      const { id } = await api.createMigration(source.id, targetId);
      go(`migrations/${id}`);
    } catch (reason) {
      setError(errorText(reason));
      setBusy(false);
    }
  };
  const target = list.find((env) => env.id === targetId);

  return (
    <ShellLayout
      layout={LAYOUT}
      barLeft={
        <BarPill
          label={`${source.name}에서 출발 · 다시 고르기`}
          onClick={() =>
            withTransition(() => {
              setSourceId(null);
              setTargetId(null);
              setError(null);
            })
          }
        />
      }
    >
      <Hero tone="run" meta={`${source.name}에서 출발`} title="어디로 옮길까요?">
        <div className={s.pickList}>
          {list.filter((env) => env.id !== source.id).map((env) => (
            <EnvPick key={env.id} env={env} selected={env.id === targetId} disabled={!canPick(env, source.id)} onPick={() => setTargetId(env.id)} />
          ))}
        </div>
      </Hero>
      <Stack area="found">
        <CreateSteps source={source.name} reading={inventory.loading} target={target?.name} />
        {inventory.loading ? (
          <FoldTile title="찾은 자원" summary="읽는 중">
            <p className={`${s.note} t-body-sm c-secondary`}>{source.name}의 자원을 읽고 있습니다.</p>
          </FoldTile>
        ) : inventory.data ? (
          <FoundResources cloud={inventory.data.cloud} />
        ) : (
          <FoldTile title="찾은 자원" summary="읽지 못함">
            <p className={`${s.note} t-body-sm c-secondary`}>{errorText(inventory.error)} 이전을 만들면 다시 읽습니다.</p>
          </FoldTile>
        )}
        <ActionRow notice={error}>
          <ActionPill
            label={busy ? '만드는 중' : target ? `${target.name}로 옮기기` : '도착지를 고르세요'}
            disabled={!target || busy}
            onClick={() => void create()}
          />
        </ActionRow>
      </Stack>
    </ShellLayout>
  );
}
