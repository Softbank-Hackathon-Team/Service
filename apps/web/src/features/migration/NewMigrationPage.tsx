import { useState } from 'react';
import { go } from '../../app/routes';
import { withTransition } from '../../app/transition';
import type { BentoLayout } from '../../components/layout/ConsoleLayout';
import { ActionRow, FoldTile, Hero, Stack } from '../../components/layout/tiles';
import { Checklist, type ChecklistEntry } from '../../components/ui/Checklist';
import { ActionPill } from '../../components/ui/controls';
import { Field } from '../../components/ui/Field';
import { Icon } from '../../components/ui/Icon';
import { api } from '../../lib/api';
import { errorText } from '../../lib/errors';
import { CATEGORY_LABEL } from '../../lib/resourceMap';
import type { EnvironmentView } from '../../lib/types';
import { usePoll } from '../../lib/usePoll';
import { realEnvs, type CloudInventory } from '../dashboard/model';
import { RegisterEnvEntry } from '../environments/EnvEntry';
import { ShellLayout } from '../shell/ShellLayout';
import {
  AUTO_SCOPE,
  borrowNote,
  checkScopeInput,
  scopeChoices,
  scopeLabel,
  scopeSummary,
  softwareOf,
  softwareTitle,
  targetOptions,
  vendorLine,
  type ScopeChoice,
  type ScopeInput,
} from './source';
import s from '../common/page.module.css';
import { t } from '../../lib/i18n';

// 출발을 고르기 전에도 칸은 그대로 두고, 고른 뒤에 찾은 자원과 빌릴 권한이 오른쪽 칸을 채운다.
const LAYOUT: BentoLayout = { columns: ['fill', 'side'], areas: 'hero found' };

/**
 * 이전을 만드는 세 질문. 근거 칸 맨 위에 두어 지금 몇 번째인지 보인다.
 * 연결된 환경(빌려 올 계정) → 그 안에서 서비스 중인 것(출발 범위) → 옮겨 갈 환경(빌려 올 실행 권한).
 */
function CreateSteps({ source, reading, scope, target }: { source?: string; reading?: boolean; scope?: string; target?: string }) {
  const items: ChecklistEntry[] = [
    { status: source ? 'done' : 'waiting', label: t('출발 환경'), detail: source },
    { status: !source ? 'pending' : scope ? 'done' : reading ? 'active' : 'waiting', label: t('옮길 서비스'), detail: scope },
    { status: !scope ? 'pending' : target ? 'done' : 'waiting', label: t('도착 환경'), detail: target },
  ];
  const current = items.findIndex((item) => item.status !== 'done');
  return (
    <FoldTile title={t('새 마이그레이션')} summary={`${current === -1 ? items.length : current + 1}/${items.length}`}>
      <div className={s.agent}>
        <Checklist items={items} />
      </div>
    </FoldTile>
  );
}

type PickRowProps = {
  icon: 'cloud' | 'server' | 'list';
  title: string;
  caption: string;
  warn?: boolean;
  selected?: boolean;
  label?: string;
  onPick: () => void;
  transitionName?: string;
};

/** 고르는 줄 하나: 위는 무엇, 아래는 어디와 상태. */
function PickRow({ icon, title, caption, warn, selected, label, onPick, transitionName }: PickRowProps) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      aria-label={label}
      className={`${s.pickRow} ${selected ? s.pickSelected : ''}`}
      onClick={onPick}
      style={transitionName ? { viewTransitionName: transitionName } : undefined}
    >
      <span className={s.pickName}>
        <Icon name={icon} />
        <span className={s.pickText}>
          <span className="t-h3">{title}</span>
          <span className={`t-caption ${warn ? 'c-warning' : 'c-secondary'}`}>{caption}</span>
        </span>
      </span>
      {selected === undefined && <Icon name="chevron" />}
    </button>
  );
}

const envIcon = (env: EnvironmentView) => (env.provider === 'onprem' ? 'server' : 'cloud');

/** 출발 줄: 이 환경에서 서비스 중인 소프트웨어 + 벤더. 줄마다 자기 인벤토리를 읽는다(서버가 30초 캐시). */
function SourceRow({ env, onPick }: { env: EnvironmentView; onPick: () => void }) {
  const inventory = usePoll(() => api.envInventory(env.id), 30_000, [env.id]);
  const title = softwareTitle(softwareOf(env.provider, inventory.data));
  const where = `${vendorLine(env.provider)} · ${env.name}`;
  return (
    <PickRow
      icon={envIcon(env)}
      title={title ?? env.name}
      caption={title ? where : `${vendorLine(env.provider)} · ${inventory.loading ? t('서비스를 읽는 중') : t('서비스를 아직 읽지 못함')}`}
      label={`${title ?? env.name} · ${where}`}
      onPick={onPick}
      transitionName={`env-${env.id}`}
    />
  );
}

export function FoundResources({ cloud }: { cloud: CloudInventory }) {
  if (cloud.status === 'unavailable') {
    const reason = cloud.reason ?? t('자원을 읽지 못했습니다.');
    return (
      <FoldTile title={t('찾은 자원')} summary={t('읽지 못함')}>
        <p className={`${s.note} t-body-sm c-secondary`}>
          {/* 온프레 pull 모드(source agent)는 플랫폼이 클러스터에 붙지 않고 Agent 보고로 채운다 (apps/api agent-reports.ts agentInventoryFor). 다음 보고가 오면 다시 읽는다 */}
          {cloud.source === 'agent' ? t('{0} 다음 Agent 보고가 오면 다시 읽습니다.', { 0: reason }) : t('{0} 마이그레이션을 만들면 다시 읽습니다.', { 0: reason })}
        </p>
      </FoldTile>
    );
  }
  return (
    <>
      {cloud.groups.filter((group) => group.items.length > 0 || group.error).map((group, index) => (
        <FoldTile
          key={`${group.category ?? ''}-${index}`}
          title={group.category ? CATEGORY_LABEL[group.category] : (group.service ?? t('자원'))}
          summary={group.error ? t('읽지 못함') : t('{0}개', { 0: group.items.length })}
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

const EMPTY_INPUT: ScopeInput = { cluster: '', namespaces: '', database: '', appName: '' };

/** 직접 적는 출발 범위. 인벤토리를 못 읽었거나 후보에 없을 때. 빈 칸은 자동으로 고른다. */
function ScopeForm({ input, errors, onChange }: { input: ScopeInput; errors: ReturnType<typeof checkScopeInput>['errors']; onChange: (input: ScopeInput) => void }) {
  const field = (key: keyof ScopeInput, label: string, hint: string, placeholder: string) => (
    <Field
      key={key}
      label={label}
      hint={hint}
      placeholder={placeholder}
      value={input[key]}
      error={errors[key]}
      onChange={(value) => onChange({ ...input, [key]: value })}
    />
  );
  return (
    <div className={s.fieldGrid}>
      {field('cluster', t('클러스터'), t('EKS·GKE 클러스터 이름'), 'shop-eks')}
      {field('namespaces', t('네임스페이스'), t('여럿이면 쉼표로'), 'shop')}
      {field('database', 'DB', t('RDS·Cloud SQL 인스턴스 또는 CNPG 네임스페이스/이름'), 'shop-db')}
      {field('appName', t('앱 이름'), t('도착 자원 이름의 뿌리. 비우면 자동'), 'shop')}
    </div>
  );
}

export function NewMigrationPage() {
  const envs = usePoll(api.listEnvironments, 10_000, []);
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [scope, setScope] = useState<ScopeChoice | null>(null);
  const [manual, setManual] = useState(false);
  const [input, setInput] = useState<ScopeInput>(EMPTY_INPUT);
  const [touched, setTouched] = useState(false);
  const [targetId, setTargetId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const all = realEnvs(envs.data ?? []);
  // 출발은 연결된 환경만. 끝나지 않은 등록은 기억하지 않는다
  const connected = all.filter((env) => env.connectionStatus === 'connected');
  const source = connected.find((env) => env.id === sourceId);
  const inventory = usePoll(sourceId ? () => api.envInventory(sourceId) : null, null, [sourceId]);

  const reset = () =>
    withTransition(() => {
      setSourceId(null);
      setScope(null);
      setManual(false);
      setInput(EMPTY_INPUT);
      setTouched(false);
      setTargetId(null);
      setError(null);
    });

  if (!source) {
    const empty = !envs.loading && connected.length === 0;
    return (
      <ShellLayout layout={LAYOUT}>
        <Hero tone="run" meta={t('새 마이그레이션')} title={empty ? t('연결된 환경이\n없습니다') : t('어디에서\n옮길까요?')}>
          {envs.error != null && !envs.data && <p className={`${s.error} t-body-md`}>{errorText(envs.error)}</p>}
          <div className={s.pickList}>
            {connected.map((env) => (
              <SourceRow key={env.id} env={env} onPick={() => withTransition(() => setSourceId(env.id))} />
            ))}
            {!envs.loading && <RegisterEnvEntry />}
          </div>
        </Hero>
        <Stack area="found">
          <CreateSteps />
        </Stack>
      </ShellLayout>
    );
  }

  const software = softwareTitle(softwareOf(source.provider, inventory.data));
  // 서비스 이름을 모르면 환경 이름만 (같은 이름을 두 번 쓰지 않는다)
  const departure = software ? t('{0} · {1}에서 출발', { 0: software, 1: source.name }) : t('{0}에서 출발', { 0: source.name });
  const found = inventory.loading ? (
    <FoldTile title={t('찾은 자원')} summary={t('읽는 중')}>
      <p className={`${s.note} t-body-sm c-secondary`}>{t('{0}의 자원을 읽고 있습니다.', { 0: source.name })}</p>
    </FoldTile>
  ) : inventory.data ? (
    <FoundResources cloud={inventory.data.cloud} />
  ) : (
    <FoldTile title={t('찾은 자원')} summary={t('읽지 못함')}>
      <p className={`${s.note} t-body-sm c-secondary`}>{t('{0} 마이그레이션을 만들면 다시 읽습니다.', { 0: errorText(inventory.error) })}</p>
    </FoldTile>
  );

  if (!scope) {
    const choices = scopeChoices(source.provider, inventory.data?.cloud);
    const check = checkScopeInput(input);
    const shownErrors = touched ? check.errors : {};
    const pickScope = (choice: ScopeChoice) => withTransition(() => setScope(choice));
    const useManual = () => {
      setTouched(true);
      if (Object.keys(check.errors).length > 0) return;
      const summary = scopeSummary(check.scope);
      pickScope({ key: 'manual', label: scopeLabel(check.scope), detail: summary, scope: check.scope });
    };
    return (
      <ShellLayout layout={LAYOUT}>
        {/* (←) 은 출발 고르기로. 주소가 그대로라 브라우저 뒤로 가기로는 못 간다 */}
        <Hero tone="run" back={reset} meta={`${vendorLine(source.provider)} · ${source.name}`} title={t('무엇을\n옮길까요?')}>
          <div className={s.pickList}>
            <PickRow icon="list" title={AUTO_SCOPE.label} caption={AUTO_SCOPE.detail} onPick={() => pickScope(AUTO_SCOPE)} />
            {choices.map((choice) => (
              <PickRow key={choice.key} icon={envIcon(source)} title={choice.label} caption={choice.detail} onPick={() => pickScope(choice)} />
            ))}
            {!inventory.loading && choices.length === 0 && (
              <p className={`${s.pickNote} t-caption c-tertiary`}>
                {t('{0} 자동으로 고르거나 직접 적어 주세요.', { 0: inventory.data?.cloud.status === 'unavailable' ? t('자원을 읽지 못해 후보가 없습니다.') : t('고를 클러스터·네임스페이스를 찾지 못했습니다.') })}
              </p>
            )}
            <PickRow
              icon="list"
              title={t('직접 적기')}
              caption={t('클러스터·네임스페이스·DB 이름을 압니다')}
              selected={manual}
              onPick={() => withTransition(() => setManual(!manual))}
            />
            {manual && <ScopeForm input={input} errors={shownErrors} onChange={setInput} />}
          </div>
        </Hero>
        <Stack area="found">
          <CreateSteps source={source.name} reading={inventory.loading} />
          {found}
          {manual && (
            <ActionRow>
              <ActionPill label={t('이 범위로 다음')} onClick={useManual} />
            </ActionRow>
          )}
        </Stack>
      </ShellLayout>
    );
  }

  const { options, sameVendor } = targetOptions(all, source);
  const target = options.find((env) => env.id === targetId);
  const create = async () => {
    if (!target) return;
    setBusy(true);
    setError(null);
    try {
      const { id } = await api.createMigration(source.id, target.id, scope.scope);
      go(`migrations/${id}`);
    } catch (reason) {
      setError(errorText(reason));
      setBusy(false);
    }
  };

  return (
    <ShellLayout layout={LAYOUT}>
      {/* (←) 은 범위 고르기로. 직접 적은 범위는 그대로 남는다 */}
      <Hero
        tone="run"
        back={() =>
          withTransition(() => {
            setScope(null);
            setTargetId(null);
            setError(null);
          })
        }
        meta={departure} title={options.length === 0 ? t('옮겨 갈 환경이\n없습니다') : t('어디로 옮길까요?')}>
        <div className={s.pickList}>
          {options.map((env) => {
            const note = borrowNote(env);
            return (
              <PickRow
                key={env.id}
                icon={envIcon(env)}
                title={env.name}
                caption={`${vendorLine(env.provider)} · ${note.text}`}
                warn={note.warn}
                selected={env.id === targetId}
                onPick={() => setTargetId(env.id)}
                transitionName={`env-${env.id}`}
              />
            );
          })}
          {sameVendor.length > 0 && (
            <p className={`${s.pickNote} t-caption c-tertiary`}>
              {t('같은 {0} 안의 마이그레이션은 지금 지원하지 않아 {1}은(는) 뺐습니다.', { 0: vendorLine(source.provider), 1: sameVendor.map((env) => env.name).join(', ') })}
            </p>
          )}
          <RegisterEnvEntry />
        </div>
      </Hero>
      <Stack area="found">
        <CreateSteps source={source.name} scope={scope.label} target={target?.name} />
        {Object.keys(scope.scope).length > 0 && (
          <FoldTile title={t('옮길 서비스')} summary={scope.label}>
            <p className={`${s.note} t-body-sm c-secondary`}>{scopeSummary(scope.scope)}</p>
          </FoldTile>
        )}
        <FoldTile title={t('빌릴 권한')} summary={t('단계마다 짧게')}>
          <ul className={s.rows}>
            <li className={s.row}>
              <span className="t-label-md">{t('출발 · {0}', { 0: source.name })}</span>
              <span className="t-caption c-tertiary">{t('관찰 역할 · 읽기만')}</span>
            </li>
            <li className={s.row}>
              <span className="t-label-md">{t('도착 · {0}', { 0: target?.name ?? t('고르면 보임') })}</span>
              <span className="t-caption c-tertiary">{t('실행 역할 · 자원 만들기와 배포')}</span>
            </li>
          </ul>
          <p className={`${s.note} t-body-sm c-secondary`}>
            {t('마이그레이션을 만들면 가져오기가 바로 출발 관찰 역할을 빌려 읽습니다. 실행 역할은 승인한 뒤 단계마다 15분씩 빌리고, 마이그레이션 화면 "보안" 카드의 임시 권한에 남습니다.')}
          </p>
        </FoldTile>
        <ActionRow notice={error}>
          <ActionPill
            label={busy ? t('만드는 중') : target ? t('{0}로 옮기기', { 0: target.name }) : t('도착지를 고르세요')}
            disabled={!target || busy}
            onClick={() => void create()}
          />
        </ActionRow>
      </Stack>
    </ShellLayout>
  );
}
