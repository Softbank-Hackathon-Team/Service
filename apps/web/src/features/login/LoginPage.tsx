import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ConsoleLayout, type BentoLayout } from '../../components/layout/ConsoleLayout';
import { Hero, Tile, TileHeader } from '../../components/layout/tiles';
import { ActionPill, BarPill } from '../../components/ui/controls';
import { API_BASE, auth } from '../../lib/api';
import { AuthError, githubErrorText, githubStartUrl, takeGithubError } from '../../lib/auth';
import s from './LoginPage.module.css';

const LOGIN: BentoLayout = { columns: ['fill', 'side'], areas: 'hero form' };

export function LoginPage({ notice }: { notice: string | null }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [github, setGithub] = useState(false);
  const emailRef = useRef<HTMLInputElement>(null);

  useEffect(() => emailRef.current?.focus(), []);

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
      setError('이메일과 비밀번호를 모두 입력해 주세요.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await auth.login(email.trim(), password);
    } catch (reason) {
      setError(reason instanceof AuthError ? reason.message : '서버에 연결하지 못했습니다. 잠시 뒤 다시 시도해 주세요.');
      setBusy(false);
    }
  };

  return (
    <ConsoleLayout layout={LOGIN}>
      <Hero tone="run" meta="Kross AI 콘솔" title={'돌고 있는 앱을\n멈추지 않고 옮깁니다'} />
      <Tile area="form">
        <form className={s.form} onSubmit={submit} noValidate aria-label="로그인">
          <TileHeader title="로그인" />
          {notice && (
            <p className={`${s.notice} t-body-md`} role="status">
              {notice}
            </p>
          )}
          <div className={s.fields}>
            <label className={s.field}>
              <span className="t-label-md c-secondary">이메일</span>
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
              <span className="t-label-md c-secondary">비밀번호</span>
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
            {github && <BarPill label="GitHub로 로그인" icon="github" onClick={busy ? undefined : () => window.location.assign(githubStartUrl(API_BASE))} />}
            <ActionPill type="submit" label={busy ? '확인 중' : '로그인'} disabled={busy} />
          </div>
        </form>
      </Tile>
    </ConsoleLayout>
  );
}
