import type { MigrationStatus } from './types';

// 화면 신호 (SSE). 서버 GET /api/v1/events 가 로그인한 회사의 신호를 계속 보낸다.
// 신호는 "다시 읽어"라는 뜻이다 (contracts events.ts). 화면은 신호를 받으면 그 GET 을 바로 다시 부르고,
// 연결이 살아 있는 동안에는 폴링 간격을 늘린다 (usePoll 의 signal 옵션). 연결이 없으면 지금 폴링 그대로다.
// 브라우저 EventSource 는 Authorization 머리말을 못 붙인다 → fetch 로 스트림을 읽고 SSE 줄을 직접 푼다
// (HTML 표준 "Server-sent events"의 해석 규칙 중 data·retry·주석만 쓴다. 서버가 event·id 줄을 안 보낸다)
// Vite(import.meta.env)를 안 쓰는 순수 모듈이라 node:test 로 바로 시험한다 (test/events.test.ts)

// contracts/src/events.ts 의 SseEvent 그대로
export type SseEvent =
  | { type: 'migration.status_changed'; migrationId: string; status: MigrationStatus }
  | { type: 'weight_changed'; migrationId: string; targetPct: number }
  | { type: 'rollback_started'; migrationId: string; reason: string }
  | { type: 'rollback_done'; migrationId: string; recoverSec: number }
  | { type: 'matrix_changed'; envId: string }
  | { type: 'agent.step'; agentRunId: string; step: number }
  | { type: 'reload_all' };

/** off: 로그아웃·시작 전 / connecting: 붙는 중 / open: 신호가 오는 중 / retrying: 끊겨서 다시 붙기를 기다림 */
export type LiveState = 'off' | 'connecting' | 'open' | 'retrying';

/** 이 이전에 관한 신호이거나 전부 다시 읽기 */
export const aboutMigration = (id: string) => (e: SseEvent) => e.type === 'reload_all' || ('migrationId' in e && e.migrationId === id);
/** 어느 이전이든 바뀌었거나 전부 다시 읽기 (이전 목록용) */
export const anyMigration = (e: SseEvent) => e.type === 'reload_all' || 'migrationId' in e;

// DRAFT(ai): 신호 연결이 살아 있을 때 signal 을 준 폴링의 간격 하한. 신호를 놓쳐도 이 시간 안에는 맞춰진다
export const LIVE_FALLBACK_MS = 10_000;

/**
 * 폴링 간격. 신호를 듣고 있고 연결이 살아 있을 때만 간격을 LIVE_FALLBACK_MS 이상으로 늘린다.
 * floor = false 는 "이 화면은 상태가 안 바뀌어도 값이 바뀐다"는 뜻이다 (워커 단계: 진행 숫자는 신호가 오지 않는다).
 * 그때는 연결이 살아 있어도 원래 간격 그대로 둔다. ms = null 이면 간격 없음 그대로.
 */
export function pollInterval(ms: number | null, o: { listening: boolean; liveOpen: boolean; floor: boolean }): number | null {
  if (ms === null) return null;
  return o.listening && o.liveOpen && o.floor ? Math.max(ms, LIVE_FALLBACK_MS) : ms;
}

/** 받은 글자 조각을 줄로 풀어 빈 줄마다 data 한 건을 낸다. 조각 경계가 줄 가운데여도 된다 */
export function createSseParser(onData: (data: string) => void, onRetry?: (ms: number) => void) {
  let buffer = '';
  let data: string[] = [];
  return (chunk: string) => {
    buffer += chunk;
    for (;;) {
      const at = buffer.search(/\r\n|\r|\n/);
      if (at < 0) return;
      // 조각이 \r 로 끝나면 다음 조각이 \n 으로 시작할 수 있다 (\r\n 한 줄바꿈). 다음 조각을 기다린다
      if (buffer[at] === '\r' && at === buffer.length - 1) return;
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + (buffer.startsWith('\r\n', at) ? 2 : 1));
      if (line === '') {
        if (data.length > 0) onData(data.join('\n'));
        data = [];
        continue;
      }
      if (line.startsWith(':')) continue; // 연결 유지용 주석
      const colon = line.indexOf(':');
      const field = colon < 0 ? line : line.slice(0, colon);
      let value = colon < 0 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'data') data.push(value);
      else if (field === 'retry' && /^\d+$/.test(value)) onRetry?.(Number(value));
    }
  };
}

/** data 한 건 → 신호. JSON 이 아니거나 type 이 없으면 버린다 */
export function parseEvent(data: string): SseEvent | null {
  try {
    const value: unknown = JSON.parse(data);
    return value && typeof value === 'object' && typeof (value as { type?: unknown }).type === 'string' ? (value as SseEvent) : null;
  } catch {
    return null;
  }
}

// DRAFT(ai): 다시 붙는 간격. 서버가 보낸 retry(3초)를 따르고, 붙지도 못하고 연달아 실패하면 두 배씩 늘려 30초에서 멈춘다
//   (서버에 경로가 없는 배포에서 3초마다 404 를 내지 않게)
export const RECONNECT = { firstMs: 3000, maxMs: 30_000 };

export interface EventsOptions {
  base: string; // 예: "/api"
  fetch?: typeof fetch; // 시험용
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>; // 시험용
  token?: () => Promise<string | null>;
  // 401 을 맞으면 한 번 부른다(refresh). true 면 새 토큰으로 바로 다시 붙는다
  onUnauthorized?: () => Promise<boolean>;
  onEvent: (e: SseEvent) => void;
  onState?: (s: LiveState) => void;
}

const sleepFor = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });

/** 신호 연결 하나. 끊기면 혼자 다시 붙는다. close() 로 끝낸다 */
export function connectEvents(o: EventsOptions): { close(): void } {
  const doFetch = o.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const sleep = o.sleep ?? sleepFor;
  const stop = new AbortController();
  let wait = RECONNECT.firstMs;
  let failures = 0;
  let reauthed = false;

  void (async () => {
    o.onState?.('connecting');
    while (!stop.signal.aborted) {
      let opened = false;
      try {
        const bearer = o.token ? await o.token() : null;
        const res = await doFetch(`${o.base}/events`, {
          headers: { accept: 'text/event-stream', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
          credentials: 'same-origin',
          cache: 'no-store',
          signal: stop.signal,
        });
        if (res.status === 401 && o.onUnauthorized && !reauthed) {
          reauthed = true;
          if (await o.onUnauthorized()) continue;
        }
        if (!res.ok || !res.body || !(res.headers.get('content-type') ?? '').startsWith('text/event-stream'))
          throw new Error(`events: HTTP ${res.status}`);
        opened = true;
        failures = 0;
        reauthed = false;
        o.onState?.('open');
        const parse = createSseParser(
          (data) => { const e = parseEvent(data); if (e) o.onEvent(e); },
          (ms) => { wait = ms; },
        );
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          parse(value);
        }
      } catch {
        // 네트워크 오류, 서버가 끊음, close() — 아래에서 가른다
      }
      if (stop.signal.aborted) break;
      if (!opened) failures++;
      o.onState?.('retrying');
      await sleep(Math.min(RECONNECT.maxMs, wait * 2 ** Math.max(0, failures - 1)), stop.signal);
    }
    o.onState?.('off');
  })();

  return { close: () => stop.abort() };
}

/** 탭 하나가 나눠 쓰는 신호 연결. 화면은 subscribe 로 신호를, watch·state 로 연결 상태를 본다 */
export function createLive(o: Omit<EventsOptions, 'onEvent' | 'onState'>) {
  const listeners = new Set<(e: SseEvent) => void>();
  const watchers = new Set<() => void>();
  let state: LiveState = 'off';
  let conn: { close(): void } | null = null;
  let gen = 0; // 끊은 옛 연결이 늦게 보내는 상태·신호는 버린다 (로그아웃 직후 다시 로그인)
  let openedBefore = false;

  const emit = (e: SseEvent) => { for (const f of [...listeners]) f(e); };
  const setState = (next: LiveState) => {
    if (next === state) return;
    // 다시 붙었으면 끊긴 사이 신호를 놓쳤을 수 있다 → 듣는 쪽이 모두 한 번 다시 읽게 한다
    if (next === 'open' && openedBefore) emit({ type: 'reload_all' });
    if (next === 'open') openedBefore = true;
    state = next;
    for (const f of [...watchers]) f();
  };

  return {
    start() {
      if (conn) return;
      const mine = ++gen;
      openedBefore = false;
      conn = connectEvents({
        ...o,
        onEvent: (e) => { if (mine === gen) emit(e); },
        onState: (s) => { if (mine === gen) setState(s); },
      });
    },
    stop() {
      gen++;
      conn?.close();
      conn = null;
      setState('off');
    },
    subscribe(f: (e: SseEvent) => void) {
      listeners.add(f);
      return () => { listeners.delete(f); };
    },
    watch(f: () => void) {
      watchers.add(f);
      return () => { watchers.delete(f); };
    },
    state: () => state,
  };
}

export type Live = ReturnType<typeof createLive>;
