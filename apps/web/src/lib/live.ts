import { API_BASE, auth } from './api';
import { createLive } from './events';

// 탭 하나에 화면 신호 연결 하나. App 이 콘솔에 들어오면 붙이고(live.start), 로그인 화면으로 나가면 끊는다(live.stop).
// 토큰과 401 처리는 다른 요청과 같은 auth 를 쓴다
export const live = createLive({
  base: API_BASE,
  token: () => auth.accessToken(),
  onUnauthorized: () => auth.onUnauthorized(),
});
