// W5: 온프레 보안 사실 보고 (kind "facts"). kubectl 은 고정 JSON 으로 바꿔 끼운다
import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentReport } from "@svc/contracts";
import { collectFacts, pgHbaFacts, pgMajorFromImage, type Kubectl } from "../src/index.js";

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
