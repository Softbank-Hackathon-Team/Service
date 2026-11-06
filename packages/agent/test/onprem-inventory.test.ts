// 온프레 출발 가져오기 재료: Agent 인벤토리 스냅숏 모으기 (kubectl 은 가짜 exec)
import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentReport, AGENT_INVENTORY_MAX_BYTES } from "@svc/contracts";
import type { Exec } from "@svc/adapters";
import { collectInventory, InventoryTooLarge } from "../src/index.js";

const now = () => new Date("2026-11-07T00:00:00Z");
function fake(items: (resource: string) => unknown[]) {
  const calls: string[][] = [];
  const exec: Exec = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (args[0] === "api-resources") return { code: 0, stdout: "pods\nconfigmaps\nsecrets\n", stderr: "", ms: 1 };
    if (args[1] === "nodes") return { code: 1, stdout: "", stderr: "Error from server (Forbidden): nodes is forbidden", ms: 1 };
    return { code: 0, stdout: JSON.stringify({ items: items(args[1]!) }), stderr: "", ms: 1 };
  };
  return { exec, calls };
}

test("inventory: 읽기 전용 명령만, context 를 앞에 붙이고, 보고 계약(AgentReport)을 통과한다. 못 읽은 노드는 오류 칸", async () => {
  const k = fake((r) => (r === "configmaps" ? [{ metadata: { name: "c", namespace: "app" }, data: { A: "1" } }] : []));
  const r = await collectInventory({ agentVersion: "onprem-agent/t", exec: k.exec, context: "k3d-onprem", now });
  assert.ok(AgentReport.safeParse(r).success);
  assert.equal(r.kind, "inventory");
  assert.ok(k.calls.every((c) => c[0] === "kubectl" && (c[1] === "get" || c[1] === "api-resources") && c.includes("--context") && c[c.indexOf("--context") + 1] === "k3d-onprem"));
  assert.ok(!k.calls.some((c) => c[1] === "get" && /^secrets?$/.test(c[2] ?? "")), "Secret 은 안 읽는다");
  const nodes = r.lists.find((l) => l.resource === "nodes")!;
  assert.ok("error" in nodes && nodes.error.exitCode === 1);
});

test("inventory 거부: 상한(AGENT_INVENTORY_MAX_BYTES)을 넘으면 보내지 않고 InventoryTooLarge", async () => {
  const big = "x".repeat(64 * 1024);
  const n = Math.ceil(AGENT_INVENTORY_MAX_BYTES / big.length) + 1;
  const k = fake((r) => (r === "configmaps" ? Array.from({ length: n }, (_, i) => ({ metadata: { name: `c${i}`, namespace: "app" }, data: { A: big } })) : []));
  await assert.rejects(collectInventory({ agentVersion: "t", exec: k.exec, now }), InventoryTooLarge);
});
