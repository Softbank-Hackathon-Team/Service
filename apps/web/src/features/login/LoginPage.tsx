import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ConsoleLayout, type BentoLayout } from '../../components/layout/ConsoleLayout';
import { Hero, Tile, TileHeader } from '../../components/layout/tiles';
import { ActionPill, BarPill } from '../../components/ui/controls';
import { Icon, type IconName } from '../../components/ui/Icon';
import { PRODUCT_NAME } from '../../components/ui/Logo';
import { API_BASE, auth } from '../../lib/api';
import { AuthError, githubErrorText, githubStartUrl, takeGithubError } from '../../lib/auth';
import s from './LoginPage.module.css';
import { SignupForm } from './SignupForm';
import { t } from '../../lib/i18n';

const LOGIN: BentoLayout = { columns: ['fill', 'side'], areas: 'hero form' };

// 팀이 정한 세 원칙 (11/08). 이름은 영어 그대로, 설명은 화면 언어로
const PRINCIPLES: { icon: IconName; name: string; text: string }[] = [
  { icon: 'key', name: 'Zero Trust Migration', text: t('고객의 장기 유효 API 키를 보관하지 않고, 필요한 순간에만 단기 권한을 획득하며 작업 종료 후 폐기한다.') },
  { icon: 'matrix', name: 'Deterministic Migration', text: t('AI의 추론에 이전 작업을 의존시키지 않고, 공통 명세와 환경별 어댑터를 통해 예측 가능하고 재현 가능한 마이그레이션을 수행한다.') },
  { icon: 'shield', name: 'Verified Execution', text: t('AI 에이전트를 gVisor와 vCluster로 격리하고, 사람의 승인을 받은 변경이라도 실제 적용 전 리허설로 검증한다.') },
];

export function LoginPage({ notice }: { notice: string | null }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [github, setGithub] = useState(false);
  const [signup, setSignup] = useState(false);
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const emailRef = useRef<HTMLInputElement>(null);

  // 가입에서 돌아와도 이메일 칸에 바로 쓸 수 있게
  useEffect(() => {
    if (mode === 'login') emailRef.current?.focus();
  }, [mode]);

  // GitHub 버튼은 서버가 켜 둔 경우만 (GET /auth/config 의 github.enabled). 못 읽으면 띄우지 않는다
  useEffect(() => {
    let alive = true;
    void auth.config().then((config) => {
      if (alive) setGithub(config?.github?.enabled === true);
    });
    return () => {
      alive = false;
    };
  }, []);

  // "회원가입"은 서버가 가입을 열어 둔 경우만 (GET /auth/signup/config 의 enabled). 404(예전 서버)·못 읽음은 띄우지 않는다
  useEffect(() => {
    let alive = true;
    void auth.signupConfig().then((config) => {
      if (alive) setSignup(config?.enabled === true);
    });
    return () => {
      alive = false;
    };
  }, []);

  // GitHub 에서 실패하고 돌아오면 ?github_error=<코드> 가 붙어 온다. 문장으로 보이고, 새로 고침해도 다시 뜨지 않게 주소에서 지운다
  useEffect(() => {
    const { code, clean } = takeGithubError(window.location.href);
    if (!code) return;
    setError(githubErrorText(code));
    window.history.replaceState(window.history.state, '', clean);
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!email.trim() || !password) {
      setError(t('이메일과 비밀번호를 모두 입력해 주세요.'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await auth.login(email.trim(), password);
    } catch (reason) {
      setError(reason instanceof AuthError ? reason.message : t('서버에 연결하지 못했습니다. 잠시 뒤 다시 시도해 주세요.'));
      setBusy(false);
    }
  };

  const openSignup = () => {
    setError(null);
    setMode('signup');
  };

  return (
    <ConsoleLayout layout={LOGIN}>
      <Hero tone="run" back={false} meta={t('{0} 콘솔', { 0: PRODUCT_NAME })} title={t('돌고 있는 앱을\n멈추지 않고 옮깁니다')}>
        <ul className={s.principles}>
          {PRINCIPLES.map((item) => (
            <li key={item.name} className={s.principle}>
              <span className={s.principleIcon}>
                <Icon name={item.icon} size={20} />
              </span>
              <span className="t-h3">{item.name}</span>
              <span className="t-body-sm c-secondary">{item.text}</span>
            </li>
          ))}
        </ul>
      </Hero>
      <Tile area="form" scroll={mode === 'signup'}>
        {mode === 'signup' ? (
          <SignupForm onBack={() => setMode('login')} />
        ) : (
          <form className={s.form} onSubmit={submit} noValidate aria-label={t('로그인')}>
            <TileHeader title={t('로그인')} />
            {notice && (
              <p className={`${s.notice} t-body-md`} role="status">
                {notice}
              </p>
            )}
            <div className={s.fields}>
              <label className={s.field}>
                <span className="t-label-md c-secondary">{t('이메일')}</span>
                <input
                  ref={emailRef}
                  className={`${s.input} t-body-md`}
                  type="email"
                  name="email"
                  autoComplete="username"
                  spellCheck={false}
                  value={email}
                  aria-invalid={error ? true : undefined}
                  onChange={(event) => setEmail(event.target.value)}
                />
              </label>
              <label className={s.field}>
                <span className="t-label-md c-secondary">{t('비밀번호')}</span>
                <input
                  className={`${s.input} t-body-md`}
                  type="password"
                  name="password"
                  autoComplete="current-password"
                  value={password}
                  aria-invalid={error ? true : undefined}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </label>
              {/* 오류가 떠도 입력칸이 움직이지 않게 자리를 미리 잡아 둔다. */}
              <div className={s.message} role="alert">
                {error && <p className={`${s.error} t-body-md`}>{error}</p>}
              </div>
            </div>
            <div className={s.submit}>
              {signup && <BarPill label={t('회원가입')} icon="user-check" onClick={busy ? undefined : openSignup} />}
              {github && <BarPill label={t('GitHub로 로그인')} icon="github" onClick={busy ? undefined : () => window.location.assign(githubStartUrl(API_BASE))} />}
              <ActionPill type="submit" label={busy ? t('확인 중') : t('로그인')} disabled={busy} />
            </div>
          </form>
        )}
      </Tile>
    </ConsoleLayout>
  );
}
