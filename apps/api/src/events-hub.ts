import { NotifyMigration, type SseEvent } from "@svc/contracts";
import { listenChannel, type ChannelListener, type ListenHandlers } from "@svc/core";

// 화면 신호(SSE) 나눠 주기. api 프로세스 하나에 하나.
// DB 알림(advance.ts 가 확정 때 보내는 pg_notify('migration_events', {t, id, s}))을 듣고,
// 같은 회사(t)의 구독자에게만 migration.status_changed 로 보낸다. 다른 회사 알림은 아무에게도 안 간다.
// 신호는 "다시 읽어"라는 뜻이다. 화면은 신호를 받으면 GET 으로 다시 읽는다 (contracts events.ts)

export const MIGRATION_CHANNEL = "migration_events";
export type Listen = (h: ListenHandlers) => ChannelListener;
export type Send = (e: SseEvent) => void;

export const listenMigrationEvents: Listen = (h) => listenChannel(MIGRATION_CHANNEL, h);

export class EventHub {
  private readonly subs = new Map<string, Set<Send>>();
  private listener: ChannelListener | null = null;

  constructor(private readonly listen: Listen = listenMigrationEvents) {}

  /** 구독. 첫 구독 때 DB 를 듣기 시작한다 (서버를 띄우기만 할 때는 DB 에 붙지 않게). 돌려준 함수로 끊는다 */
  subscribe(tenantId: string, send: Send): () => void {
    // 듣기 시작할 때와 다시 붙을 때는 그 사이 알림을 놓쳤을 수 있다 → 지금 붙어 있는 모두에게 "전부 다시 읽어"
    this.listener ??= this.listen({ onNotify: (p) => this.notify(p), onListening: () => this.broadcast({ type: "reload_all" }) });
    let set = this.subs.get(tenantId);
    if (!set) this.subs.set(tenantId, (set = new Set()));
    set.add(send);
    return () => {
      set.delete(send);
      if (set.size === 0 && this.subs.get(tenantId) === set) this.subs.delete(tenantId);
    };
  }

  /** DB 알림 한 건. 모양이 틀리면 버린다 (알림 내용도 경계 입력이라 계약으로 검사) */
  notify(payload: string): void {
    let raw: unknown;
    try { raw = JSON.parse(payload); } catch { return; }
    const n = NotifyMigration.safeParse(raw);
    if (!n.success) return;
    const event: SseEvent = { type: "migration.status_changed", migrationId: n.data.id, status: n.data.s };
    for (const send of this.subs.get(n.data.t) ?? []) send(event);
  }

  broadcast(e: SseEvent): void {
    for (const set of this.subs.values()) for (const send of set) send(e);
  }

  /** 지금 붙어 있는 구독 수 (시험·지표용) */
  get size(): number {
    let n = 0;
    for (const set of this.subs.values()) n += set.size;
    return n;
  }

  async close(): Promise<void> {
    const l = this.listener;
    this.listener = null;
    this.subs.clear();
    await l?.close();
  }
}
