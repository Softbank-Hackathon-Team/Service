// #373 D2: deploy 보고의 progressing (진행 중) + progress 칸. 더하기만 한 칸이라 예전 Agent 보고(applied·failed)도 그대로 받는다
import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentReport } from "../src/index.js";

const base = { kind: "deploy", agentVersion: "t", sentAt: "2026-11-07T03:00:00Z", app: "t-0a1b2c3d-shop-onprem-k3s", bundleHash: "c".repeat(40), resources: [] };
const progress = { sync: "Synced", health: "Progressing",
  waitingOn: { resource: "Cluster/app-shop/shop-db", health: "Progressing", sync: "Synced", message: "Setting up primary" } };

test("progressing + progress 를 받는다, 예전 Agent 보고(applied·failed, progress 없음)도 그대로", () => {
  assert.ok(AgentReport.safeParse({ ...base, status: "progressing", reason: "Synced/Progressing", progress }).success);
  assert.ok(AgentReport.safeParse({ ...base, status: "progressing", progress: { sync: "OutOfSync", health: "Healthy" } }).success);
  assert.ok(AgentReport.safeParse({ ...base, status: "applied" }).success);
  assert.ok(AgentReport.safeParse({ ...base, status: "failed", reason: "Deployment api: 0/1 ready" }).success);
});

test("거부: 모르는 상태 · progress 의 모르는 칸 · 너무 긴 메시지 · 상태 이름 없음", () => {
  const bad = (x: Record<string, unknown>) => !AgentReport.safeParse({ ...base, status: "progressing", ...x }).success;
  assert.ok(!AgentReport.safeParse({ ...base, status: "pending" }).success);
  assert.ok(bad({ progress: { ...progress, tenantId: "x" } }));
  assert.ok(bad({ progress: { ...progress, waitingOn: { ...progress.waitingOn, extra: 1 } } }));
  assert.ok(bad({ progress: { ...progress, message: "m".repeat(501) } }));
  assert.ok(bad({ progress: { health: "Progressing" } }));
});
