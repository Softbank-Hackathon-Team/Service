// Z92: 온프레 Agent 보고 왕복 (DB 없이). 진짜 HTTP 포트를 열고 Agent 보내기(sendAgentReport)로 보낸다.
// 저장소만 메모리로 바꾼다. DB(RLS·재전송 색인·heartbeat 연결 상태)는 agent-reports.db.test.ts
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import Fastify, { type FastifyInstance } from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { sendAgentReport, deriveAgentSecret, memoryKeyRegistry, stubOnpremAgent } from "@svc/agent";
import type { AgentReport } from "@svc/contracts";
import { errorsPlugin } from "../src/plugins/errors.js";
import { authPlugin } from "../src/plugins/auth.js";
import { agentReportRoutesWith, pgAgentKeyRegistry, type AgentReportStore } from "../src/routes/agent-reports.js";

const T = "11111111-1111-4111-8111-111111111111", E = "55555555-5555-4555-8555-555555555555";
const KEY = "ak_0123456789abcdef0123", MASTER = "z92-test-master-not-a-real-secret-000000";
const SECRET = deriveAgentSecret(MASTER, KEY);
const saved: Array<{ tenantId: string; envId: string; signature: string; report: AgentReport }> = [];
const store: AgentReportStore = {
  keys: memoryKeyRegistry({ [KEY]: { tenantId: T, envId: E, secret: SECRET },
    ak_revoked000000000000: { tenantId: T, envId: E, secret: "r", revoked: true } }),
  save: async (a) => {
    if (saved.some((s) => s.signature === a.signature)) return "replay";
    saved.push(a);
    return { id: "00000000-0000-4000-8000-" + String(saved.length).padStart(12, "0"), receivedAt: new Date().toISOString() };
  },
  list: async (tenantId, envId, o) => tenantId !== T || envId !== E ? null : {
    envId, lastHeartbeatAt: null, stale: true,
    items: saved.filter((s) => !o.kind || s.report.kind === o.kind).slice(0, o.limit).map((s, i) => ({
      id: "00000000-0000-4000-8000-" + String(i + 1).padStart(12, "0"), kind: s.report.kind, keyId: KEY,
      sentAt: s.report.sentAt, receivedAt: s.report.sentAt, migrationId: null, report: s.report })),
  },
};

async function build(st: AgentReportStore) {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(errorsPlugin);
  await app.register(authPlugin);
  await app.register(agentReportRoutesWith(st), { prefix: "/api/v1" });
  // 다른 경로의 JSON 본문 파싱은 그대로여야 한다 (Agent 경로만 문자열)
  await app.register(async (r) => { r.post("/echo", async (req) => ({ type: typeof req.body })); }, { prefix: "/api/v1" });
  return app;
}
let app: FastifyInstance, base: string;
before(async () => { app = await build(store); base = await app.listen({ port: 0, host: "127.0.0.1" }); });
after(async () => { await app.close(); });

const hb = (): AgentReport => ({ kind: "heartbeat", agentVersion: "t", sentAt: new Date().toISOString(), k3sVersion: "v1.33.5+k3s1",
  cnpg: { cluster: "app-db", ready: true, replicationLagBytes: null } });

test("왕복: Agent 가 서명해 보낸 heartbeat → 201, 회사·환경은 키에서", async () => {
  const r = await sendAgentReport(hb(), { baseUrl: base, keyId: KEY, secret: SECRET });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal((r.body as { envId: string }).envId, E);
  assert.equal(saved.at(-1)!.tenantId, T);
});

test("재전송: 같은 요청(같은 시각·본문·서명)을 다시 보내면 409 AGENT_REPLAY", async () => {
  const fixed = new Date();
  const rep = hb();
  const a = await sendAgentReport(rep, { baseUrl: base, keyId: KEY, secret: SECRET, now: () => fixed });
  const b = await sendAgentReport(rep, { baseUrl: base, keyId: KEY, secret: SECRET, now: () => fixed });
  assert.equal(a.status, 201);
  assert.equal(b.status, 409);
  assert.equal((b.body as { code: string }).code, "AGENT_REPLAY");
});

test("재전송 우회 막힘 (Z38b): 같은 서명을 대문자·뒤에 글자 붙여 다시 보내면 401", async () => {
  const fixed = new Date();
  const body = JSON.stringify(hb());
  const ts = String(Math.floor(fixed.getTime() / 1000));
  const { signReport } = await import("@svc/contracts/agent-sig");
  const sig = signReport(SECRET, Number(ts), body);
  const post = (signature: string) => fetch(base + "/api/v1/agent/reports", { method: "POST", headers: {
    "content-type": "application/json", "x-agent-key-id": KEY, "x-agent-timestamp": ts, "x-agent-signature": signature }, body });
  assert.equal((await post(sig)).status, 201);
  for (const v of [sig.toUpperCase(), sig + "zz", sig + "0"]) {
    const r = await post(v);
    assert.equal(r.status, 401, v);
    assert.equal(((await r.json()) as { code: string }).code, "AGENT_BAD_SIGNATURE");
  }
  assert.equal((await post(sig)).status, 409);
});

test("막힘: 틀린 비밀 401 AGENT_BAD_SIGNATURE, 폐기된 키 401, 헤더 없음 401", async () => {
  const bad = await sendAgentReport(hb(), { baseUrl: base, keyId: KEY, secret: "wrong" });
  assert.equal(bad.status, 401);
  assert.equal((bad.body as { code: string }).code, "AGENT_BAD_SIGNATURE");
  const rev = await sendAgentReport(hb(), { baseUrl: base, keyId: "ak_revoked000000000000", secret: "r" });
  assert.equal((rev.body as { code: string }).code, "AGENT_KEY_UNKNOWN");
  const none = await fetch(base + "/api/v1/agent/reports", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(none.status, 401);
  assert.equal(((await none.json()) as { code: string }).code, "AGENT_AUTH_MISSING");
});

test("막힘: 사람 헤더(x-dev-tenant)만으로는 보고를 못 넣는다", async () => {
  const r = await fetch(base + "/api/v1/agent/reports", { method: "POST",
    headers: { "content-type": "application/json", "x-dev-tenant": T }, body: JSON.stringify(hb()) });
  assert.equal(r.status, 401);
});

test("security·deploy 보고도 같은 경로로 (시험용 고정 보고)", async () => {
  const s = stubOnpremAgent({ keyId: KEY, secret: SECRET });
  for (const m of [s.security(new Date(), true), s.deployed(new Date(), "33333333-3333-4333-8333-333333333333", "h1")]) {
    const r = await fetch(base + "/api/v1/agent/reports", { method: "POST", headers: { "content-type": "application/json",
      "x-agent-key-id": m.headers.keyId, "x-agent-signature": m.headers.signature, "x-agent-timestamp": m.headers.timestamp }, body: m.body });
    assert.equal(r.status, 201, await r.text());
  }
});

test("보기: GET /environments/:id/agent-reports 는 사람 헤더로, 남의 회사·환경은 404", async () => {
  const ok = await fetch(base + `/api/v1/environments/${E}/agent-reports?kind=heartbeat&limit=5`, { headers: { "x-dev-tenant": T } });
  assert.equal(ok.status, 200);
  const j = await ok.json() as { items: Array<{ kind: string }> };
  assert.ok(j.items.length >= 1 && j.items.every((i) => i.kind === "heartbeat"));
  const other = await fetch(base + `/api/v1/environments/${E}/agent-reports`, { headers: { "x-dev-tenant": "22222222-2222-4222-8222-222222222222" } });
  assert.equal(other.status, 404);
  const noAuth = await fetch(base + `/api/v1/environments/${E}/agent-reports`);
  assert.equal(noAuth.status, 401);
});

test("다른 경로의 JSON 파싱은 그대로 (Agent 경로만 문자열)", async () => {
  const r = await fetch(base + "/api/v1/echo", { method: "POST", headers: { "content-type": "application/json", "x-dev-tenant": T }, body: "{}" });
  assert.deepEqual(await r.json(), { type: "object" });
});

test("마스터 키 없음 → 503 AGENT_REPORTS_DISABLED (DB 를 보기 전에 멈춤)", async () => {
  const off = await build({ ...store, keys: pgAgentKeyRegistry({}) });
  const r = await off.inject({ method: "POST", url: "/api/v1/agent/reports", headers: { "content-type": "application/json",
    "x-agent-key-id": KEY, "x-agent-signature": "00", "x-agent-timestamp": String(Math.floor(Date.now() / 1000)) }, payload: JSON.stringify(hb()) });
  assert.equal(r.statusCode, 503);
  assert.equal(r.json().code, "AGENT_REPORTS_DISABLED");
  await off.close();
});

test("W4·W5: Agent 자동 deploy 보고(이전 번호 없이 app + 커밋)와 facts 보고도 받는다, 목록에서 kind=facts 로 거른다", async () => {
  const sentAt = new Date().toISOString();
  const reps: AgentReport[] = [
    { kind: "deploy", agentVersion: "t", sentAt, app: "t-0a1b2c3d-shop-onprem-k3s", bundleHash: "a".repeat(40), status: "applied", resources: [] },
    { kind: "facts", agentVersion: "t", sentAt, grants: { level: "L0" }, dbs: [] },
  ];
  for (const r of reps) {
    const res = await sendAgentReport(r, { baseUrl: base, keyId: KEY, secret: SECRET });
    assert.equal(res.status, 201, JSON.stringify(res.body));
  }
  const l = await fetch(base + `/api/v1/environments/${E}/agent-reports?kind=facts`, { headers: { "x-dev-tenant": T } });
  assert.equal(l.status, 200);
  const j = await l.json() as { items: Array<{ kind: string }> };
  assert.ok(j.items.length >= 1 && j.items.every((i) => i.kind === "facts"));
});

test("#373 D2: progressing deploy 보고(진행 상태 + 기다리는 자원)를 받고 목록에 그대로 보인다, progress 모양이 틀리면 400", async () => {
  const sentAt = new Date().toISOString();
  const prog: AgentReport = { kind: "deploy", agentVersion: "t", sentAt, app: "t-0a1b2c3d-shop-onprem-k3s", bundleHash: "d".repeat(40),
    status: "progressing", resources: ["Cluster/app-shop/shop-db"], reason: "Synced/Progressing — Cluster/app-shop/shop-db Progressing: Setting up primary",
    progress: { sync: "Synced", health: "Progressing", waitingOn: { resource: "Cluster/app-shop/shop-db", health: "Progressing", message: "Setting up primary" } } };
  const res = await sendAgentReport(prog, { baseUrl: base, keyId: KEY, secret: SECRET });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const l = await fetch(base + `/api/v1/environments/${E}/agent-reports?kind=deploy`, { headers: { "x-dev-tenant": T } });
  assert.equal(l.status, 200);
  const j = await l.json() as { items: Array<{ report: AgentReport }> };
  const got = j.items.map((i) => i.report).find((r) => r.kind === "deploy" && r.status === "progressing");
  assert.equal(got?.kind === "deploy" ? got.progress?.waitingOn?.message : undefined, "Setting up primary");
  // 보내는 쪽 검사를 건너뛴 틀린 progress (모르는 칸) → 받는 쪽 계약이 막는다
  const { signReport } = await import("@svc/contracts/agent-sig");
  const body = JSON.stringify({ ...prog, progress: { sync: "Synced", health: "Progressing", eta: 30 } });
  const ts = Math.floor(Date.now() / 1000);
  const r = await fetch(base + "/api/v1/agent/reports", { method: "POST", headers: { "content-type": "application/json",
    "x-agent-key-id": KEY, "x-agent-timestamp": String(ts), "x-agent-signature": signReport(SECRET, ts, body) }, body });
  assert.equal(r.status, 400);
});

test("inventory(온프레 출발 가져오기 스냅숏): 1MB 넘는 본문도 계약 상한(4 MiB) 안이면 201, 넘으면 413 · Secret 목록은 400", async () => {
  const { AGENT_INVENTORY_MAX_BYTES } = await import("@svc/contracts");
  const inv = (items: Array<Record<string, unknown>>, resource = "configmaps") => ({ kind: "inventory", agentVersion: "t", sentAt: new Date().toISOString(),
    collectedAt: new Date().toISOString(), apiResources: { names: [] }, lists: [{ resource, items }] }) as AgentReport;
  const cm = (i: number, n: number) => ({ metadata: { name: `c${i}`, namespace: "app" }, data: { A: "x".repeat(n) } });
  const ok = await sendAgentReport(inv(Array.from({ length: 20 }, (_, i) => cm(i, 100 * 1024))), { baseUrl: base, keyId: KEY, secret: SECRET });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(saved.at(-1)!.report.kind, "inventory");
  // 상한 초과: 서버가 본문을 다 받기 전에 연결을 끊을 수 있어(진짜 HTTP 면 ECONNRESET) inject 로 상태 코드만 본다
  const { signReport } = await import("@svc/contracts/agent-sig");
  const bigBody = JSON.stringify(inv(Array.from({ length: Math.ceil(AGENT_INVENTORY_MAX_BYTES / (256 * 1024)) + 1 }, (_, i) => cm(i, 256 * 1024))));
  const bts = Math.floor(Date.now() / 1000);
  const big = await app.inject({ method: "POST", url: "/api/v1/agent/reports", headers: { "content-type": "application/json",
    "x-agent-key-id": KEY, "x-agent-timestamp": String(bts), "x-agent-signature": signReport(SECRET, bts, bigBody) }, payload: bigBody });
  assert.equal(big.statusCode, 413);
  // 보내는 쪽 검사를 건너뛴 Secret 목록 (서명은 맞음) → 받는 쪽 계약이 막는다
  const body = JSON.stringify(inv([], "secrets"));
  const ts = Math.floor(Date.now() / 1000);
  const r = await fetch(base + "/api/v1/agent/reports", { method: "POST", headers: { "content-type": "application/json",
    "x-agent-key-id": KEY, "x-agent-timestamp": String(ts), "x-agent-signature": signReport(SECRET, ts, body) }, body });
  assert.equal(r.status, 400);
});
