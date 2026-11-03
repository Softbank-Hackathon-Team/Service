import pg from "pg";
import { createLogger } from "./obs/log.js";
import type { MigrationStatus } from "@svc/contracts";
import type { Tx } from "./db.js";

// DB 알림(LISTEN)을 듣는 연결 하나. api 가 화면 신호(SSE, GET /events)를 내보낼 때 쓴다.
// 일반 풀(pool)을 쓰지 않는다: 듣는 동안 연결을 계속 쥐고 있어야 하는데, 풀은 한 칸을 계속 차지하고 쉬는 연결을 닫는다
// 끊기면 retryMs 뒤에 다시 붙는다. 끊긴 사이의 알림은 잃는다. 그래서 붙을 때마다 onListening 을 불러
// 받는 쪽이 "전부 다시 읽어"를 보내게 한다 (처음 붙을 때도: 듣기 전에 연결한 구독자가 있을 수 있다)
// PgBouncer transaction 모드 뒤에서는 LISTEN 이 안 된다 (boss.ts 의 NOTIFY 깨우기와 같은 제약)
export interface ChannelListener { close(): Promise<void> }
export interface ListenHandlers {
  onNotify: (payload: string) => void;
  onListening?: () => void;
}

const log = createLogger(process.env.SERVICE_NAME ?? "svc", { component: "pg-listen" });
// 채널 이름은 SQL 에 그대로 들어간다(LISTEN 은 매개변수를 못 받음). 글자를 제한한다
const CHANNEL = /^[a-z_][a-z0-9_]*$/;
// DRAFT(ai): 다시 붙기까지 기다리는 시간
export const LISTEN_RETRY_MS = 2000;

export function listenChannel(channel: string, h: ListenHandlers,
  o: { connectionString?: string; retryMs?: number } = {}): ChannelListener {
  if (!CHANNEL.test(channel)) throw new Error(`invalid channel name: ${channel}`);
  const retryMs = o.retryMs ?? LISTEN_RETRY_MS;
  let client: pg.Client | null = null;
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const later = () => { if (!closed) timer = setTimeout(() => void connect(), retryMs); };

  async function connect() {
    const c = new pg.Client({ connectionString: o.connectionString ?? process.env.DATABASE_URL });
    c.on("notification", (m) => { if (m.channel === channel && m.payload !== undefined) h.onNotify(m.payload); });
    // 처리기가 없으면 연결 오류가 프로세스를 죽인다. 끊김 처리는 아래 end 에서
    c.on("error", (err) => log.warn({ err, channel }, "listen connection error"));
    c.on("end", () => { if (client !== c) return; client = null; log.warn({ channel }, "listen connection ended, retrying"); later(); });
    try {
      await c.connect();
      await c.query(`LISTEN ${channel}`);
    } catch (err) {
      log.warn({ err, channel }, "listen connect failed, retrying");
      await c.end().catch(() => {});
      later();
      return;
    }
    if (closed) { await c.end().catch(() => {}); return; }
    client = c;
    h.onListening?.();
  }

  void connect();
  return {
    async close() {
      closed = true;
      clearTimeout(timer);
      const c = client;
      client = null;
      await c?.end().catch(() => {});
    },
  };
}

// 화면 신호 한 줄 (pg_notify 'migration_events'). 신호는 "이 이전을 다시 읽어"라는 뜻이다.
// PA2: advance() 7단계에 있던 SQL 을 꺼냄(동작 같음). 상태를 안 바꾸는 쓰기(명세 수정 등)도 같은 신호를 쓴다
// 모양은 contracts NotifyMigration {t, id, s}. 예전처럼 parse 는 안 한다
// 트랜잭션 안에서 부르면 확정될 때만 나간다. 내용은 회사·이전·상태 번호뿐 (비밀 금지, 8000바이트 제한)
export async function notifyMigration(tx: Tx, n: { t: string; id: string; s: MigrationStatus }): Promise<void> {
  await tx.query("SELECT pg_notify('migration_events', $1)", [JSON.stringify({ t: n.t, id: n.id, s: n.s })]);
}
