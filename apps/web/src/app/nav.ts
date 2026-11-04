import { go, parentOf, parseRoute, type Route } from './routes';

// 히어로 (←) 이 쓰는 앱 안 이동 기록.
// 주소(#/…)가 바뀔 때마다 브라우저 기록 칸(history.state)에 "앱 안에서 몇 번째 화면인지"를 적는다.
// 0 이면 이 탭에서 앱을 처음 연 화면이라, history.back() 은 앱 밖으로 나간다 → 그때는 윗 화면(parentOf)으로 간다

const KEY = 'ironDepth';
let depth = 0;

/** 기록 칸에 적힌 깊이가 있으면 그것(앞뒤로 움직인 것), 없으면 새로 들어온 화면이라 하나 더 */
export const nextDepth = (stored: unknown, current: number) => (typeof stored === 'number' ? stored : current + 1);

const stateDepth = (): unknown => (history.state as Record<string, unknown> | null)?.[KEY];
const mark = (value: number) => history.replaceState({ ...((history.state as object | null) ?? {}), [KEY]: value }, '');

/** main.tsx 에서 화면을 그리기 전에 한 번. App 의 hashchange 보다 먼저 깊이를 맞추려고 먼저 붙인다 */
export function startNav() {
  const stored = stateDepth();
  depth = typeof stored === 'number' ? stored : 0;
  if (typeof stored !== 'number') mark(0);
  window.addEventListener('hashchange', () => {
    const stored = stateDepth();
    depth = nextDepth(stored, depth);
    if (typeof stored !== 'number') mark(depth);
  });
}

/**
 * (←) 이 갈 곳: 'history' = 앱 안 바로 앞 화면, 문자열 = 윗 화면 주소, null = 버튼 없음.
 * 대시보드는 집이라 돌아갈 곳이 없다 (앞 화면 기록이 있어도 두지 않음)
 */
export function backTarget(route: Route, depth: number): 'history' | string | null {
  if (route.page === 'dashboard') return null;
  if (depth > 0) return 'history';
  return parentOf(route);
}

/** 지금 화면의 (←). null 이면 버튼을 두지 않는다 */
export function backAction(): (() => void) | null {
  const target = backTarget(parseRoute(window.location.hash), depth);
  if (target === null) return null;
  return target === 'history' ? () => history.back() : () => go(target);
}
