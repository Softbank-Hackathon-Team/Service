import { NotifyMigration, NotifySession, SESSION_EVENTS_CHANNEL, type SseEvent } from "@svc/contracts";
import { listenChannel, type ChannelListener, type ListenHandlers } from "@svc/core";

// 화면 신호(SSE) 나눠 주기. api 프로세스 하나에 하나.
// DB 알림(advance.ts 가 확정 때 보내는 pg_notify('migration_events', {t, id, s}))을 듣고,
// 같은 회사(t)의 구독자에게만 migration.status_changed 로 보낸다. 다른 회사 알림은 아무에게도 안 간다.
// 신호는 "다시 읽어"라는 뜻이다. 화면은 신호를 받으면 GET 으로 다시 읽는다 (contracts events.ts)
// L8: 세션 끊김 알림(pg_notify('session_events', {t, u, r}))도 듣는다. 로그아웃·사용자 끄기·멤버 제거가 오면
// 그 회사(t)·사용자(u)의 연결을 이유와 상관없이 전부 닫는다. 화면은 다시 붙으면서 인증 훅(재확인·차단 목록)을 다시 지난다.
// 끊긴 사이 놓친 세션 알림은 연결 수명 상한(routes/events.ts, 토큰 만료)이 막는다

export const MIGRATION_CHANNEL = "migration_events";
export type Listen = (h: ListenHandlers) => ChannelListener;
export type Send = (e: SseEvent) => void;
/** userId = 연결을 연 사용자 (개발용 헤더 인증처럼 없으면 세션 알림으로는 안 닫힌다). close = 세션 알림으로 닫을 때 부른다 */
export interface SubscribeOptions { userId?: string | null; close?: () => void }
interface Sub { send: Send; userId: string | null; close?: () => void }

export const listenMigrationEvents: Listen = (h) => listenChannel(MIGRATION_CHANNEL, h);
export const listenSessionEvents: Listen = (h) => listenChannel(SESSION_EVENTS_CHANNEL, h);

export class EventHub {
  private readonly subs = new Map<string, Set<Sub>>();
  private listener: ChannelListener | null = null;
  private sessionListener: ChannelListener | null = null;

  constructor(
    private readonly listen: Listen = listenMigrationEvents,
    private readonly listenSessions: Listen = listenSessionEvents,
  ) {}

  /** 구독. 첫 구독 때 DB 를 듣기 시작한다 (서버를 띄우기만 할 때는 DB 에 붙지 않게). 돌려준 함수로 끊는다 */
  subscribe(tenantId: string, send: Send, o: SubscribeOptions = {}): () => void {
    // 듣기 시작할 때와 다시 붙을 때는 그 사이 알림을 놓쳤을 수 있다 → 지금 붙어 있는 모두에게 "전부 다시 읽어"
    this.listener ??= this.listen({ onNotify: (p) => this.notify(p), onListening: () => this.broadcast({ type: "reload_all" }) });
    this.sessionListener ??= this.listenSessions({ onNotify: (p) => this.notifySession(p) });
    let set = this.subs.get(tenantId);
    if (!set) this.subs.set(tenantId, (set = new Set()));
    const sub: Sub = { send, userId: o.userId ?? null, close: o.close };
    set.add(sub);
    return () => this.drop(tenantId, set, sub);
  }

  /** DB 알림 한 건. 모양이 틀리면 버린다 (알림 내용도 경계 입력이라 계약으로 검사) */
  notify(payload: string): void {
    const n = parseNotify(payload, NotifyMigration);
    if (!n) return;
    const event: SseEvent = { type: "migration.status_changed", migrationId: n.id, status: n.s };
    for (const sub of this.subs.get(n.t) ?? []) sub.send(event);
  }

  /** 세션 끊김 알림 한 건. 그 회사·사용자의 구독을 풀고 연결을 닫는다. 모양이 틀리면 버린다 */
  notifySession(payload: string): void {
    const n = parseNotify(payload, NotifySession);
    if (!n) return;
    const set = this.subs.get(n.t);
    if (!set) return;
    for (const sub of [...set]) {
      if (sub.userId !== n.u) continue;
      this.drop(n.t, set, sub);
      sub.close?.();
    }
  }

  broadcast(e: SseEvent): void {
    for (const set of this.subs.values()) for (const sub of set) sub.send(e);
  }

  /** 지금 붙어 있는 구독 수 (시험·지표용) */
  get size(): number {
    let n = 0;
    for (const set of this.subs.values()) n += set.size;
    return n;
  }

  async close(): Promise<void> {
    const ls = [this.listener, this.sessionListener];
    this.listener = null;
    this.sessionListener = null;
    this.subs.clear();
    await Promise.all(ls.map((l) => l?.close()));
  }

  private drop(tenantId: string, set: Set<Sub>, sub: Sub): void {
    set.delete(sub);
    if (set.size === 0 && this.subs.get(tenantId) === set) this.subs.delete(tenantId);
  }
}

function parseNotify<T>(payload: string, schema: { safeParse(v: unknown): { success: true; data: T } | { success: false } }): T | null {
  let raw: unknown;
  try { raw = JSON.parse(payload); } catch { return null; }
  const n = schema.safeParse(raw);
  return n.success ? n.data : null;
}
