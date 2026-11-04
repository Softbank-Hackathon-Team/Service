import type { Tx } from "./db.js";

// 같은 작업 키로 이미 기다리는 작업(created·retry)을 지금 시작하게 당긴다. 바뀐 줄 수를 돌려준다 (0 = 기다리는 작업 없음)
// stately 큐는 키마다 대기 1건만 받아 새로 넣으면 send 가 null 이다. 그래서 새로 넣지 않고 start_after 만 당긴다
//   쓰는 곳: API 회수 버튼(cleanup 작업), agent-worker 리허설 결과 저장 뒤(deploy 작업, RetryLater 로 기다리는 중)
export async function wakeQueued(tx: Tx, queue: string, singletonKey: string): Promise<number> {
  const r = await tx.query(
    `UPDATE pgboss.job SET start_after = now() WHERE name = $1 AND singleton_key = $2 AND state IN ('created', 'retry')`,
    [queue, singletonKey]);
  return r.rowCount ?? 0;
}
