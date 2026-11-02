import { flushSync } from 'react-dom';

const pendingUpdates: (() => void)[] = [];

/**
 * 지원되는 브라우저에서는 타일이 새 자리로 움직이고, 아니면 바로 바뀐다.
 * 전환이 겹치면 콜백이 늦거나 순서 없이 불릴 수 있어서, 먼저 불린 콜백이 쌓인 변경을 순서대로 모두 적용한다.
 */
export function withTransition(update: () => void) {
  pendingUpdates.push(update);
  // 탭이 가려져 있으면 전환 콜백이 다시 보일 때까지 밀릴 수 있어서 바로 적용한다.
  // 렌더 효과 안에서도 불리므로 이 길에서는 flushSync를 쓰지 않는다.
  if (!document.startViewTransition || document.hidden) {
    pendingUpdates.splice(0).forEach((apply) => apply());
    return;
  }
  const applyPending = () => flushSync(() => pendingUpdates.splice(0).forEach((apply) => apply()));
  // 연달아 누르거나 탭이 가려지면 애니메이션만 건너뛴다.
  document.startViewTransition(applyPending).ready.catch(() => {});
}
