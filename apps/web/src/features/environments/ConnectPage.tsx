import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { go } from '../../app/routes';
import { withTransition } from '../../app/transition';
import type { BentoLayout } from '../../components/layout/ConsoleLayout';
import { ActionRow, FoldTile, Hero, Stack } from '../../components/layout/tiles';
import { Checklist } from '../../components/ui/Checklist';
import { CodeValue } from '../../components/ui/CodeValue';
import { Field } from '../../components/ui/Field';
import { ActionPill, BarPill } from '../../components/ui/controls';
import { Icon } from '../../components/ui/Icon';
import { api } from '../../lib/api';
import { errorCode, errorText } from '../../lib/errors';
import { connectionReasonText } from '../../lib/failure';
import { CONN_LABEL } from '../../lib/status';
import { ago } from '../../lib/text';
import type { AgentEnrollToken, ConnectionLink, EnvironmentView, Provider } from '../../lib/types';
import { usePoll } from '../../lib/usePoll';
import { vendorLine } from '../migration/source';
import { ShellLayout } from '../shell/ShellLayout';
import {
  CONNECTABLE,
  DEFAULT_AWS_REGION,
  REGISTER_PATH,
  checkAccount,
  checkEnvForm,
  connectPollMs,
  connectSteps,
  phaseOf,
  providerLabel,
  type AccountForm,
  type ConnectableProvider,
  type ConnectPhase,
  type EnvForm,
} from './connect';
import s from '../common/page.module.css';

// 큰 카드는 지금 할 한 가지, 오른쪽은 등록 단계와 권한을 빌리는 방식.
const LAYOUT: BentoLayout = { columns: ['fill', 'side'], areas: 'hero side' };

const until = (iso: string) =>
  new Date(iso).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

function StepsFold({ at, provider, name }: { at: Parameters<typeof connectSteps>[0]; provider?: Provider; name?: string }) {
  const items = connectSteps(at, { provider, name });
  const done = items.filter((item) => item.status === 'done').length;
  return (
    <FoldTile title="환경 등록" summary={`${done}/${items.length}`}>
      <div className={s.agent}>
        <Checklist items={items} />
      </div>
    </FoldTile>
  );
}

/** 연결이 무엇을 여는지. 비밀 키가 아니라 빌리는 권한이라는 것을 등록하는 내내 옆에 둔다. */
function HowFold({ provider }: { provider?: Provider }) {
  return (
    <FoldTile title="권한을 빌리는 방식" summary="비밀 키 0개">
      {provider === 'onprem' ? (
        <ul className={s.rows}>
          <li className={s.row}>
            <span className="t-label-md">Agent</span>
            <span className="t-caption c-tertiary">고객 클러스터 안에서 상태를 보고</span>
          </li>
          <li className={s.row}>
            <span className="t-label-md">등록 토큰</span>
            <span className="t-caption c-tertiary">10분 동안 한 번만 씀</span>
          </li>
        </ul>
      ) : (
        <>
          <ul className={s.rows}>
            <li className={s.row}>
              <span className="t-label-md">관찰 역할</span>
              <span className="t-caption c-tertiary">읽기만 · 가져오기와 점검</span>
            </li>
            <li className={s.row}>
              <span className="t-label-md">실행 역할</span>
              <span className="t-caption c-tertiary">도착 자원 만들기와 배포</span>
            </li>
          </ul>
          <p className={`${s.note} t-body-sm c-secondary`}>
            플랫폼은 비밀 키를 받지 않습니다. 고객 계정에 만든 역할을 이전 단계마다 필요한 만큼만 짧게 빌리고(실행 단계는 15분), 끝나면 돌려줍니다.
          </p>
        </>
      )}
    </FoldTile>
  );
}

const NAME_PLACEHOLDER: Record<ConnectableProvider, string> = { aws: 'shop-prod-aws', gcp: 'shop-prod-gcp', onprem: 'shop-onprem' };

/** 새 환경: 어디를 연결할지 → 이름(AWS 는 리전·클러스터도) → 만들면 연결 이어 하기로 넘어간다. */
function NewEnvironment() {
  const [provider, setProvider] = useState<ConnectableProvider | null>(null);
  const [form, setForm] = useState<EnvForm>({ name: '', region: DEFAULT_AWS_REGION, clusterName: '' });
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!provider) {
    return (
      <ShellLayout layout={LAYOUT}>
        <Hero tone="run" meta="환경 등록" title={'어디를\n연결할까요?'}>
          <div className={s.pickList}>
            {CONNECTABLE.map((item) => (
              <button key={item.provider} type="button" className={s.pickRow} onClick={() => withTransition(() => setProvider(item.provider))}>
                <span className={s.pickName}>
                  <Icon name={item.provider === 'onprem' ? 'server' : 'cloud'} />
                  <span className={s.pickText}>
                    <span className="t-h3">{item.label}</span>
                    <span className="t-caption c-secondary">{item.detail}</span>
                  </span>
                </span>
                <Icon name="chevron" />
              </button>
            ))}
          </div>
        </Hero>
        <Stack area="side">
          <StepsFold at="provider" />
          <HowFold />
        </Stack>
      </ShellLayout>
    );
  }

  const check = checkEnvForm(provider, form);
  const shown = touched ? check.errors : {};
  const set = (key: keyof EnvForm) => (value: string) => setForm((prev) => ({ ...prev, [key]: value }));
  const create = async (event?: FormEvent) => {
    event?.preventDefault();
    setTouched(true);
    if (!check.ok || busy) return;
    setBusy(true);
    setError(null);
    try {
      const env = await api.createEnvironment({
        provider,
        name: form.name.trim(),
        ...(provider === 'aws' ? { region: form.region.trim(), clusterName: form.clusterName.trim() } : {}),
      });
      go(`environments/connect/${env.id}`);
    } catch (reason) {
      setError(errorText(reason));
      setBusy(false);
    }
  };

  return (
    <ShellLayout
      layout={LAYOUT}
      barLeft={
        <BarPill
          label={`${providerLabel(provider)} · 다시 고르기`}
          onClick={() =>
            withTransition(() => {
              setProvider(null);
              setTouched(false);
              setError(null);
            })
          }
        />
      }
    >
      <Hero tone="run" meta={`${providerLabel(provider)} 환경 등록`} title={'이 환경을\n뭐라고 부를까요?'}>
        <form className={s.fieldGrid} onSubmit={(event) => void create(event)} noValidate>
          <Field label="환경 이름" hint="목록과 이전 화면에 보이는 이름입니다" placeholder={NAME_PLACEHOLDER[provider]} autoFocus value={form.name} error={shown.name} onChange={set('name')} />
          {provider === 'aws' && (
            <>
              <Field label="리전" hint="EKS 클러스터가 있는 리전" value={form.region} error={shown.region} onChange={set('region')} />
              <Field label="EKS 클러스터 이름" hint="연결 확인이 이 클러스터에 들어갈 수 있는지 봅니다" value={form.clusterName} error={shown.clusterName} onChange={set('clusterName')} />
            </>
          )}
          {/* Enter 로도 보낸다 */}
          <button type="submit" hidden />
        </form>
      </Hero>
      <Stack area="side">
        <StepsFold at="details" provider={provider} />
        <HowFold provider={provider} />
        <ActionRow notice={error}>
          <ActionPill label={busy ? '만드는 중' : '다음'} disabled={busy} onClick={() => void create()} />
        </ActionRow>
      </Stack>
    </ShellLayout>
  );
}

/** 고객 쪽에서 할 일: AWS 스택, GCP 명령, 온프레 Agent. 링크·명령은 이 화면에 들어오면 한 번 받는다. */
function CustomerTodo({
  env,
  link,
  token,
  issuing,
  issueError,
  account,
  accountErrors,
  onAccount,
  onReissue,
}: {
  env: EnvironmentView;
  link: ConnectionLink | null;
  token: AgentEnrollToken | null;
  issuing: boolean;
  issueError: string | null;
  account: AccountForm;
  accountErrors: Partial<Record<keyof AccountForm, string>>;
  onAccount: (key: keyof AccountForm) => (value: string) => void;
  onReissue: () => void;
}) {
  const pending = <span className="t-caption c-tertiary">{issuing ? '받는 중' : '아직 받지 못함'}</span>;
  if (env.provider === 'onprem') {
    return (
      <>
        <ol className={s.todo}>
          <li>
            <span className="t-body-md">고객 클러스터에 닿는 터미널에서 이 명령을 실행합니다.</span>
            {token ? <CodeValue value={token.command} chip max={56} /> : pending}
          </li>
          <li>
            <span className="t-body-md">Agent 가 붙으면 이 화면이 저절로 넘어갑니다.</span>
            {token && <span className="t-caption c-tertiary">명령의 토큰은 {until(token.expiresAt)}까지 한 번만 씁니다</span>}
          </li>
        </ol>
        {issueError && <p className={`${s.error} t-body-md`}>{issueError}</p>}
        <button type="button" className={s.linkPill} disabled={issuing} onClick={onReissue}>
          <Icon name="refresh" />
          <span className="t-label-md">{issuing ? '받는 중' : '새 명령 받기'}</span>
        </button>
      </>
    );
  }
  const aws = env.provider === 'aws';
  return (
    <>
      <ol className={s.todo}>
        <li>
          <span className="t-body-md">{aws ? 'AWS 콘솔에서 스택을 만듭니다. 관찰 역할과 실행 역할이 생깁니다.' : 'Cloud Shell 을 엽니다.'}</span>
          {link?.url ? (
            <a className={s.linkPill} href={link.url} target="_blank" rel="noopener noreferrer">
              <Icon name="external" />
              <span className="t-label-md">{aws ? 'AWS 콘솔에서 스택 만들기' : 'Cloud Shell 열기'}</span>
            </a>
          ) : (
            pending
          )}
        </li>
        {aws ? (
          <li>
            <span className="t-body-md">스택 화면에 이 확인 문구(ExternalId)가 채워져 있는지 봅니다.</span>
            {link?.externalId ? <CodeValue value={link.externalId} chip max={44} /> : pending}
          </li>
        ) : (
          <li>
            <span className="t-body-md">이 명령을 붙여 넣어 실행합니다. 플랫폼이 빌려 쓸 역할이 생깁니다.</span>
            {link?.command ? <CodeValue value={link.command} chip max={56} /> : pending}
          </li>
        )}
        <li>
          <span className="t-body-md">{aws ? '스택을 만든 계정 번호를 적고 연결을 확인합니다.' : '프로젝트 ID 를 적고 연결을 확인합니다.'}</span>
          <div className={s.fieldGrid}>
            <Field
              label={aws ? 'AWS 계정 번호' : '읽을 프로젝트 ID'}
              hint={aws ? '숫자 12자리. 대시가 있어도 됩니다' : '지금 서비스가 돌고 있는 프로젝트'}
              placeholder={aws ? '1111-2222-3333' : 'shop-prod'}
              numeric={aws}
              value={account.accountId}
              error={accountErrors.accountId}
              onChange={onAccount('accountId')}
            />
            {!aws && (
              <Field
                label="이전 전용 프로젝트 ID"
                hint="도착 자원이 생기는 곳. 비우면 실행 단계에서 막힐 수 있습니다"
                placeholder="shop-migration"
                value={account.targetProjectId}
                error={accountErrors.targetProjectId}
                onChange={onAccount('targetProjectId')}
              />
            )}
          </div>
        </li>
      </ol>
      {link && <span className="t-caption c-tertiary">링크는 {until(link.expiresAt)}까지 씁니다</span>}
      {issueError && <p className={`${s.error} t-body-md`}>{issueError}</p>}
    </>
  );
}

/** 이미 만든 환경의 연결을 이어 한다. 어디서 들어오든(등록 직후, 환경 화면, 계정 화면) 같은 상태 판단을 탄다. */
function ContinueConnect({ id }: { id: string }) {
  const [pollMs, setPollMs] = useState(2_000);
  const envs = usePoll(api.listEnvironments, pollMs, [id]);
  const env = envs.data?.find((item) => item.id === id);
  const phase: ConnectPhase | null = env ? phaseOf(env.connectionStatus) : null;
  useEffect(() => setPollMs(connectPollMs(phase, env?.provider)), [phase, env?.provider]);

  const [link, setLink] = useState<ConnectionLink | null>(null);
  const [token, setToken] = useState<AgentEnrollToken | null>(null);
  const [issuing, setIssuing] = useState(false);
  const [issueError, setIssueError] = useState<string | null>(null);
  const issued = useRef(false);
  const issue = async () => {
    if (!env) return;
    issued.current = true;
    setIssuing(true);
    setIssueError(null);
    try {
      if (env.provider === 'onprem') setToken(await api.agentToken(env.id));
      else setLink(await api.connectionLink(env.id));
      await envs.reload();
    } catch (reason) {
      setIssueError(errorText(reason));
    } finally {
      setIssuing(false);
    }
  };
  // 고객 차례에 들어오면 링크·명령을 한 번만 받는다. 다시 받으면 온프레 토큰은 앞의 것이 무효가 된다
  useEffect(() => {
    if (phase === 'link' && !issued.current) void issue();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, env?.id]);

  const [account, setAccount] = useState<AccountForm>({ accountId: '', targetProjectId: '' });
  useEffect(() => {
    if (env) setAccount((prev) => ({ accountId: prev.accountId || env.accountId || '', targetProjectId: prev.targetProjectId || env.targetProjectId || '' }));
  }, [env?.id, env?.accountId, env?.targetProjectId]);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [verifyError, setVerifyError] = useState<string | null>(null);

  if (!env) {
    const missing = !envs.loading && envs.data;
    return (
      <ShellLayout layout={LAYOUT}>
        <Hero tone="run" meta="환경 등록" title={missing ? '환경을\n찾지 못했습니다' : '환경을\n읽고 있습니다'}>
          {envs.error != null && !envs.data && <p className={`${s.error} t-body-md`}>{errorText(envs.error)}</p>}
        </Hero>
        <Stack area="side">
          <StepsFold at="details" />
          {missing && (
            <ActionRow>
              <ActionPill label="새로 등록하기" icon="plus" onClick={() => go(REGISTER_PATH)} />
            </ActionRow>
          )}
        </Stack>
      </ShellLayout>
    );
  }

  const provider = env.provider as ConnectableProvider;
  const meta = `${vendorLine(env.provider)} · ${env.name}`;
  const accountCheck = checkAccount(provider, account);
  const verify = async () => {
    setTouched(true);
    if (!accountCheck.ok || busy) return;
    setBusy(true);
    setVerifyError(null);
    try {
      await api.verifyEnvironment(env.id, accountCheck.accountId, accountCheck.targetProjectId);
      await envs.reload();
    } catch (reason) {
      setVerifyError(errorText(reason));
      if (errorCode(reason) === 'LINK_EXPIRED') {
        setLink(null);
        await envs.reload();
      }
    } finally {
      setBusy(false);
    }
  };
  const side = (extra?: ReactNode) => (
    <Stack area="side">
      <StepsFold at={phase!} provider={env.provider} name={env.name} />
      <HowFold provider={env.provider} />
      {extra}
    </Stack>
  );

  if (phase === 'link') {
    const onprem = env.provider === 'onprem';
    return (
      <ShellLayout layout={LAYOUT}>
        <Hero tone="run" meta={meta} title={onprem ? '클러스터에서\n이 명령을 실행해 주세요' : env.provider === 'aws' ? 'AWS 계정에\n역할을 만들어 주세요' : 'GCP 프로젝트에\n권한을 열어 주세요'}>
          <CustomerTodo
            env={env}
            link={link}
            token={token}
            issuing={issuing}
            issueError={issueError}
            account={account}
            accountErrors={touched ? accountCheck.errors : {}}
            onAccount={(key) => (value) => setAccount((prev) => ({ ...prev, [key]: value }))}
            onReissue={() => void issue()}
          />
        </Hero>
        {side(
          !onprem && (
            <ActionRow notice={verifyError}>
              {/* 링크를 받기 전(draft)에는 서버가 확인 요청을 받지 않는다. 링크부터 받게 한다 */}
              {env.connectionStatus === 'awaiting_customer' ? (
                <ActionPill label={busy ? '보내는 중' : '연결 확인'} disabled={busy} onClick={() => void verify()} />
              ) : (
                <ActionPill label={issuing ? '링크 받는 중' : '링크 다시 받기'} icon="refresh" disabled={issuing} onClick={() => void issue()} />
              )}
            </ActionRow>
          ),
        )}
      </ShellLayout>
    );
  }

  if (phase === 'verifying') {
    return (
      <ShellLayout layout={LAYOUT}>
        <Hero tone="run" meta={meta} title={'연결을\n확인하고 있습니다'}>
          <p className="t-body-md c-secondary">고객 계정의 관찰 역할을 빌려 읽기 권한과 클러스터 접근을 봅니다. 끝나면 이 화면이 저절로 넘어갑니다.</p>
        </Hero>
        {side()}
      </ShellLayout>
    );
  }

  if (phase === 'retry') {
    const expired = env.connectionStatus === 'expired';
    const reason = connectionReasonText(env.failureReason);
    // 실패는 같은 계정으로 다시 확인할 수 있다(서버 failed → verifying). 만료는 링크부터 다시
    const canVerify = !expired && env.provider !== 'onprem' && !!env.accountId;
    return (
      <ShellLayout layout={LAYOUT}>
        <Hero
          tone="stop"
          meta={`${vendorLine(env.provider)} · ${CONN_LABEL[env.connectionStatus]}`}
          title={expired ? '연결 링크가\n만료됐습니다' : `${env.name}\n연결하지 못했습니다`}
          foot={env.lastVerifiedAt ? `마지막 확인 ${ago(env.lastVerifiedAt)}` : undefined}
        >
          {(reason || env.needsHuman?.length) && (
            <div className={s.heroPanel}>
              {reason && <span className="t-body-md">{reason}</span>}
              {env.needsHuman?.map((line) => (
                <span key={line} className="t-body-sm c-secondary">
                  {line}
                </span>
              ))}
            </div>
          )}
          {issueError && <p className={`${s.onAlert} t-body-md`}>{issueError}</p>}
        </Hero>
        {side(
          <ActionRow notice={verifyError} before={canVerify ? <BarPill label={issuing ? '받는 중' : env.provider === 'onprem' ? '새 명령 받기' : '링크 다시 받기'} onClick={issuing ? undefined : () => void issue()} /> : undefined}>
            {canVerify ? (
              <ActionPill label={busy ? '보내는 중' : '같은 계정으로 다시 확인'} icon="refresh" disabled={busy} onClick={() => void verify()} />
            ) : (
              <ActionPill label={issuing ? '받는 중' : env.provider === 'onprem' ? '새 명령 받기' : '링크 다시 받기'} icon="refresh" disabled={issuing} onClick={() => void issue()} />
            )}
          </ActionRow>,
        )}
      </ShellLayout>
    );
  }

  if (phase === 'gone') {
    return (
      <ShellLayout layout={LAYOUT}>
        <Hero tone="stop" meta={`${vendorLine(env.provider)} · 해제됨`} title={`${env.name}\n해제된 환경입니다`} foot="해제한 환경은 다시 연결할 수 없습니다. 새로 등록해 주세요." />
        {side(
          <ActionRow>
            <ActionPill label="새로 등록하기" icon="plus" onClick={() => go(REGISTER_PATH)} />
          </ActionRow>,
        )}
      </ShellLayout>
    );
  }

  return (
    <ShellLayout layout={LAYOUT}>
      <Hero tone="done" meta={`${vendorLine(env.provider)} · ${CONN_LABEL[env.connectionStatus]}`} title={`${env.name}\n연결했습니다`}>
        <ul className={s.heroStats}>
          {env.accountId && (
            <li>
              <span className="t-metric-lg">{env.accountId}</span>
              <span className="t-caption c-tertiary">{env.provider === 'gcp' ? '프로젝트' : '계정'}</span>
            </li>
          )}
          {env.lastVerifiedAt && (
            <li>
              <span className="t-metric-lg">{ago(env.lastVerifiedAt)}</span>
              <span className="t-caption c-tertiary">마지막 확인</span>
            </li>
          )}
        </ul>
        {env.mock && <p className="t-body-md c-secondary">흉내 자격으로 확인했습니다. 클라우드는 읽지 않았습니다.</p>}
        {env.missingPermissions && env.missingPermissions.length > 0 && (
          <p className="t-body-md c-warning">관찰 역할에 선택 권한 {env.missingPermissions.length}개가 빠졌습니다: {env.missingPermissions.slice(0, 3).join(', ')}</p>
        )}
      </Hero>
      {side(
        <ActionRow before={<BarPill label="환경 보기" onClick={() => go(`environments/${env.id}`)} />}>
          <ActionPill label="이 환경에서 새 이전" onClick={() => go('migrations/new')} />
        </ActionRow>,
      )}
    </ShellLayout>
  );
}

/** 환경 등록. id 가 없으면 새로 만들고, 있으면 그 환경의 연결을 이어 한다. */
export function ConnectPage({ id }: { id: string | null }) {
  return id ? <ContinueConnect id={id} /> : <NewEnvironment />;
}
