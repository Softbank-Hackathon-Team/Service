import type { MigrationStatus } from "@svc/contracts";
import type { Tx } from "./db.js";

// 화면 신호 한 줄 (pg_notify 'migration_events'). 신호는 "이 이전을 다시 읽어"라는 뜻이다.
// PA2: advance() 7단계에 있던 SQL 을 꺼냄(동작 같음). 상태를 안 바꾸는 쓰기(명세 수정 등)도 같은 신호를 쓴다
// 모양은 contracts NotifyMigration {t, id, s}. 예전처럼 parse 는 안 한다
// 트랜잭션 안에서 부르면 확정될 때만 나간다. 내용은 회사·이전·상태 번호뿐 (비밀 금지, 8000바이트 제한)
export async function notifyMigration(tx: Tx, n: { t: string; id: string; s: MigrationStatus }): Promise<void> {
  await tx.query("SELECT pg_notify('migration_events', $1)", [JSON.stringify({ t: n.t, id: n.id, s: n.s })]);
}
