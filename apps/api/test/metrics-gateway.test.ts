// OTel 게이트웨이 입구: 토큰 확인, 회사·환경 헤더 덮어쓰기, 거부 경로 (DB·Collector 없이)
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { ENV_HEADER, TENANT_HEADER, createMetricsGateway, type GatewayOpts } from "../src/metrics-gateway.js";
import { hashMetricToken, newMetricToken } from "../src/auth/metric-token.js";

const TOKEN = newMetricToken();
const OWNER = { tenantId: "11111111-1111-4111-8111-111111111111", envId: "22222222-2222-4222-8222-222222222222" };

async function withGateway(o: Partial<GatewayOpts>, fn: (url: string) => Promise<void>) {
  const server = createMetricsGateway({
    collectorUrl: "http://collector.test/v1/metrics",
    lookup: async (hash) => (hash === hashMetricToken(TOKEN) ? OWNER : undefined),
    ...o,
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  try { await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`); }
  finally { await new Promise((done) => server.close(done)); }
}

test("맞는 토큰: 찾은 회사·환경을 헤더로 넘기고, 보낸 쪽이 흉내 낸 헤더와 토큰은 안 넘긴다", async () => {
  let seen: { url: string; headers: Record<string, string>; body: string } | undefined;
  const collector = (async (url: string, init: RequestInit) => {
    seen = { url, headers: init.headers as Record<string, string>, body: Buffer.from(init.body as Uint8Array).toString() };
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  await withGateway({ fetch: collector }, async (url) => {
    const r = await fetch(`${url}/v1/metrics`, { method: "POST", body: "payload", headers: {
      authorization: `Bearer ${TOKEN}`, "content-type": "application/json",
      [TENANT_HEADER]: "99999999-9999-4999-8999-999999999999", [ENV_HEADER]: "spoofed" } });
    assert.equal(r.status, 200);
  });
  assert.equal(seen?.url, "http://collector.test/v1/metrics");
  assert.equal(seen?.body, "payload");
  assert.deepEqual(seen?.headers, { [TENANT_HEADER]: OWNER.tenantId, [ENV_HEADER]: OWNER.envId, "content-type": "application/json" });
});

test("토큰이 없거나 모양이 틀리거나 모르는 토큰이면 401, Collector 를 안 부른다", async () => {
  const collector = (async () => { throw new Error("불리면 안 된다"); }) as unknown as typeof fetch;
  await withGateway({ fetch: collector }, async (url) => {
    for (const headers of [{}, { authorization: "Bearer nope" }, { authorization: `Bearer ${newMetricToken()}` }, { authorization: `Basic ${TOKEN}` }]) {
      const r = await fetch(`${url}/v1/metrics`, { method: "POST", body: "x", headers: headers as Record<string, string> });
      assert.equal(r.status, 401);
    }
  });
});

test("경로·방법·크기 거부, 건강 확인은 토큰 없이", async () => {
  await withGateway({ maxBodyBytes: 4 }, async (url) => {
    assert.equal((await fetch(`${url}/healthz`)).status, 200);
    assert.equal((await fetch(`${url}/v1/traces`, { method: "POST", body: "x" })).status, 404);
    assert.equal((await fetch(`${url}/v1/metrics`)).status, 405);
    const big = await fetch(`${url}/v1/metrics`, { method: "POST", body: "12345", headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal(big.status, 413);
  });
});

test("DB 나 Collector 가 죽으면 503 (수집기가 다시 보낸다)", async () => {
  const errors: unknown[] = [];
  const onError = (e: unknown) => errors.push(e);
  const headers = { authorization: `Bearer ${TOKEN}` };
  await withGateway({ onError, lookup: async () => { throw new Error("db down"); } }, async (url) => {
    assert.equal((await fetch(`${url}/v1/metrics`, { method: "POST", body: "x", headers })).status, 503);
  });
  await withGateway({ onError, fetch: (async () => { throw new Error("collector down"); }) as unknown as typeof fetch }, async (url) => {
    assert.equal((await fetch(`${url}/v1/metrics`, { method: "POST", body: "x", headers })).status, 503);
  });
  assert.equal(errors.length, 2);
});
