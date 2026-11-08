// 온프레 Agent 루프(tools/onprem-agent.ts loop)의 시간표. heartbeat·deploys 는 매 차례(--every), 무거운 보고(security·facts·inventory)는 시간 기준
//   #373 A3: 예전엔 "10번에 1번"이라 --every 를 30 → 10 으로 줄이면 무거운 보고도 3배가 됐다 → 마지막으로 시작한 시각 기준으로 바꿨다
// DRAFT(ai): 300초. 예전 기본(30초 × 10번)과 같다. 워커 가져오기 신선도 상한(IMPORT_INVENTORY_MAX_AGE_SEC 600초) 안에 두 번 보낸다
export const SLOW_REPORT_PERIOD_MS = 300_000;

/** 처음 부르면 true, 그 뒤로는 마지막 true 에서 periodMs 가 지났을 때만 true */
export function periodic(periodMs: number): (nowMs: number) => boolean {
  let last: number | undefined;
  return (nowMs) => {
    if (last !== undefined && nowMs - last < periodMs) return false;
    last = nowMs;
    return true;
  };
}
