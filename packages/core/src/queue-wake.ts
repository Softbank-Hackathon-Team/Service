import type { QueueName } from "@svc/contracts";
import type { Tx } from "./db.js";

// 기다리는 작업 깨우기: 같은 작업 키로 미뤄 둔(start_after 미래) 대기 작업을 지금 바로 집히게 한다.
// 리허설이 끝나면 agent-worker 가 RetryLater 로 기다리는 deploy 작업을 깨운다 (설계 2.4). 깨운 작업 수를 돌려준다
// 깨우기가 안 돼도 결과는 같다: 작업이 정해진 간격(REHEARSAL_POLL_SEC) 뒤 스스로 다시 본다
export async function wakeQueued(tx: Tx, queue: QueueName, singletonKey: string): Promise<number> {
  const r = await tx.query(
    `UPDATE pgboss.job SET start_after = now() WHERE name = $1 AND singleton_key = $2 AND state IN ('created', 'retry')`,
    [queue, singletonKey]);
  return r.rowCount ?? 0;
}
