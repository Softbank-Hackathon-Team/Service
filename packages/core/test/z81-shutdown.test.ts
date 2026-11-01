// Z81: 종료 신호 처리(onShutdown) 시험. 진짜 신호는 보내지 않는다 (on·exit 를 바꿔 끼움)
import { test } from "node:test";
import assert from "node:assert/strict";
import { onShutdown } from "../src/shutdown.js";

function harness(steps: Parameters<typeof onShutdown>[0], hardTimeoutMs = 2000) {
  const handlers = new Map<string, () => void>();
  const codes: number[] = [];
  const lines: string[] = [];
  let resolveExit!: (c: number) => void;
  const exited = new Promise<number>((r) => { resolveExit = r; });
  onShutdown(steps, {
    log: { info: (_o, m) => lines.push(m), error: (_o, m) => lines.push(m) },
    hardTimeoutMs,
    exit: (c) => { codes.push(c); resolveExit(c); },
    on: (s, fn) => handlers.set(s, fn),
  });
  return { handlers, codes, lines, exited };
}

test("첫 신호: 단계를 차례로 부르고 끝 코드 0", async () => {
  const order: string[] = [];
  const h = harness([["http", async () => { order.push("http"); }], ["boss", async () => { order.push("boss"); }]]);
  assert.deepEqual([...h.handlers.keys()].sort(), ["SIGINT", "SIGTERM"]);
  h.handlers.get("SIGTERM")!();
  assert.equal(await h.exited, 0);
  assert.deepEqual(order, ["http", "boss"]);
});

test("단계가 던져도 다음 단계는 부르고 끝 코드 1", async () => {
  const order: string[] = [];
  const h = harness([["http", async () => { throw new Error("x"); }], ["boss", async () => { order.push("boss"); }]]);
  h.handlers.get("SIGINT")!();
  assert.equal(await h.exited, 1);
  assert.deepEqual(order, ["boss"]);
  assert.ok(h.lines.includes("shutdown step failed"));
});

test("두 번째 신호는 기다리지 않고 바로 끝 코드 1", async () => {
  const h = harness([["boss", () => new Promise(() => {})]]);
  h.handlers.get("SIGTERM")!();
  h.handlers.get("SIGTERM")!();
  assert.deepEqual(h.codes, [1]);
});

test("단계가 기한 안에 안 끝나면 끝 코드 1", async () => {
  const h = harness([["boss", () => new Promise(() => {})]], 1000);
  const t0 = Date.now();
  h.handlers.get("SIGTERM")!();
  // 기한 타이머는 unref 라 시험 쪽에서 붙잡아 둔다
  const keep = setTimeout(() => {}, 3000);
  assert.equal(await h.exited, 1);
  clearTimeout(keep);
  assert.ok(Date.now() - t0 >= 900);
  assert.ok(h.lines.includes("shutdown timed out"));
});
