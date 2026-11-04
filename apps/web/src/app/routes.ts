import { t } from '../lib/i18n';
export type Page = 'dashboard' | 'environments' | 'migrations' | 'audit' | 'agent' | 'settings' | 'designSystem';

export type Route =
  | { page: 'dashboard' | 'settings' | 'designSystem' }
  | { page: 'environments' | 'audit' | 'agent'; id: string | null }
  | { page: 'environments'; view: 'connect'; id: string | null }
  | { page: 'migrations'; view: 'list' }
  | { page: 'migrations'; view: 'new' }
  | { page: 'migrations'; view: 'detail'; id: string }
  | { page: 'migrations'; view: 'cost'; id: string };

export const NAV_ITEMS: { id: Page; label: string }[] = [
  { id: 'dashboard', label: t('대시보드') },
  { id: 'environments', label: t('환경') },
  { id: 'migrations', label: t('마이그레이션') },
  { id: 'audit', label: t('감사') },
  { id: 'agent', label: t('에이전트') },
];

const PICK_PAGES = ['environments', 'audit', 'agent'] as const;

export function parseRoute(hash: string): Route {
  const [first, second, third] = hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  // 환경 등록·연결 이어 하기. 상단 메뉴는 "환경"에 머문다
  if (first === 'environments' && second === 'connect') return { page: 'environments', view: 'connect', id: third ?? null };
  // 보안은 탭이 아니라 이전 화면의 "보안" 카드다. 예전 주소(#/security/:id)는 그 이전 화면으로 보낸다
  if (first === 'security') return second ? { page: 'migrations', view: 'detail', id: second } : { page: 'migrations', view: 'list' };
  const pick = PICK_PAGES.find((page) => page === first);
  if (pick) return { page: pick, id: second ?? null };
  if (first === 'settings') return { page: 'settings' };
  if (first === 'design-system') return { page: 'designSystem' };
  if (first !== 'migrations') return { page: 'dashboard' };
  if (!second) return { page: 'migrations', view: 'list' };
  if (second === 'new') return { page: 'migrations', view: 'new' };
  return third === 'cost' ? { page: 'migrations', view: 'cost', id: second } : { page: 'migrations', view: 'detail', id: second };
}

export const go = (path: string) => {
  window.location.hash = `#/${path}`;
};

/**
 * 뒤로 갈 앱 안 기록이 없을 때(주소를 바로 열었을 때) (←) 이 가는 윗 화면. 탭 첫 화면은 윗 화면이 없다 (null)
 * 감사·에이전트는 마이그레이션을 상단 바에서 고르는 화면이라 윗 화면을 두지 않는다
 */
export function parentOf(route: Route): string | null {
  if (route.page === 'environments') return 'view' in route || route.id ? 'environments' : null;
  if (route.page !== 'migrations') return null;
  if (route.view === 'new' || route.view === 'detail') return 'migrations';
  if (route.view === 'cost') return `migrations/${route.id}`;
  return null;
}
