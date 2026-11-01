import { StrictMode, useEffect, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { auth } from "./api";
import { LoginPage } from "./pages/login/LoginPage";
import "./fonts.css";
import "./styles.css";

// Z96: 첫 화면 전에 로그인 상태를 정한다 (GET /auth/config → POST /auth/refresh).
//   dev(DEV_AUTH=1, 옛 서버) → 예전 화면 그대로 · jwt + 토큰 → 화면 · jwt + 토큰 없음/401 → 로그인 화면
function Root() {
  const state = useSyncExternalStore(auth.subscribe, auth.get);
  useEffect(() => { void auth.bootstrap(); }, []);
  if (state.mode === "unknown") return <div className="login-wrap muted" role="status">로그인 상태 확인 중…</div>;
  if (state.mode === "jwt" && (state.needLogin || !state.user)) return <LoginPage auth={auth} state={state} />;
  return <App key={state.user?.id ?? "dev"} authUser={state.user} onLogout={() => void auth.logout()} onLogin={state.devAuth ? () => auth.askLogin() : undefined} />;
}

createRoot(document.getElementById("root")!).render(<StrictMode><Root /></StrictMode>);
