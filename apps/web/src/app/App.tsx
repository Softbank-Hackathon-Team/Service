import { useEffect, useState } from 'react';
import { AgentPage } from '../features/agent/AgentPage';
import { AuditPage } from '../features/audit/AuditPage';
import { CostPage } from '../features/cost/CostPage';
import { DashboardPage } from '../features/dashboard/DashboardPage';
import { DesignSystemPage } from '../features/design-system/DesignSystemPage';
import { ConnectPage } from '../features/environments/ConnectPage';
import { EnvironmentsPage } from '../features/environments/EnvironmentsPage';
import { LoginPage } from '../features/login/LoginPage';
import { MigrationPage } from '../features/migration/MigrationPage';
import { MigrationsPage } from '../features/migration/MigrationsPage';
import { NewMigrationPage } from '../features/migration/NewMigrationPage';
import { SettingsPage } from '../features/settings/SettingsPage';
import { auth } from '../lib/api';
import { live } from '../lib/live';
import type { AuthState } from '../lib/auth';
import { go, parseRoute } from './routes';
import { withTransition } from './transition';

type View = 'checking' | 'login' | 'console';

const viewOf = ({ ready, user }: AuthState): View => (!ready ? 'checking' : user ? 'console' : 'login');

export function App() {
  const [state, setState] = useState(auth.get);
  const [hash, setHash] = useState(window.location.hash);

  useEffect(() => {
    const unsubscribe = auth.subscribe(() => {
      const next = auth.get();
      // 로그인 ↔ 콘솔이 바뀔 때만 타일을 움직인다. 쿠키로 바로 들어오는 첫 확인은 움직이지 않는다.
      const moves = viewOf(state) !== 'checking' && viewOf(next) !== viewOf(state);
      if (moves) withTransition(() => setState(next));
      else setState(next);
    });
    void auth.bootstrap();
    return unsubscribe;
  }, [state]);

  useEffect(() => {
    const onHashChange = () => withTransition(() => setHash(window.location.hash));
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const view = viewOf(state);
  // 화면 신호(SSE)는 콘솔에 있는 동안만 붙여 둔다. 로그아웃하면 끊는다
  useEffect(() => {
    if (view !== 'console') return;
    live.start();
    return () => live.stop();
  }, [view]);

  if (view === 'checking') return null;
  if (view === 'login') return <LoginPage notice={state.notice} />;

  const route = parseRoute(hash);
  switch (route.page) {
    case 'dashboard':
      return <DashboardPage />;
    case 'environments':
      return 'view' in route ? <ConnectPage key={route.id ?? 'new'} id={route.id} /> : <EnvironmentsPage id={route.id} />;
    case 'audit':
      return <AuditPage id={route.id} />;
    case 'agent':
      return <AgentPage id={route.id} />;
    case 'settings':
      return <SettingsPage user={state.user!} />;
    case 'designSystem':
      return <DesignSystemPage onExit={() => go('')} />;
    case 'migrations':
      if (route.view === 'list') return <MigrationsPage />;
      if (route.view === 'new') return <NewMigrationPage />;
      if (route.view === 'cost') return <CostPage key={route.id} id={route.id} />;
      return <MigrationPage key={route.id} id={route.id} />;
  }
}
