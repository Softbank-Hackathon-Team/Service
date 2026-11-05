// W5: 온프레 보안 사실 보고 (kind "facts"). kubectl 은 고정 JSON 으로 바꿔 끼운다
import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentReport } from "@svc/contracts";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectFacts, DEFAULT_EGRESS_IP_URL, DEFAULT_SEALING_CERT_URL, EGRESS_IP_TIMEOUT_MS, fetchEgressIp, fetchSealingCert, pgHbaFacts, pgMajorFromImage, type Kubectl } from "../src/index.js";

const now = () => new Date("2026-11-04T00:00:00Z");
const kube = (map: Record<string, unknown>): Kubectl => async (args) => {
  const k = Object.keys(map).find((p) => args.join(" ").startsWith(p));
  if (!k) throw new Error(`no such resource: ${args.join(" ")}`);
  const v = map[k];
  if (v instanceof Error) throw v;
  return typeof v === "string" ? v : JSON.stringify(v);
};
const cluster = (ns: string, name: string, extra: Record<string, unknown> = {}) =>
  ({ metadata: { namespace: ns, name }, spec: { imageName: "ghcr.io/cloudnative-pg/postgresql:16.4", ...extra }, status: { image: "ghcr.io/cloudnative-pg/postgresql:16.4" } });

test("pg_hba: CNPG 기본 규칙만이면 비TLS 도 받는다 (TLS 강제 아님), 사용자 줄 앞의 hostnossl reject 면 강제", () => {
  assert.deepEqual(pgHbaFacts(undefined), { tlsEnforced: false, authMethods: ["scram-sha-256"] });
  assert.deepEqual(pgHbaFacts(["hostnossl all all 0.0.0.0/0 reject"]), { tlsEnforced: true, authMethods: ["scram-sha-256"] });
  // 거부보다 앞에서 비TLS 를 받아 주는 줄이 있으면 강제가 아니다 (첫 일치 규칙이 이긴다)
  assert.deepEqual(pgHbaFacts(["host all all 10.0.0.0/8 trust", "hostnossl all all all reject"]), { tlsEnforced: false, authMethods: ["scram-sha-256", "trust"] });
  // 특정 DB 만 막는 줄은 강제로 치지 않는다
  assert.equal(pgHbaFacts(["hostnossl app app all reject"]).tlsEnforced, false);
});

test("이미지 태그 → 주 버전, 못 읽으면 null", () => {
  assert.equal(pgMajorFromImage("ghcr.io/cloudnative-pg/postgresql:16.4"), 16);
  assert.equal(pgMajorFromImage("ghcr.io/cloudnative-pg/postgresql:18.6-system-trixie"), 18);
  assert.equal(pgMajorFromImage("registry.local:5000/pg/postgresql:15"), 15);
  assert.equal(pgMajorFromImage("ghcr.io/cloudnative-pg/postgresql@sha256:" + "a".repeat(64)), null);
  assert.equal(pgMajorFromImage(undefined), null);
});

test("facts: L1 + DB 하나는 NodePort 로 노출, 하나는 ClusterIP 만 → 계약 모양 그대로", async () => {
  const r = await collectFacts({ agentVersion: "t", now, kubectl: kube({
    "auth can-i list nodes": "yes\n",
    "get clusters.postgresql.cnpg.io -A": { items: [cluster("app-shop", "shop-db"), cluster("app-blog", "blog-db", { postgresql: { pg_hba: ["hostnossl all all all reject"] } })] },
    "get services -A": { items: [
      { metadata: { namespace: "app-shop" }, spec: { type: "NodePort", selector: { "cnpg.io/cluster": "shop-db", role: "primary" } } },
      { metadata: { namespace: "app-blog" }, spec: { type: "ClusterIP", selector: { "cnpg.io/cluster": "blog-db" } } },
      // 다른 네임스페이스의 같은 이름 NodePort 는 이 DB 가 아니다
      { metadata: { namespace: "other" }, spec: { type: "LoadBalancer", selector: { "cnpg.io/cluster": "blog-db" } } },
    ] },
  }) });
  AgentReport.parse(r);
  assert.equal(r.grants.level, "L1");
  assert.deepEqual(r.dbs.map((d) => [d.cluster, d.exposed, d.tlsEnforced, d.majorVersion]), [["shop-db", true, false, 16], ["blog-db", false, true, 16]]);
});

test("facts: 권한이 없으면 L0, Service 를 못 읽으면 노출 null (지어내지 않는다), CNPG 가 없으면 DB 0개", async () => {
  const r = await collectFacts({ agentVersion: "t", now, kubectl: kube({
    "auth can-i list nodes": new Error("no"),
    "get clusters.postgresql.cnpg.io -A": { items: [cluster("app-shop", "shop-db")] },
    "get services -A": new Error("forbidden"),
  }) });
  assert.equal(r.grants.level, "L0");
  assert.equal(r.dbs[0]!.exposed, null);
  const none = await collectFacts({ agentVersion: "t", now, kubectl: kube({ "auth can-i list nodes": "no", "get services -A": { items: [] } }) });
  assert.deepEqual(none.dbs, []);
  assert.equal(none.grants.level, "L0");
});

test("facts 계약: 모르는 칸은 strict 가 막는다", () => {
  const ok = { kind: "facts", agentVersion: "t", sentAt: "2026-11-04T00:00:00Z", grants: { level: "L0" }, dbs: [] };
  assert.ok(AgentReport.safeParse(ok).success);
  assert.ok(!AgentReport.safeParse({ ...ok, tenantId: "x" }).success);
  assert.ok(!AgentReport.safeParse({ ...ok, grants: { level: "L2" } }).success);
});

// sealed-secrets 공개 봉인 인증서 (facts.sealing). 시험 인증서는 openssl 로 만든다 (Node 에 X.509 만드는 API 가 없다)
const hasOpenssl = (() => { try { execFileSync("openssl", ["version"], { stdio: "ignore" }); return true; } catch { return false; } })();
const noOpenssl = hasOpenssl ? false : "openssl CLI 가 이 기계에 없다";
function testCert(keyArgs: string[]): string {
  const d = mkdtempSync(join(tmpdir(), "svc-agent-cert-"));
  try {
    execFileSync("openssl", ["req", "-x509", "-nodes", ...keyArgs, "-keyout", join(d, "k.pem"), "-out", join(d, "c.pem"), "-days", "2", "-subj", "/CN=t"], { stdio: "ignore" });
    return readFileSync(join(d, "c.pem"), "utf8");
  } finally { rmSync(d, { recursive: true, force: true }); }
}
const noKube = kube({ "auth can-i list nodes": "no", "get services -A": { items: [] } });

test("facts: 봉인 인증서(RSA)를 받으면 sealing 칸에 싣는다 (계약 통과)", { skip: noOpenssl }, async () => {
  const pem = testCert(["-newkey", "rsa:2048"]);
  const seen: string[] = [];
  const fake = (async (url: string) => { seen.push(url); return new Response(pem, { status: 200 }); }) as unknown as typeof fetch;
  const r = await collectFacts({ agentVersion: "t", now, kubectl: noKube, sealingCert: () => fetchSealingCert(DEFAULT_SEALING_CERT_URL, { fetch: fake }) });
  AgentReport.parse(r);
  assert.equal(r.sealing?.certPem, `${pem.trim()}\n`);
  assert.equal(r.sealing?.fetchedAt, "2026-11-04T00:00:00.000Z");
  assert.deepEqual(seen, ["http://sealed-secrets-controller.kube-system.svc:8080/v1/cert.pem"]);
});

test("facts 거부: 인증서를 못 받거나(404·연결 실패) RSA 가 아니면 sealing 칸이 없고 보고는 그대로 간다", { skip: noOpenssl }, async () => {
  const notFound = (async () => new Response("nope", { status: 404 })) as unknown as typeof fetch;
  const a = await collectFacts({ agentVersion: "t", now, kubectl: noKube, sealingCert: () => fetchSealingCert("http://x/v1/cert.pem", { fetch: notFound }) });
  assert.equal("sealing" in a, false);
  AgentReport.parse(a);
  const b = await collectFacts({ agentVersion: "t", now, kubectl: noKube, sealingCert: async () => { throw new Error("ECONNREFUSED"); } });
  assert.equal("sealing" in b, false);
  const ec = testCert(["-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1"]);
  const c = await collectFacts({ agentVersion: "t", now, kubectl: noKube, sealingCert: async () => ec });
  assert.equal("sealing" in c, false);
  // 계약: 인증서 PEM 이 아니면 받지 않는다 (예전 Agent 처럼 칸이 없는 보고는 받는다)
  const ok = { kind: "facts", agentVersion: "t", sentAt: "2026-11-04T00:00:00Z", grants: { level: "L0" }, dbs: [] };
  assert.ok(!AgentReport.safeParse({ ...ok, sealing: { certPem: "-----BEGIN PRIVATE KEY-----\n", fetchedAt: "2026-11-04T00:00:00Z" } }).success);
});

// 출발 계정 중계기 SSH(22)를 이 IP/32 에만 연다 (worker relay/). 못 받으면 칸이 없고 워커가 ONPREM_EGRESS_UNKNOWN 으로 멈춘다
test("facts: 나가는 공인 IP 를 받으면 egressIp 칸에 싣는다 (기본 주소·5초 시간 제한·계약 통과)", async () => {
  const seen: { url: string; signal: unknown }[] = [];
  const fake = (async (url: string, init?: RequestInit) => { seen.push({ url, signal: init?.signal }); return new Response("203.0.113.9\n", { status: 200 }); }) as unknown as typeof fetch;
  const r = await collectFacts({ agentVersion: "t", now, kubectl: noKube, egressIp: () => fetchEgressIp(DEFAULT_EGRESS_IP_URL, { fetch: fake }) });
  AgentReport.parse(r);
  assert.equal(r.egressIp, "203.0.113.9");
  assert.equal(seen[0]!.url, "https://checkip.amazonaws.com");
  assert.ok(seen[0]!.signal instanceof AbortSignal, "시간 제한 신호");
  assert.equal(EGRESS_IP_TIMEOUT_MS, 5000);
});

test("facts 거부: 나가는 IP 를 못 받거나(500·시간 초과) IPv4 한 줄이 아니면 egressIp 칸이 없고 보고는 그대로 간다", async () => {
  const bad = (status: number, body: string) => (async () => new Response(body, { status })) as unknown as typeof fetch;
  for (const f of [bad(500, "203.0.113.9"), bad(200, "<html>proxy</html>"), bad(200, "0.0.0.0/0"), bad(200, "2001:db8::1")]) {
    const r = await collectFacts({ agentVersion: "t", now, kubectl: noKube, egressIp: () => fetchEgressIp("https://x", { fetch: f }) });
    assert.equal("egressIp" in r, false);
    AgentReport.parse(r);
  }
  const t = await collectFacts({ agentVersion: "t", now, kubectl: noKube, egressIp: async () => { throw new DOMException("timeout", "TimeoutError"); } });
  assert.equal("egressIp" in t, false);
  const ok = { kind: "facts", agentVersion: "t", sentAt: "2026-11-04T00:00:00Z", grants: { level: "L0" }, dbs: [] };
  assert.ok(!AgentReport.safeParse({ ...ok, egressIp: "203.0.113.0/24" }).success, "계약: IPv4 주소 하나만");
});
