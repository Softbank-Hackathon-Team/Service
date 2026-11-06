import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { go } from '../../app/routes';
import { TileHeader } from '../../components/layout/tiles';
import { ActionPill, BarPill } from '../../components/ui/controls';
import { auth } from '../../lib/api';
import { AuthError, signupBody, signupFormError, type SignupForm as Fields } from '../../lib/auth';
import { t } from '../../lib/i18n';
import s from './LoginPage.module.css';

const EMPTY: Fields = { login: '', code: '', password: '', confirm: '' };

/**
 * 팀 가입. 로그인 화면과 같은 카드·같은 입력칸 모양.
 * 성공하면 로그인과 같은 길(auth.accept)로 콘솔에 들어가고, 서버가 미리 만든 내 칸의 환경이 보이게 환경 화면을 연다
 */
export function SignupForm({ onBack }: { onBack: () => void }) {
  const [fields, setFields] = useState<Fields>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loginRef = useRef<HTMLInputElement>(null);

  useEffect(() => loginRef.current?.focus(), []);

  const bind = (key: keyof Fields) => ({
    value: fields[key],
    'aria-invalid': error ? true : undefined,
    onChange: (event: ChangeEvent<HTMLInputElement>) => setFields((prev) => ({ ...prev, [key]: event.target.value })),
  });

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const invalid = signupFormError(fields);
    if (invalid) {
      setError(invalid);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await auth.signup(signupBody(fields));
      go('environments');
    } catch (reason) {
      setError(reason instanceof AuthError ? reason.message : t('서버에 연결하지 못했습니다. 잠시 뒤 다시 시도해 주세요.'));
      setBusy(false);
    }
  };

  return (
    <form className={s.form} onSubmit={submit} noValidate aria-label={t('회원가입')}>
      <TileHeader title={t('회원가입')} />
      <div className={s.fields}>
        <label className={s.field}>
          <span className="t-label-md c-secondary">{t('아이디')}</span>
          <input
            ref={loginRef}
            className={`${s.input} t-body-md`}
            type="text"
            name="login"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            {...bind('login')}
          />
        </label>
        <label className={s.field}>
          <span className="t-label-md c-secondary">{t('초대 코드')}</span>
          <input className={`${s.input} t-body-md`} type="text" name="invite-code" autoComplete="off" autoCapitalize="none" spellCheck={false} {...bind('code')} />
        </label>
        <label className={s.field}>
          <span className="t-label-md c-secondary">{t('비밀번호')}</span>
          <input className={`${s.input} t-body-md`} type="password" name="password" autoComplete="new-password" {...bind('password')} />
        </label>
        <label className={s.field}>
          <span className="t-label-md c-secondary">{t('비밀번호 확인')}</span>
          <input className={`${s.input} t-body-md`} type="password" name="confirm-password" autoComplete="new-password" {...bind('confirm')} />
        </label>
        {/* 오류가 떠도 입력칸이 움직이지 않게 자리를 미리 잡아 둔다. */}
        <div className={s.message} role="alert">
          {error && <p className={`${s.error} t-body-md`}>{error}</p>}
        </div>
      </div>
      <div className={s.submit}>
        <BarPill label={t('로그인으로 돌아가기')} icon="arrow-left" onClick={busy ? undefined : onBack} />
        <ActionPill type="submit" label={busy ? t('가입 중') : t('가입하기')} disabled={busy} />
      </div>
      <p className="t-body-sm c-secondary">{t('초대 코드는 운영자에게 따로 받습니다. 가입하면 내 칸의 환경이 환경 화면에 미리 만들어집니다.')}</p>
    </form>
  );
}
