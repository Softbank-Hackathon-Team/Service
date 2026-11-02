// 표시 메모: 로그인. 이메일·비밀번호 + 로그인 버튼. 알림 한 줄, 오류 한 줄, 개발 서버면 "로그인 없이 계속".
//   정보량: 칸 2개, 버튼 1~2개, 세션 안내 한 줄. 서버는 이메일·비밀번호(JWT)이고 GitHub 로그인은 아직 없다.
import { useEffect, useRef, useState, type FormEvent } from "react";
import { AuthError, type Auth, type AuthState } from "../../auth";

// Z96: 로그인 화면. Z83 디자인 시스템 토큰만 쓴다(styles.css .login-*). 그림자·둥근 알약·그라데이션 없음.
// 접근성: 칸마다 label, 오류는 role="alert" 한 줄 + aria-invalid, 보내는 중엔 버튼만 잠근다(입력은 그대로)
//   autocomplete: username / current-password (비밀번호 관리자가 채우게. WHATWG HTML autofill)
export function LoginPage({ auth, state }: { auth: Auth; state: AuthState }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  useEffect(() => { emailRef.current?.focus(); }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !password) { setErr("이메일과 비밀번호를 둘 다 넣어."); return; }
    setBusy(true); setErr(null);
    try { await auth.login(email.trim(), password); setPassword(""); }
    catch (x) { setErr(x instanceof AuthError ? x.message : "서버에 닿지 못했어. API 가 떠 있는지 확인해."); }
    finally { setBusy(false); }
  };

  return (
    <div className="login-wrap">
      <form className="login card" onSubmit={submit} noValidate aria-labelledby="login-title" data-testid="login-form">
        <div className="login-head">
          <h1 id="login-title">이전 콘솔</h1>
          <span className="muted small">멀티클라우드 리플랫폼 · 로그인</span>
        </div>
        {state.notice && <p className="login-note small" role="status" data-testid="login-notice">{state.notice}</p>}
        <label className="login-field">
          <span>이메일</span>
          <input ref={emailRef} type="email" name="email" autoComplete="username" value={email}
            onChange={(e) => setEmail(e.target.value)} aria-invalid={err ? true : undefined} spellCheck={false} />
        </label>
        <label className="login-field">
          <span>비밀번호</span>
          <input type="password" name="password" autoComplete="current-password" value={password}
            onChange={(e) => setPassword(e.target.value)} aria-invalid={err ? true : undefined} />
        </label>
        {err && <p className="bad small" role="alert" data-testid="login-error">{err}</p>}
        <button type="submit" className="primary login-submit" disabled={busy}>{busy ? "확인 중…" : "로그인"}</button>
        {state.devAuth && (
          <button type="button" className="link" onClick={() => auth.continueDev()}>
            로그인 없이 계속 (개발 서버 · x-dev-tenant)
          </button>
        )}
        <p className="muted small">세션은 이 탭 메모리에만 두고, 새로 고침하면 서버 쿠키로 다시 이어 붙어.</p>
      </form>
    </div>
  );
}
