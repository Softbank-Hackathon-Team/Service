import { test } from "node:test";
import assert from "node:assert/strict";
import {
  aboutMigration, anyMigration, connectEvents, createLive, createSseParser, LIVE_FALLBACK_MS, parseEvent, pollInterval, RECONNECT,
  type LiveState, type SseEvent,
} from "../src/lib/events";

// 화면 신호(SSE)를 브라우저 없이 확인한다: 줄 풀기, fetch 스트림 연결(401 → 갱신, 끊기면 다시 붙기, 늘어나는 대기), 탭 하나의 연결 묶음

const M = "22222222-2222-4222-8222-222222222222";
const status = (id: string, s: string) => `data: {"type":"migration.status_changed","migrationId":"${id}","status":"${s}"}\n\n`;

test("줄 풀기: 조각 경계·CRLF·주석·여러 줄 data·retry", () => {
  const got: string[] = [];
  const retries: number[] = [];
  const feed = createSseParser((d) => got.push(d), (ms) => retries.push(ms));
  feed("retry: 2500\n\n: ping\n\nda");
  feed('ta: {"a"');
  feed(":1}\r");            // \r 로 끝난 조각: 다음 \n 과 한 줄바꿈
  feed("\n\r\n");
  feed("data: one\ndata:two\n\n");
  feed("event: ignored\ndata\n\n");  // 콜론 없는 data = 빈 값
  feed("retry: soon\n\n");           // 숫자가 아니면 무시
  assert.deepEqual(got, ['{"a":1}', "one\ntwo", ""]);
  assert.deepEqual(retries, [2500]);
});

test("신호 해석: JSON 이 아니거나 type 이 없으면 버린다, 이전 신호 고르기", () => {
  assert.equal(parseEvent("nope"), null);
  assert.equal(parseEvent('{"migrationId":"x"}'), null);
  const e = parseEvent(status(M, "cutover").slice(6, -2))!;
  assert.deepEqual(e, { type: "migration.status_changed", migrationId: M, status: "cutover" });
  assert.equal(aboutMigration(M)(e), true);
  assert.equal(aboutMigration("other")(e), false);
  assert.equal(aboutMigration("other")({ type: "reload_all" }), true);
  assert.equal(anyMigration(e), true);
  assert.equal(anyMigration({ type: "matrix_changed", envId: "e" }), false);
});

/** 시험이 조각을 밀어 넣는 SSE 응답. fetch 의 signal 이 끊기면 스트림도 끊긴다 */
function sse(signal?: AbortSignal | null, type = "text/event-stream") {
  let ctrl!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(c) { ctrl = c; } });
  signal?.addEventListener("abort", () => { try { ctrl.error(new DOMException("aborted", "AbortError")); } catch { /* 이미 닫힘 */ } });
  const enc = new TextEncoder();
  return {
    res: new Response(body, { status: 200, headers: { "content-type": type } }),
    push: (s: string) => ctrl.enqueue(enc.encode(s)),
    end: () => ctrl.close(),
  };
}

type Step = number | "stream";
function scripted(steps: Step[]) {
  const calls: { auth: string | null }[] = [];
  const streams: ReturnType<typeof sse>[] = [];
  const f = (async (_url: string, init: RequestInit) => {
    calls.push({ auth: (init.headers as Record<string, string>).authorization ?? null });
    const step = steps[calls.length - 1] ?? "stream";
    if (typeof step === "number") return new Response("{}", { status: step, headers: { "content-type": "application/json" } });
    const s = sse(init.signal);
    streams.push(s);
    return s.res;
  }) as unknown as typeof fetch;
  return { f, calls, streams };
}
const until = async (ok: () => boolean) => {
  for (let i = 0; i < 400; i++) { if (ok()) return; await new Promise((r) => setTimeout(r, 5)); }
  throw new Error("timeout");
};

test("연결: 401 이면 갱신 후 새 토큰으로 다시 붙고, 신호를 넘기고, 끊기면 서버 retry 만큼 쉬고 다시 붙는다", async () => {
  const net = scripted([401, "stream", "stream"]);
  let token = "old";
  const events: SseEvent[] = [];
  const states: LiveState[] = [];
  const sleeps: number[] = [];
  const c = connectEvents({
    base: "/api", fetch: net.f, token: async () => token,
    onUnauthorized: async () => { token = "new"; return true; },
    onEvent: (e) => events.push(e), onState: (s) => states.push(s),
    sleep: async (ms) => { sleeps.push(ms); },
  });
  await until(() => net.streams.length === 1);
  assert.deepEqual(net.calls.map((x) => x.auth), ["Bearer old", "Bearer new"]);
  net.streams[0]!.push("retry: 1234\n\n");
  net.streams[0]!.push(status(M, "syncing"));
  await until(() => events.length === 1);
  assert.deepEqual(events[0], { type: "migration.status_changed", migrationId: M, status: "syncing" });
  net.streams[0]!.end();                       // 서버가 끊음 (배포·재시작)
  await until(() => net.streams.length === 2);
  assert.deepEqual(sleeps, [1234]);
  c.close();
  await until(() => states.at(-1) === "off");
  assert.deepEqual(states, ["connecting", "open", "retrying", "open", "off"]);
});

test("연결: 붙지 못하면 대기를 두 배씩 늘려 30초에서 멈춘다, 이벤트 스트림이 아닌 200 도 실패로 본다", async () => {
  const net = scripted([404, 503, 404, 404, 404, 404, 200]);
  const sleeps: number[] = [];
  const c = connectEvents({ base: "/api", fetch: net.f, onEvent: () => {}, sleep: async (ms) => { sleeps.push(ms); } });
  await until(() => net.streams.length === 1);
  c.close();
  const f = RECONNECT.firstMs;
  assert.deepEqual(sleeps, [f, f * 2, f * 4, f * 8, RECONNECT.maxMs, RECONNECT.maxMs, RECONNECT.maxMs]);
});

test("탭 묶음: 다시 붙으면 듣는 쪽에 전부 다시 읽기를 한 번 보내고, 끊은 옛 연결의 늦은 신호는 버린다", async () => {
  const net = scripted(["stream", "stream", "stream"]);
  const live = createLive({ base: "/api", fetch: net.f, sleep: async () => {} });
  const got: SseEvent[] = [];
  const off = live.subscribe((e) => got.push(e));
  let changes = 0;
  live.watch(() => { changes++; });
  live.start();
  await until(() => live.state() === "open");
  assert.deepEqual(got, []);                   // 처음 붙을 때는 다시 읽기를 보내지 않는다 (방금 읽었다)
  net.streams[0]!.end();
  await until(() => net.streams.length === 2 && live.state() === "open");
  assert.deepEqual(got, [{ type: "reload_all" }]);
  const old = net.streams[1]!;
  live.stop();
  assert.equal(live.state(), "off");
  try { old.push(status(M, "failed")); } catch { /* 끊긴 스트림 */ }
  live.start();
  await until(() => net.streams.length === 3 && live.state() === "open");
  net.streams[2]!.push(status(M, "completed"));
  await until(() => got.length === 2);
  assert.deepEqual(got.at(-1), { type: "migration.status_changed", migrationId: M, status: "completed" });
  assert.ok(changes >= 4);
  off();
  live.stop();
});

test("폴링 간격: 신호가 살아 있어도 워커 단계(floor=false)는 원래 간격, 사람 차례만 하한까지 늘린다", () => {
  const open = { listening: true, liveOpen: true };
  assert.equal(pollInterval(700, { ...open, floor: false }), 700);                 // 워커 단계: 트래픽·진행 숫자가 신호 없이 바뀜
  assert.equal(pollInterval(1500, { ...open, floor: true }), LIVE_FALLBACK_MS);     // 사람 차례: 신호에 맡김
  assert.equal(pollInterval(30_000, { ...open, floor: true }), 30_000);            // 원래 더 느리면 그대로
  assert.equal(pollInterval(700, { listening: true, liveOpen: false, floor: true }), 700);   // 연결이 없으면 원래 간격
  assert.equal(pollInterval(700, { listening: false, liveOpen: true, floor: true }), 700);   // 신호를 안 들으면 원래 간격
  assert.equal(pollInterval(null, { ...open, floor: true }), null);
});
