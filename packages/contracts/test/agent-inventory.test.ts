// 온프레 출발 가져오기 인벤토리 스냅숏 보고 (kind "inventory")
import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentReport, AgentReportKinds, AgentReportListKinds } from "../src/index.js";

const base = { kind: "inventory", agentVersion: "t", sentAt: "2026-11-07T00:00:00Z", collectedAt: "2026-11-07T00:00:00Z",
  apiResources: { names: ["pods", "widgets.example.com"] },
  lists: [{ resource: "deployments", items: [{ metadata: { name: "web", namespace: "app" } }] },
    { resource: "roles", error: { exitCode: 1, stderr: "Error from server (Forbidden)" } }] };

test("inventory: 목록 + 못 읽은 목록(오류 칸) + api-resources 오류도 받는다. 종류 목록에 있고, 받은 보고 목록 질의 종류에는 없다", () => {
  assert.ok(AgentReport.safeParse(base).success);
  assert.ok(AgentReport.safeParse({ ...base, apiResources: { error: { exitCode: 1, stderr: "x" } } }).success);
  // Secret 이름 자원은 "안 읽었음" 오류 칸으로만 (내용 없음)
  assert.ok(AgentReport.safeParse({ ...base, lists: [{ resource: "secrets.example.io", error: { exitCode: 1, stderr: "Agent 는 안 읽음" } }] }).success);
  assert.ok(AgentReportKinds.options.includes("inventory"));
  assert.ok(!AgentReportListKinds.options.includes("inventory" as never));
});

test("inventory 거부: Secret 자원 · items 와 error 동시 · 모르는 칸 · 오류 글 너무 김 · 자원 이름 모양", () => {
  const bad = (o: unknown) => !AgentReport.safeParse(o).success;
  assert.ok(bad({ ...base, lists: [{ resource: "secrets", items: [] }] }));
  assert.ok(bad({ ...base, lists: [{ resource: "secrets.example.io", items: [] }] }), "같은 이름의 CRD 도 내용은 안 받는다");
  assert.ok(bad({ ...base, lists: [{ resource: "pods", items: [], error: { exitCode: 1, stderr: "x" } }] }));
  assert.ok(bad({ ...base, tenantId: "x" }));
  assert.ok(bad({ ...base, lists: [{ resource: "pods", error: { exitCode: 1, stderr: "x".repeat(2001) } }] }));
  assert.ok(bad({ ...base, lists: [{ resource: "--all", items: [] }] }));
  assert.ok(bad({ ...base, collectedAt: undefined }));
});
