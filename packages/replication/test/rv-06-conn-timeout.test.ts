// RV-06: 고객 DB 연결이 조용히 끊기는 경우(중계기·터널이 패킷을 버림) 복제 클라이언트가 끝없이 기다리지 않는다
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { clientConfig, connect, endpointFromEnv } from "../src/index.js";

test("RV-06 복제 클라이언트 설정에 TCP keepalive·접속 시간 상한이 있다 (env 로 바꿈, 빈 값·이상한 값은 기본)", () => {
  const e = endpointFromEnv("REPL_SOURCE", { REPL_SOURCE_URL: "postgres://a:b@127.0.0.1:5432/x" });
  const c = clientConfig(e, {});
  assert.equal(c.keepAlive, true);
  assert.equal(c.keepAliveInitialDelayMillis, 10_000);
  assert.equal(c.connectionTimeoutMillis, 20_000);
  assert.equal(clientConfig(e, { REPL_CONNECT_TIMEOUT_MS: "5000" }).connectionTimeoutMillis, 5000);
  assert.equal(clientConfig(e, { REPL_CONNECT_TIMEOUT_MS: "" }).connectionTimeoutMillis, 20_000);
  assert.equal(clientConfig(e, { REPL_CONNECT_TIMEOUT_MS: "abc" }).connectionTimeoutMillis, 20_000);
});

test("RV-06 받기만 하고 답이 없는 서버(블랙홀)면 접속이 시간 상한 안에 실패한다", async () => {
  const socks: import("node:net").Socket[] = [];
  const srv = createServer((s) => { socks.push(s); });   // 연결은 받지만 한 바이트도 안 보냄
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as { port: number }).port;
  const prev = process.env.REPL_CONNECT_TIMEOUT_MS;
  process.env.REPL_CONNECT_TIMEOUT_MS = "300";
  try {
    const e = endpointFromEnv("REPL_SOURCE", { REPL_SOURCE_URL: `postgres://a:b@127.0.0.1:${port}/x` });
    const t0 = Date.now();
    await assert.rejects(connect(e), /timeout/i);
    assert.ok(Date.now() - t0 < 5000, `너무 오래 기다림 ${Date.now() - t0}ms`);
  } finally {
    if (prev === undefined) delete process.env.REPL_CONNECT_TIMEOUT_MS; else process.env.REPL_CONNECT_TIMEOUT_MS = prev;
    socks.forEach((s) => s.destroy());
    srv.close();
  }
});
