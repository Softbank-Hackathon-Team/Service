// 온프레 출발 가져오기 (pull 모드): 마지막 Agent 인벤토리 스냅숏 → discover CliDeps. 없음·오래됨·모양 틀림은 이유를 들고 멈춘다 (DB 없이)
//   DB 왕복(agent_reports 최신 줄 → importing → spec_review)은 import-onprem-snapshot.db.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { isAdapterError } from "@svc/adapters";
import type { AgentInventorySnapshot } from "@svc/contracts";
import { inventoryMaxAgeSec, onpremPullSource, snapshotDeps } from "../src/jobs/_onprem-snapshot.js";

const snap: AgentInventorySnapshot = {
  kind: "inventory", agentVersion: "onprem-agent/t", sentAt: "2026-11-07T00:00:00Z", collectedAt: "2026-11-07T00:00:00Z",
  apiResources: { names: ["pods"] },
  lists: [{ resource: "nodes", items: [{ metadata: { name: "n1" } }] }],
};
const o = { cwd: ".", env: {}, timeoutMs: 1 };
const rejectsWith = (f: () => unknown, re: RegExp) =>
  assert.throws(f, (e: unknown) => isAdapterError(e) && e.code === "SOURCE_UNAVAILABLE" && re.test((e as Error).message));

test("pull 모드 판단: 온프레 + ONPREM_FLOOR_VIA_GIT≠0 + MOCK_SEED 아님일 때만 스냅숏", () => {
  assert.equal(onpremPullSource("onprem", {}), true);
  assert.equal(onpremPullSource("onprem", { ONPREM_FLOOR_VIA_GIT: "1" }), true);
  assert.equal(onpremPullSource("onprem", { ONPREM_FLOOR_VIA_GIT: "0" }), false, "push 시연(로컬)은 예전처럼 kubectl --context");
  assert.equal(onpremPullSource("onprem", { MOCK_SEED: "1" }), false, "시험·e2e 는 데모 원본");
  assert.equal(onpremPullSource("aws", {}), false);
});

test("신선한 스냅숏 → kubectl 대신 스냅숏이 답하는 exec", async () => {
  const d = snapshotDeps({ age: 30, body: snap }, 600);
  const r = await d.exec!("kubectl", ["get", "nodes", "--context", "k3d-onprem", "--request-timeout=10s", "-o", "json"], o);
  assert.equal(r.code, 0);
  assert.equal((JSON.parse(r.stdout) as { items: unknown[] }).items.length, 1);
});

test("거부: 스냅숏 없음 · 상한보다 오래됨 · 모양이 계약과 다름 (Secret 목록 포함) → SOURCE_UNAVAILABLE + 운영자가 할 일", () => {
  rejectsWith(() => snapshotDeps(undefined, 600), /스냅숏이 아직 없음.*다음 보고/);
  rejectsWith(() => snapshotDeps({ age: 601, body: snap }, 600), /601초 전.*상한 600초.*재시작/);
  rejectsWith(() => snapshotDeps({ age: 1, body: { ...snap, lists: [{ resource: "secrets", items: [] }] } }, 600), /모양이 계약과 안 맞음/);
  rejectsWith(() => snapshotDeps({ age: 1, body: { kind: "facts" } }, 600), /모양이 계약과 안 맞음/);
});

test("신선도 상한: 기본 600초, IMPORT_INVENTORY_MAX_AGE_SEC 로 바꿈, 이상한 값이면 기본", () => {
  assert.equal(inventoryMaxAgeSec({}), 600);
  assert.equal(inventoryMaxAgeSec({ IMPORT_INVENTORY_MAX_AGE_SEC: "120" }), 120);
  assert.equal(inventoryMaxAgeSec({ IMPORT_INVENTORY_MAX_AGE_SEC: "abc" }), 600);
});
