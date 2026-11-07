// #373 D3: 온프레 Agent 보고도 후손 리비전(묶음 폴더 그대로)을 받는다. DB 없이 보고 찾기·후보·판정기를 바꿔 끼운다
import { test } from "node:test";
import assert from "node:assert/strict";
import { syncWatcherFor, withDescendantReports, type AgentDeployCandidates, type AgentDeployLookup } from "../src/gitops/agent-watch.js";
import type { RevisionCovers } from "../src/gitops/revision-check.js";

const b = { tenant: "t-0a1b2c3d", app: "shop", env: "onprem-k3s" as const };
const C = { commit: "c".repeat(40), bundleSha256: "x", resources: [], changed: true };
const D = "d".repeat(40), E = "e".repeat(40);
const clock = () => { let t = 0; return { now: () => t, sleep: async (ms: number) => { t += ms; } }; };
const ENV = { AGENT_DEPLOY_WAIT_SEC: "30", AGENT_DEPLOY_TICK_MS: "5000" };
const never: AgentDeployLookup = async () => null;

test("withDescendantReports: 같은 커밋 보고가 있으면 그것, 없으면 판정기가 받은 가장 최근 후보", async () => {
  const exactRow = { status: "applied" as const, receivedAt: "2026-11-07T00:00:00Z" };
  let candCalls = 0;
  const cands: AgentDeployCandidates = async () => { candCalls++; return [
    { rev: E, status: "failed", reason: "다른 묶음", receivedAt: "2026-11-07T00:02:00Z" },
    { rev: D, status: "applied", receivedAt: "2026-11-07T00:01:00Z" },
  ]; };
  const accept = async (_c: string, rev: string) => rev === D;
  assert.deepEqual(await withDescendantReports(async () => exactRow, cands, accept)("app", C.commit), exactRow);
  assert.equal(candCalls, 0, "같은 커밋 보고가 있으면 후보를 안 본다");
  assert.deepEqual(await withDescendantReports(never, cands, accept)("app", C.commit), { status: "applied", receivedAt: "2026-11-07T00:01:00Z" });
});

test("거부: 판정기가 아니라고 하거나 던지면 후보를 받지 않는다", async () => {
  const cands: AgentDeployCandidates = async () => [{ rev: D, status: "applied", receivedAt: "x" }];
  assert.equal(await withDescendantReports(never, cands, async () => false)("app", C.commit), null);
  assert.equal(await withDescendantReports(never, cands, async () => { throw new Error("git"); })("app", C.commit), null);
});

test("syncWatcherFor: covers 가 있으면 후손 리비전의 applied 보고로 성공, 없으면 예전처럼 시간 초과", async () => {
  const seen: string[] = [];
  const covers: RevisionCovers = async (bb, c, rev) => { seen.push(`${bb.app}/${bb.env} ${c.slice(0, 4)}..${rev.slice(0, 4)}`); return rev === D; };
  const candidates: AgentDeployCandidates = async () => [{ rev: D, status: "applied", receivedAt: "2026-11-07T00:01:00Z" }];
  const ctx = { tenantId: "t", targetEnvId: "e" };
  const r = await syncWatcherFor(ctx, ENV, { lookup: never, candidates, covers, ...clock() }).wait(b, C);
  assert.equal(r.ok, true);
  assert.deepEqual(seen, ["shop/onprem-k3s cccc..dddd"], "이 앱 묶음으로 한 번 묻는다");
  const none = await syncWatcherFor(ctx, ENV, { lookup: never, candidates, ...clock() }).wait(b, C);
  assert.match(none.reason ?? "", /^AGENT_DEPLOY_TIMEOUT: 30초/);
  const rejected = await syncWatcherFor(ctx, ENV, { lookup: never, candidates, covers: async () => false, ...clock() }).wait(b, C);
  assert.match(rejected.reason ?? "", /^AGENT_DEPLOY_TIMEOUT/);
});
