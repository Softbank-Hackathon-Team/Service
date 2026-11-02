export type Page = 'dashboard' | 'environments' | 'migrations' | 'security' | 'audit' | 'agent' | 'settings';

export type Route =
  | { page: 'dashboard' | 'settings' }
  | { page: 'environments' | 'security' | 'audit' | 'agent'; id: string | null }
  | { page: 'migrations'; view: 'list' }
  | { page: 'migrations'; view: 'new' }
  | { page: 'migrations'; view: 'detail'; id: string }
  | { page: 'migrations'; view: 'cost'; id: string };

export const NAV_ITEMS: { id: Page; label: string }[] = [
  { id: 'dashboard', label: '대시보드' },
  { id: 'environments', label: '환경' },
  { id: 'migrations', label: '이전' },
  { id: 'security', label: '보안' },
  { id: 'audit', label: '감사' },
  { id: 'agent', label: '에이전트' },
];

const PICK_PAGES = ['environments', 'security', 'audit', 'agent'] as const;

export function parseRoute(hash: string): Route {
  const [first, second, third] = hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  const pick = PICK_PAGES.find((page) => page === first);
  if (pick) return { page: pick, id: second ?? null };
  if (first === 'settings') return { page: 'settings' };
  if (first !== 'migrations') return { page: 'dashboard' };
  if (!second) return { page: 'migrations', view: 'list' };
  if (second === 'new') return { page: 'migrations', view: 'new' };
  return third === 'cost' ? { page: 'migrations', view: 'cost', id: second } : { page: 'migrations', view: 'detail', id: second };
}

export const go = (path: string) => {
  window.location.hash = `#/${path}`;
};
