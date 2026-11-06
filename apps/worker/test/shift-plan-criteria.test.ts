// 승인 계획의 롤백 기준 창(rollbackCriteria.windowSec)이 Prometheus 질의 창이 된다. 예전엔 늘 30초 고정이었다
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { trafficMetrics } from "../src/platform.js";

test("PROM_URL 지표는 계획 windowSec 창으로 묻는다 (없으면 30초)", async () => {
  const queries: string[] = [];
  const srv = createServer((req, res) => {
    queries.push(new URL(req.url!, "http://prom").searchParams.get("query") ?? "");
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ status: "success", data: { resultType: "vector", result: [{ metric: {}, value: [0, "1"] }] } }));
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  try {
    const env = { PROM_URL: `http://127.0.0.1:${(srv.address() as AddressInfo).port}` };
    await trafficMetrics(randomUUID(), { windowSec: 10 }, env)!.window(randomUUID(), 10);
    assert.ok(queries.length > 0 && queries.every((q) => q.includes("[10s]")), queries.join("\n"));
    queries.length = 0;
    await trafficMetrics(randomUUID(), {}, env)!.window(randomUUID(), 10);
    assert.ok(queries.length > 0 && queries.every((q) => q.includes("[30s]")), queries.join("\n"));
  } finally { srv.close(); }
});
