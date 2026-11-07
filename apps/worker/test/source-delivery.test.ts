// 온프레 출발 → AWS (ADR-031 R4): deploy 가 출발 온프레 묶음에 복제 배달물을 넣는 길 (jobs/deploy.ts sourceReplicationStep).
//   DB 를 안 쓰는 길만 (묶음 없음·CNPG 수·끝점 줄 없음). 배달물 자체는 replication-delivery.test.ts 가 본다
import { test } from "node:test";
import assert from "node:assert/strict";
import type { HelmValues } from "@svc/contracts";
import { relayPermSide } from "@svc/adapters";
import { sourceReplicationStep, withSourceReplication } from "../src/jobs/deploy.js";

const T = "11111111-1111-4111-8111-111111111111", M = "33333333-3333-4333-8333-333333333333";
const job = { tenantId: T, migrationId: M } as Parameters<typeof sourceReplicationStep>[0];
const mig = { id: M, status: "deploying" as const, sourceEnvId: "s", targetEnvId: "t" };
const input = { tenantId: T, spec: { app: { name: "shop" } }, target: { envId: "t", provider: "aws", region: "default", accountId: null } } as unknown as Parameters<typeof sourceReplicationStep>[2];
const cnpg = (o: Record<string, unknown> = {}) => ({ mode: "cnpg", name: "shop-db", owner: "app_user", ...o });
const vals = (pgs: unknown[]): HelmValues => ({ namespace: "app-shop", postgres: pgs } as HelmValues);

test("출발 값: CNPG 하나의 이전 역할을 켠다 (정리가 남긴 absent 도 present 로). CNPG 가 하나가 아니면 null", () => {
  const v = withSourceReplication(vals([cnpg({ replication: { enabled: true, ensure: "absent", role: "svc_migrate" } }), { mode: "rds", name: "x" }]))!;
  assert.deepEqual((v.postgres as Array<Record<string, unknown>>)[0]!.replication, { enabled: true, ensure: "present", role: "svc_migrate" });
  assert.deepEqual((v.postgres as Array<Record<string, unknown>>)[1], { mode: "rds", name: "x" });
  assert.deepEqual((withSourceReplication(vals([cnpg()]))!.postgres as Array<Record<string, unknown>>)[0]!.replication, { enabled: true, ensure: "present" });
  assert.equal(withSourceReplication(vals([])), null);
  assert.equal(withSourceReplication(vals([cnpg(), cnpg({ name: "b" })])), null);
});

function fakeRepo(values: HelmValues | null) {
  const commits: HelmValues[] = [];
  return { commits, repo: {
    chartVersion: async () => "0.1.0",
    resolve: async <B>(b: B) => b,
    readValues: async () => { if (!values) throw new Error("ENOENT"); return values; },
    readPlan: async () => ({}) as never,
    commitBundle: async (_k: string, _b: unknown, v: HelmValues) => { commits.push(v); return { commit: "c1", bundleSha256: "x", resources: [], changed: true }; },
  } };
}

test("거부: 출발 묶음이 gitops 에 없으면(고객이 직접 올린 앱) 커밋 없이 paused REPL_DELIVERY_FAILED, CNPG 가 둘이어도 같다", async () => {
  const none = fakeRepo(null);
  const r = await sourceReplicationStep(job, mig, input, { records: [], stored: null, sealingCertPem: null }, none.repo, {});
  assert.ok("outcome" in r && r.outcome.to === "paused" && r.outcome.failureCode === "REPL_DELIVERY_FAILED");
  assert.match("outcome" in r ? JSON.stringify(r.outcome.detail) : "", /onprem-k3s/);
  const two = fakeRepo(vals([cnpg(), cnpg({ name: "b" })]));
  const r2 = await sourceReplicationStep(job, mig, input, { records: [], stored: null, sealingCertPem: null }, two.repo, {});
  assert.ok("outcome" in r2 && r2.outcome.failureCode === "REPL_DELIVERY_FAILED");
  assert.equal(none.commits.length + two.commits.length, 0);
});

test("끝점 줄이 없으면(로컬 데모) 출발 묶음을 건드리지 않고 경고만, pull 이 아니면 경고만", async () => {
  const f = fakeRepo(vals([cnpg()]));
  const r = await sourceReplicationStep(job, mig, input, { records: [], stored: null, sealingCertPem: null }, f.repo, {});
  assert.ok(!("outcome" in r) && r.warnings.length === 1);
  const push = await sourceReplicationStep(job, mig, input, { records: [], stored: null, sealingCertPem: null }, f.repo, { ONPREM_FLOOR_VIA_GIT: "0" });
  assert.ok(!("outcome" in push) && /ONPREM_FLOOR_VIA_GIT=0/.test(push.warnings[0]!));
  assert.equal(f.commits.length, 0);
});

test("사전 점검 중계기 권한: AWS → 온프레는 출발 계정, 온프레 → AWS 는 도착 계정 (Agent pull 일 때만), RELAY_AUTO=0 이면 없음", () => {
  const agent = { keys: 1, lastHeartbeatAgeSec: 5, staleSec: 120 } as never;
  const e = (side: "source" | "target", provider: string, a = false) => ({ side, provider, accountId: null, externalId: null, ...(a ? { agent } : {}) }) as never;
  assert.equal(relayPermSide({ source: e("source", "aws"), target: e("target", "onprem", true) }, {}), "source");
  assert.equal(relayPermSide({ source: e("source", "onprem", true), target: e("target", "aws") }, {}), "target");
  assert.equal(relayPermSide({ source: e("source", "onprem"), target: e("target", "aws") }, {}), null, "pull 아님(Agent 없음)");
  assert.equal(relayPermSide({ source: e("source", "onprem", true), target: e("target", "aws") }, { RELAY_AUTO: "0" }), null);
  assert.equal(relayPermSide({ source: e("source", "gcp"), target: e("target", "aws") }, {}), null);
});
