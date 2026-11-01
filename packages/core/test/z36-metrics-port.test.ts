// Z36 (Z12-2): 지표 포트가 차 있으면 다음 포트, 다 차 있으면 null (프로세스는 산다). 예전엔 EADDRINUSE가 처리 안 된 오류로 프로세스를 죽였다
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { Registry, startMetricsServer, startMetricsServerNear } from "../src/obs/index.js";

const listen = (port: number) => new Promise<Server>((ok, fail) => { const s = createServer(); s.once("error", fail); s.listen(port, "0.0.0.0", () => ok(s)); });
const close = (s: Server) => new Promise((r) => s.close(r));
const BASE = 19_000 + Math.floor(Math.random() * 500) * 2;

test("startMetricsServer: 포트가 차 있으면 Promise가 EADDRINUSE로 실패한다 (예전: 처리 안 된 error 이벤트로 프로세스 종료)", async () => {
  const busy = await listen(BASE);
  await assert.rejects(startMetricsServer(new Registry(), BASE), { code: "EADDRINUSE" });
  await close(busy);
});

test("startMetricsServerNear: 차 있으면 다음 포트, 그 포트로 /metrics 응답", async () => {
  const busy = await listen(BASE + 100);
  const seen: number[] = [];
  const m = await startMetricsServerNear(new Registry(), BASE + 100, { onBusy: (p) => seen.push(p) });
  assert.ok(m); assert.equal(m.port, BASE + 101); assert.deepEqual(seen, [BASE + 100]);
  const r = await fetch(`http://127.0.0.1:${m.port}/metrics`);
  assert.equal(r.status, 200);
  await close(m.server); await close(busy);
});

test("startMetricsServerNear: 시도한 포트가 모두 차 있으면 null", async () => {
  const a = await listen(BASE + 200), b = await listen(BASE + 201);
  assert.equal(await startMetricsServerNear(new Registry(), BASE + 200, { tries: 2 }), null);
  await close(a); await close(b);
});
