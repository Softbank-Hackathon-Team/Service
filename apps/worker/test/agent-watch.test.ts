// W4: 온프레(agent-pull) 배포 확인 = Agent deploy 보고 기다리기. DB 없이 보고 찾기를 바꿔 끼운다
import { test } from "node:test";
import assert from "node:assert/strict";
import { agentPullWatcher, syncWatcherFor, type AgentDeployLookup } from "../src/gitops/agent-watch.js";

const b = { tenant: "t-0a1b2c3d", app: "shop", env: "onprem-k3s" as const };
const C = { commit: "c".repeat(40), bundleSha256: "x", resources: [], changed: true };
const clock = () => { let t = 0; return { now: () => t, sleep: async (ms: number) => { t += ms; } }; };
const ENV = { AGENT_DEPLOY_WAIT_SEC: "60", AGENT_DEPLOY_TICK_MS: "5000" };

test("같은 app + 커밋의 applied 보고가 오면 성공 (몇 번 기다린 뒤)", async () => {
  let n = 0;
  const seen: Array<[string, string]> = [];
  const lookup: AgentDeployLookup = async (app, commit) => { seen.push([app, commit]); return ++n < 3 ? null : { status: "applied", receivedAt: "2026-11-04T00:00:00Z" }; };
  const r = await agentPullWatcher(lookup, ENV, clock()).wait(b, C);
  assert.equal(r.ok, true);
  assert.equal(r.observed?.polls, 3);
  assert.deepEqual(seen[0], ["t-0a1b2c3d-shop-onprem-k3s", C.commit]);
});

test("거부: failed 보고 → AGENT_DEPLOY_FAILED, 보고 없음 → 시간 초과 AGENT_DEPLOY_TIMEOUT", async () => {
  const failed = await agentPullWatcher(async () => ({ status: "failed", reason: "Deployment api: 0/1 ready", receivedAt: "x" }), ENV, clock()).wait(b, C);
  assert.equal(failed.ok, false);
  assert.match(failed.reason!, /^AGENT_DEPLOY_FAILED: .*0\/1 ready/);
  const none = await agentPullWatcher(async () => null, ENV, clock()).wait(b, C);
  assert.equal(none.ok, false);
  assert.match(none.reason!, /^AGENT_DEPLOY_TIMEOUT: 60초/);
  assert.equal(none.observed?.polls, 13);   // 0,5,...,60초
});

test("깃발: 기본 꺼짐이면 온프레는 예전처럼 기다리지 않는다, 켜면 Agent 보고를 본다, 클라우드는 늘 Argo 쪽", async () => {
  const never: AgentDeployLookup = async () => null;
  // 꺼짐 (Argo 설정 없음): 온프레는 바로 ok (예전 동작), 클라우드는 ARGO_NOT_CONFIGURED
  assert.equal((await syncWatcherFor({ tenantId: "t", targetEnvId: "e" }, {}, { lookup: never }).wait(b, C)).ok, true);
  // 켬: 온프레는 Agent 보고를 기다려 시간 초과
  const on = syncWatcherFor({ tenantId: "t", targetEnvId: "e" }, { ...ENV, AGENT_DEPLOY_CONFIRM: "1" }, { lookup: never, ...clock() });
  assert.match((await on.wait(b, C)).reason ?? "", /^AGENT_DEPLOY_TIMEOUT/);
  const cloud = await on.wait({ ...b, env: "gcp-gke" }, C);
  assert.match(cloud.reason ?? "", /^ARGO_NOT_CONFIGURED/);
  // MOCK_ARGO=1 (시험) 이면 켜도 흉내 그대로
  assert.equal((await syncWatcherFor({ tenantId: "t", targetEnvId: "e" }, { MOCK_ARGO: "1", AGENT_DEPLOY_CONFIRM: "1" }, { lookup: never }).wait(b, C)).ok, true);
});
