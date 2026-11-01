// Z92: 진짜 온프레 Agent (kubectl 모으기 + 서명 보내기). kubectl·fetch 만 바꿔 끼운다
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  acceptAgentReport, collectDeploy, collectHeartbeat, collectSecurity, deriveAgentSecret, memoryKeyRegistry,
  policyReportsToFindings, sendAgentReport, AGENT_HEADERS, type Kubectl,
} from "../src/index.js";

const now = () => new Date("2026-11-01T00:00:00Z");
const MASTER = "m".repeat(40);
const fakeKubectl = (map: Record<string, unknown>): Kubectl & { calls: string[][] } => {
  const calls: string[][] = [];
  const f = (async (args: string[]) => {
    calls.push(args);
    const k = Object.keys(map).find((p) => args.join(" ").startsWith(p));
    if (!k) throw new Error(`no such resource: ${args.join(" ")}`);
    return JSON.stringify(map[k]);
  }) as Kubectl & { calls: string[][] };
  f.calls = calls;
  return f;
};

test("heartbeat: k3s 버전 + CNPG 준비됨 판단 (readyInstances == instances, healthy)", async () => {
  const k = fakeKubectl({
    "version": { serverVersion: { gitVersion: "v1.33.5+k3s1" } },
    "get clusters.postgresql.cnpg.io app-db": { status: { instances: 1, readyInstances: 1, phase: "Cluster in healthy state" } },
  });
  const r = await collectHeartbeat({ kubectl: k, agentVersion: "t", now, namespace: "app", cnpgCluster: "app-db" });
  assert.equal(r.kind, "heartbeat");
  assert.deepEqual(r.kind === "heartbeat" && r.cnpg, { cluster: "app-db", ready: true, replicationLagBytes: null });
  assert.equal(r.kind === "heartbeat" && r.k3sVersion, "v1.33.5+k3s1");
  // 쓰는 명령이 없다 (version·get 만)
  assert.ok(k.calls.every((a) => a[0] === "version" || a[0] === "get"));
});

test("heartbeat: CNPG 클러스터가 없으면 ready=false 로 보고는 보낸다", async () => {
  const k = fakeKubectl({ "version": { serverVersion: { gitVersion: "v1.33.5+k3s1" } } });
  const r = await collectHeartbeat({ kubectl: k, agentVersion: "t", now, namespace: "app", cnpgCluster: "app-db" });
  assert.equal(r.kind === "heartbeat" && r.cnpg?.ready, false);
});

test("security: PolicyReport fail/pass → Finding, skip 은 뺀다, 우리 정책은 통제 번호", () => {
  const f = policyReportsToFindings(JSON.stringify({ items: [{ metadata: { namespace: "app" }, results: [
    { policy: "platform-namespace-pod-security", rule: "privileged", result: "fail", severity: "high", message: "privileged",
      resources: [{ kind: "Pod", name: "web", namespace: "app" }] },
    { policy: "x", rule: "y", result: "pass" },
    { policy: "x", rule: "z", result: "skip" },
  ] }] }), "2026-11-01T00:00:00.000Z");
  assert.equal(f.length, 2);
  assert.equal(f[0]!.status, "fail");
  assert.equal(f[0]!.controlId, "SEC-VIO-03");
  assert.equal(f[0]!.resource, "k3s/ns/app/pod/web");
  assert.equal(f[1]!.controlId, null);
});

test("security: Kyverno 없음(CRD 없음) → unknown 한 줄 (통과로 속이지 않음)", async () => {
  const r = await collectSecurity({ kubectl: fakeKubectl({}), agentVersion: "t", now });
  assert.equal(r.kind === "security" && r.findings[0]!.status, "unknown");
});

test("deploy: 다 준비 → applied, 하나라도 덜 됨 → failed + 이유", async () => {
  const ok = await collectDeploy({ kubectl: fakeKubectl({ "get deployments": { items: [
    { metadata: { name: "web" }, spec: { replicas: 2 }, status: { availableReplicas: 2 } }] } }),
    agentVersion: "t", now, namespace: "app", migrationId: "33333333-3333-4333-8333-333333333333", bundleHash: "h1" });
  assert.equal(ok.kind === "deploy" && ok.status, "applied");
  assert.deepEqual(ok.kind === "deploy" && ok.resources, ["Deployment/app/web"]);
  const bad = await collectDeploy({ kubectl: fakeKubectl({ "get deployments": { items: [
    { metadata: { name: "api" }, spec: { replicas: 1 }, status: {} }] } }),
    agentVersion: "t", now, namespace: "app", migrationId: "33333333-3333-4333-8333-333333333333", bundleHash: "h1" });
  assert.equal(bad.kind === "deploy" && bad.status, "failed");
  assert.match(bad.kind === "deploy" ? bad.reason ?? "" : "", /api/);
});

test("보내기: 보낸 글자 그대로에 서명 → 받는 쪽 검증 통과, 헤더 3개", async () => {
  const keyId = "ak_0123456789abcdef0123";
  const secret = deriveAgentSecret(MASTER, keyId);
  const keys = memoryKeyRegistry({ [keyId]: { tenantId: "11111111-1111-4111-8111-111111111111", envId: "55555555-5555-4555-8555-555555555555", secret } });
  let seen: { url: string; headers: Record<string, string>; body: string } | null = null;
  const fakeFetch = (async (url: string, init: RequestInit) => {
    seen = { url, headers: init.headers as Record<string, string>, body: String(init.body) };
    return new Response(JSON.stringify({ id: "x" }), { status: 201 });
  }) as unknown as typeof fetch;
  const report = await collectHeartbeat({ kubectl: fakeKubectl({ "version": { serverVersion: { gitVersion: "v1" } } }),
    agentVersion: "t", now, namespace: "app" });
  const res = await sendAgentReport(report, { baseUrl: "http://api.local/", keyId, secret, fetch: fakeFetch, now });
  assert.equal(res.status, 201);
  assert.equal(seen!.url, "http://api.local/api/v1/agent/reports");
  const h = seen!.headers;
  const got = await acceptAgentReport({ keyId: h[AGENT_HEADERS.keyId], signature: h[AGENT_HEADERS.signature], timestamp: h[AGENT_HEADERS.timestamp] },
    seen!.body, keys, now());
  assert.equal(got.envId, "55555555-5555-4555-8555-555555555555");
});

test("키 비밀: 마스터·키 번호로 늘 같은 값, 마스터가 짧으면 거부", () => {
  assert.equal(deriveAgentSecret(MASTER, "ak_a"), deriveAgentSecret(MASTER, "ak_a"));
  assert.notEqual(deriveAgentSecret(MASTER, "ak_a"), deriveAgentSecret(MASTER, "ak_b"));
  assert.throws(() => deriveAgentSecret("short", "ak_a"), /32/);
});

test("보내기 전 모양 확인: 본문에 tenantId 를 넣으면 보내지 않는다", async () => {
  let called = false;
  const f = (async () => { called = true; return new Response("{}"); }) as unknown as typeof fetch;
  await assert.rejects(sendAgentReport({ kind: "heartbeat", agentVersion: "t", sentAt: now().toISOString(), k3sVersion: "v1", cnpg: null,
    tenantId: "x" } as never, { baseUrl: "http://x", keyId: "ak_x", secret: "s", fetch: f }));
  assert.equal(called, false);
});
