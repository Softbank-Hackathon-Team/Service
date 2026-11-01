import type { CopyStatus, LagSample } from "./lag.js";

// 전환 가능 판정. 순수 함수라 DB 없이 단위 테스트한다.
export interface GateOpts {
  /** 마커 왕복 지연 상한 (ms). 이보다 크면 컷오버 때 쓰기 멈춤이 길어진다 */
  maxLagMs: number;
  /** 연속으로 몇 번 상한 아래여야 하나 */
  consecutive: number;
  /** 슬롯 바이트 지연 상한. null이면 안 본다 */
  maxSlotBytes?: number | null;
  /** Z52: 슬롯이 끊기기까지 남은 WAL(safe_wal_size)이 이보다 작으면 보류. null이면 안 본다.
   *  DRAFT(ai): 64MB = maxSlotBytes와 같은 값. 컷오버 중 쓰기 멈춤 동안 쌓일 WAL보다 넉넉하면 된다 */
  minSafeWalBytes?: number | null;
}
export const DEFAULT_GATE: GateOpts = { maxLagMs: 1000, consecutive: 3, maxSlotBytes: 64 * 1024 * 1024, minSafeWalBytes: 64 * 1024 * 1024 };

/** fatal = 기다려도 소용없음(슬롯이 이미 무효). 워커는 재시도하지 않고 바로 롤백한다 (Z52, Q16) */
export interface GateResult { ready: boolean; reasons: string[]; lastLags: number[]; fatal?: boolean }

export function judgeCutoverReady(copy: CopyStatus, samples: LagSample[], o: GateOpts = DEFAULT_GATE): GateResult {
  const reasons: string[] = [];
  if (!copy.done) reasons.push(`INITIAL_COPY_NOT_DONE ${copy.ready}/${copy.tables}`);
  const last = samples.slice(-o.consecutive);
  if (last.length < o.consecutive) reasons.push(`NOT_ENOUGH_SAMPLES ${last.length}/${o.consecutive}`);
  const slow = last.filter((s) => s.markerMs > o.maxLagMs);
  if (slow.length) reasons.push(`LAG_OVER_LIMIT ${slow.map((s) => Math.round(s.markerMs)).join(",")}ms > ${o.maxLagMs}ms`);
  if (last.some((s) => !s.slot.workerRunning)) reasons.push("APPLY_WORKER_NOT_RUNNING");
  if (o.maxSlotBytes != null && last.some((s) => s.slot.bytes != null && s.slot.bytes > o.maxSlotBytes!))
    reasons.push(`SLOT_LAG_OVER_LIMIT > ${o.maxSlotBytes}B`);
  // Z52 (Q16): 출발이 max_slot_wal_keep_size로 슬롯을 끊었거나(lost) 끊기 직전(unreserved)이면 컷오버하지 않는다.
  //   lost는 다시 해도 안 돌아온다(초기 복사부터 새로) → fatal. unreserved는 따라잡으면 풀릴 수 있어 보류만
  //   safeWalBytes가 minSafeWalBytes보다 작아도 보류(곧 끊길 슬롯에 컷오버를 걸지 않는다)
  const lost = last.some((s) => s.slot.walStatus === "lost");
  if (lost) reasons.push("SLOT_LOST (출발이 WAL을 지워 슬롯을 끊었다. 복제를 처음부터 다시)");
  else if (last.some((s) => s.slot.walStatus === "unreserved")) reasons.push("SLOT_WAL_UNRESERVED (곧 끊긴다)");
  const minSafe = o.minSafeWalBytes ?? DEFAULT_GATE.minSafeWalBytes;
  if (!lost && minSafe != null && last.some((s) => s.slot.safeWalBytes != null && s.slot.safeWalBytes < minSafe))
    reasons.push(`SLOT_SAFE_WAL_LOW < ${minSafe}B`);
  return { ready: reasons.length === 0, reasons, lastLags: last.map((s) => Math.round(s.markerMs * 10) / 10), ...(lost ? { fatal: true } : {}) };
}
