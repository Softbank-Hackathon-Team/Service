import { useEffect, useState } from 'react';
import { go } from '../../app/routes';
import type { BentoLayout } from '../../components/layout/ConsoleLayout';
import { ActionRow, FoldTile, Hero, Stack } from '../../components/layout/tiles';
import { ActionPill, Badge, OptionPill } from '../../components/ui/controls';
import { Icon } from '../../components/ui/Icon';
import { API_BASE, api, auth } from '../../lib/api';
import type { AuthUser } from '../../lib/auth';
import { or404 } from '../../lib/http';
import { LOCALES, locale } from '../../lib/i18n';
import { readActivePrefs, savePrefs, type Locale, type Theme } from '../../lib/prefs';
import { CONN_LABEL, PROVIDER_SHORT, isTerminal } from '../../lib/status';
import { ago } from '../../lib/text';
import type { EnvironmentView, Provider } from '../../lib/types';
import { usePoll } from '../../lib/usePoll';
import { realEnvs } from '../dashboard/model';
import { envPath, REGISTER_PATH } from '../environments/connect';
import { PLATFORM } from '../migration/source';
import { ShellLayout } from '../shell/ShellLayout';
import { borrowedByEnv, envsByProvider, minutesLeft, PROVIDER_ORDER, type Borrowed } from './model';
import s from '../common/page.module.css';
import own from './SettingsPage.module.css';

const LAYOUT: BentoLayout = { columns: ['fill', 'side'], areas: 'hero side' };

function useLatency(probe: () => Promise<unknown>, ms: number) {
  return usePoll(async () => {
    const start = performance.now();
    await probe();
    return Math.round(performance.now() - start);
  }, ms, [], { keepOnError: false });
}

function ProbeRow({ name, state }: { name: string; state: { data: number | null; error: unknown; loading: boolean } }) {
  const up = state.data !== null && !state.error;
  return (
    <li className={s.row}>
      <span className="t-label-md">{name}</span>
      {state.loading ? <Badge>확인 중</Badge> : <Badge tone={up ? 'success' : 'danger'}>{up ? `${state.data}ms` : '응답 없음'}</Badge>}
    </li>
  );
}

const PURPOSE: Record<Borrowed['purpose'], string> = { observe: '관찰 역할', operate: '실행 역할' };

/**
 * 진행 중인 마이그레이션의 임시 권한 장부를 읽어 환경마다 지금 빌린 권한을 낸다.
 * 환경 단위 API 가 없어서 마이그레이션 보안 표(GET /migrations/:id/security)의 장부를 쓴다
 */
function useBorrowed(envs: EnvironmentView[]) {
  const migrations = usePoll(api.listMigrations, 15_000, []);
  const active = (migrations.data ?? []).filter((item) => !isTerminal(item.status));
  const key = active.map((item) => item.id).join(',');
  const ledgers = usePoll(
    () => Promise.all(active.map(async (migration) => ({ migration, rows: (await or404(api.security(migration.id)))?.ledger ?? [] }))),
    15_000,
    [key],
  );
  return borrowedByEnv(envs, ledgers.data ?? []);
}

function EnvLine({ env, borrowed }: { env: EnvironmentView; borrowed: Borrowed | undefined }) {
  const connected = env.connectionStatus === 'connected';
  return (
    <li className={own.envLine}>
      <button type="button" className={own.envName} onClick={() => go(envPath(env))}>
        <span className="t-label-md">{env.name}</span>
        {!connected && <Badge tone="warning">{CONN_LABEL[env.connectionStatus]}</Badge>}
      </button>
      <span className="t-caption c-tertiary">
        {PLATFORM[env.provider]} · 연결 확인 {ago(env.lastVerifiedAt)}
      </span>
      <span className={own.borrowRow}>
        <span className={`t-caption ${borrowed ? 'c-secondary' : 'c-tertiary'}`}>
          {borrowed ? `${PURPOSE[borrowed.purpose]}${borrowed.step ? ` · ${borrowed.step}` : ''} · ${minutesLeft(borrowed.expiresAt)}분 남음` : '빌린 권한 없음'}
        </span>
        {/* TODO(human): 빌린 권한을 사람이 갱신하는 서버 API 가 아직 없다. 생기면 이 버튼을 켠다 */}
        <button type="button" className={own.refresh} disabled title="권한 갱신은 서버 기능이 생기면 켜집니다">
          <Icon name="refresh" size={12} />
          갱신
        </button>
      </span>
    </li>
  );
}

/** 벤더 하나의 카드. 그 벤더로 연결한 환경(EKS·ECS·GKE·k3s …)이 이 안에 들어온다 */
function ProviderCard({ provider, envs, borrowed }: { provider: Provider; envs: EnvironmentView[]; borrowed: Record<string, Borrowed> }) {
  return (
    <section className={own.card}>
      <header className={own.cardHead}>
        <span className={own.cardTitle}>
          <Icon name={provider === 'onprem' ? 'server' : 'cloud'} />
          <span className="t-h3">{PROVIDER_SHORT[provider]}</span>
        </span>
        <span className="t-caption c-tertiary">{`${envs.length}개`}</span>
      </header>
      {envs.length > 0 ? (
        <ul className={own.envList}>
          {envs.map((env) => (
            <EnvLine key={env.id} env={env} borrowed={borrowed[env.id]} />
          ))}
        </ul>
      ) : (
        <p className="t-body-sm c-tertiary">연결한 환경이 없습니다.</p>
      )}
    </section>
  );
}

/** 환경 등록하기. 벤더 카드와 같은 크기로 끝에 둔다 */
function RegisterCard() {
  return (
    <button type="button" className={`${own.card} ${own.addCard}`} onClick={() => go(REGISTER_PATH)}>
      <Icon name="plus" size={20} />
      <span className="t-h3">환경 등록하기</span>
      <span className="t-caption c-tertiary">AWS·GCP 계정이나 온프레 클러스터</span>
    </button>
  );
}

/** 화면 설정. 테마는 바로 바뀌고, 언어는 바꾸면 화면을 다시 읽는다. 이 사람·이 브라우저에 남긴다 */
function DisplayFold({ user }: { user: AuthUser }) {
  const [theme, setTheme] = useState<Theme>(readActivePrefs().theme);
  const current = locale();
  const pickTheme = (next: Theme) => {
    setTheme(next);
    savePrefs(user.id, { theme: next });
  };
  const pickLocale = (next: Locale) => {
    if (savePrefs(user.id, { locale: next })) window.location.reload();
  };
  const themeLabel = theme === 'dark' ? '다크' : '라이트';
  return (
    <FoldTile title="화면" summary={`${themeLabel} · ${LOCALES.find((item) => item.id === current)?.label ?? current}`}>
      <div className={s.agent}>
        <span className="t-label-sm c-tertiary">테마</span>
        <div className={own.options}>
          <OptionPill label="라이트 (기본)" selected={theme === 'light'} onClick={() => pickTheme('light')} />
          <OptionPill label="다크" selected={theme === 'dark'} onClick={() => pickTheme('dark')} />
        </div>
        <span className="t-label-sm c-tertiary">언어</span>
        <div className={own.options}>
          {LOCALES.map((item) => (
            <OptionPill key={item.id} label={item.label} selected={current === item.id} onClick={() => pickLocale(item.id)} />
          ))}
        </div>
        <p className="t-caption c-tertiary">이 브라우저에 이 계정의 설정으로 남깁니다.</p>
      </div>
    </FoldTile>
  );
}

/** GitHub 로그인. 서버가 켜 두었는지(GET /auth/config)만 안다. 이 계정과 GitHub 계정의 연동 정보는 서버가 아직 주지 않는다 */
function GithubFold() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    void auth.config().then((config) => {
      if (alive) setEnabled(config?.github?.enabled === true);
    });
    return () => {
      alive = false;
    };
  }, []);
  return (
    <FoldTile title="GitHub 로그인" summary={enabled === null ? '확인 중' : enabled ? '켜짐' : '꺼짐'} defaultOpen={false}>
      <p className={`${s.note} t-body-sm c-secondary`}>
        {enabled === null
          ? '서버 설정을 읽고 있습니다.'
          : enabled
            ? '이 서버는 GitHub 계정으로 로그인할 수 있습니다. 이 계정에 GitHub 계정이 이어져 있는지는 서버가 아직 알려 주지 않습니다.'
            : '이 서버는 GitHub 로그인을 꺼 두었습니다. 이메일과 비밀번호로 로그인합니다.'}
      </p>
    </FoldTile>
  );
}

export function SettingsPage({ user }: { user: AuthUser }) {
  const health = useLatency(api.health, 5_000);
  const ready = useLatency(api.ready, 10_000);
  const envs = usePoll(api.listEnvironments, 10_000, []);
  const list = realEnvs(envs.data ?? []);
  const groups = envsByProvider(list);
  const borrowed = useBorrowed(list);
  const name = user.displayName ?? user.email;
  return (
    <ShellLayout layout={LAYOUT}>
      <Hero tone="run" meta={user.tenantName ?? '회사'} title={`${name}\n계정입니다`} foot="회사 멤버면 승인까지 모두 할 수 있습니다">
        <p className="t-body-md c-secondary">{user.email}</p>
        <div className={`${own.grid} scroll-fade`}>
          {PROVIDER_ORDER.map((provider) => (
            <ProviderCard key={provider} provider={provider} envs={groups[provider]} borrowed={borrowed} />
          ))}
          <RegisterCard />
        </div>
      </Hero>
      <Stack area="side">
        <DisplayFold user={user} />
        <GithubFold />
        <FoldTile title="서비스 상태" summary="자동 확인" defaultOpen={false}>
          <ul className={s.rows}>
            <ProbeRow name="API 서버" state={health} />
            <ProbeRow name="데이터베이스" state={ready} />
          </ul>
        </FoldTile>
        <FoldTile title="개발자 문서" summary="OpenAPI" defaultOpen={false}>
          <ul className={s.rows}>
            <li className={s.row}><a className={`${s.link} t-label-md`} href={`${API_BASE}/docs`} target="_blank" rel="noopener">API 문서</a></li>
            <li className={s.row}><a className={`${s.link} t-label-md`} href={`${API_BASE}/docs/openapi.json`} target="_blank" rel="noopener">openapi.json</a></li>
            <li className={s.row}><a className={`${s.link} t-label-md`} href={`${API_BASE}/docs/openapi.yaml`} target="_blank" rel="noopener">openapi.yaml</a></li>
          </ul>
        </FoldTile>
        <ActionRow>
          <ActionPill label="로그아웃" icon="rollback" onClick={() => void auth.logout()} />
        </ActionRow>
      </Stack>
    </ShellLayout>
  );
}
