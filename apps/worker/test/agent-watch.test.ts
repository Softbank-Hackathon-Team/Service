// W4: 온프레(agent-pull) 배포 확인 = Agent deploy 보고 기다리기. DB 없이 보고 찾기를 바꿔 끼운다
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  agentOfflineSec, agentPullWatcher, agentStopHint, progressNote, syncWatcherFor, type AgentDeployLookup, type AgentProgressRow,
} from "../src/gitops/agent-watch.js";

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

test("깃발: 기본 켬이면 온프레는 Agent 보고를 본다, 0 이면 예전처럼 기다리지 않는다, 클라우드는 늘 Argo 쪽", async () => {
  const never: AgentDeployLookup = async () => null;
  // 0 (Argo 설정 없음): 온프레는 바로 ok (예전 동작)
  assert.equal((await syncWatcherFor({ tenantId: "t", targetEnvId: "e" }, { AGENT_DEPLOY_CONFIRM: "0" }, { lookup: never }).wait(b, C)).ok, true);
  // 기본(값 없음) = 켬: 온프레는 Agent 보고를 기다려 시간 초과. 클라우드는 ARGO_NOT_CONFIGURED
  const on = syncWatcherFor({ tenantId: "t", targetEnvId: "e" }, { ...ENV }, { lookup: never, ...clock() });
  assert.match((await on.wait(b, C)).reason ?? "", /^AGENT_DEPLOY_TIMEOUT/);
  const cloud = await on.wait({ ...b, env: "gcp-gke" }, C);
  assert.match(cloud.reason ?? "", /^ARGO_NOT_CONFIGURED/);
  // MOCK_ARGO=1 (시험) 이면 켜도 흉내 그대로
  assert.equal((await syncWatcherFor({ tenantId: "t", targetEnvId: "e" }, { MOCK_ARGO: "1", AGENT_DEPLOY_CONFIRM: "1" }, { lookup: never }).wait(b, C)).ok, true);
});

// #373 D2: 진행 보고 · Agent 끊김. 시계·하트비트·진행 보고를 바꿔 끼운다 (가짜 저장소)
const CNPG: AgentProgressRow = { sync: "Synced", health: "Progressing", receivedAt: "2026-11-07T03:05:10.000Z",
  waitingOn: { resource: "Cluster/app-shop/shop-db", health: "Progressing", message: "Setting up primary" } };

test("시간 초과 이유에 마지막 진행 상태와 하트비트 나이를 싣는다 (진행 중은 끝으로 보지 않는다)", async () => {
  const asked: Array<[string, string]> = [];
  const w = agentPullWatcher(async () => null, ENV, { ...clock(), heartbeat: async () => 8,
    progress: async (app, commit) => { asked.push([app, commit]); return CNPG; } });
  const r = await w.wait(b, C);
  assert.equal(r.ok, false);
  assert.match(r.reason!, /^AGENT_DEPLOY_TIMEOUT: 60초 안에 /);
  assert.match(r.reason!, / — 마지막 상태 Synced\/Progressing: Cluster\/app-shop\/shop-db Progressing \(Setting up primary\), 03:05:10Z 보고 · Agent 하트비트 8초 전$/);
  assert.equal(r.observed?.polls, 13, "진행 보고가 있어도 시간 끝까지 기다림");
  assert.equal(r.observed?.health, "Progressing");
  assert.deepEqual(asked, [["t-0a1b2c3d-shop-onprem-k3s", C.commit]], "진행 보고는 멈출 때 한 번만 읽는다");
  // 진행 보고가 없으면 그렇다고 쓴다 (Argo 가 아직 안 당김·예전 Agent)
  const none = await agentPullWatcher(async () => null, ENV, { ...clock(), heartbeat: async () => 3, progress: async () => null }).wait(b, C);
  assert.match(none.reason!, /이 커밋의 진행 보고 없음 .* · Agent 하트비트 3초 전$/);
});

test("Agent 하트비트가 AGENT_OFFLINE_SEC 넘게 끊기면 600초를 다 기다리지 않고 AGENT_OFFLINE", async () => {
  const c = clock();
  let hbAt = 0;   // 마지막 하트비트 시각 (가짜 시계 ms). 20초 뒤 끊김
  const heartbeat = async () => { const t = c.now(); if (t <= 20_000) hbAt = t; return Math.floor((t - hbAt) / 1000); };
  const r = await agentPullWatcher(async () => null, { ...ENV, AGENT_DEPLOY_WAIT_SEC: "600", AGENT_OFFLINE_SEC: "90" }, { ...c, heartbeat, progress: async () => CNPG }).wait(b, C);
  assert.equal(r.ok, false);
  assert.match(r.reason!, /^AGENT_OFFLINE: t-0a1b2c3d-shop-onprem-k3s 커밋 c{12} 반영을 기다리는 중 Agent 하트비트가 95초째 없다 \(기준 90초\)/);
  assert.match(r.reason!, /마지막 상태 Synced\/Progressing: Cluster\/app-shop\/shop-db/);
  assert.equal(r.observed?.ms, 115_000, "끊긴 뒤 90초 + 한 틱에 멈춤 (600초 아님)");
  // 한 번도 안 왔으면 바로
  const never = await agentPullWatcher(async () => null, ENV, { ...clock(), heartbeat: async () => null }).wait(b, C);
  assert.match(never.reason!, /^AGENT_OFFLINE: .*한 번도 오지 않았다/);
  assert.equal(never.observed?.polls, 1);
  // 기준 안이면 계속 기다린다 (기본 = AGENT_STALE_SEC 120)
  const fresh = await agentPullWatcher(async () => null, ENV, { ...clock(), heartbeat: async () => 120 }).wait(b, C);
  assert.match(fresh.reason!, /^AGENT_DEPLOY_TIMEOUT/);
});

test("거부·안전: applied 가 오면 끊김보다 먼저 성공, 하트비트 읽기 오류는 판단 안 함, AGENT_OFFLINE_SEC=0 이면 끔", async () => {
  const ok = await agentPullWatcher(async () => ({ status: "applied", receivedAt: "x" }), ENV, { ...clock(), heartbeat: async () => 9999 }).wait(b, C);
  assert.equal(ok.ok, true);
  const flaky = await agentPullWatcher(async () => null, ENV, { ...clock(), heartbeat: async () => { throw new Error("db down"); } }).wait(b, C);
  assert.match(flaky.reason!, /^AGENT_DEPLOY_TIMEOUT: 60초 안에 [^—]*$/, "읽기 오류면 끊김으로 보지 않고 하트비트 줄도 안 붙임");
  const off = await agentPullWatcher(async () => null, { ...ENV, AGENT_OFFLINE_SEC: "0" }, { ...clock(), heartbeat: async () => null }).wait(b, C);
  assert.match(off.reason!, /^AGENT_DEPLOY_TIMEOUT/);
  assert.equal(agentOfflineSec({}), 120);
  assert.equal(agentOfflineSec({ AGENT_STALE_SEC: "90" }), 90);
  assert.equal(agentOfflineSec({ AGENT_STALE_SEC: "90", AGENT_OFFLINE_SEC: "45" }), 45);
  assert.equal(agentOfflineSec({ AGENT_OFFLINE_SEC: "abc" }), 0);
  // syncWatcherFor 가 lookup 만 받으면(시험) DB 로 하트비트를 읽지 않는다 → 끊김 판단 없이 시간 초과
  const on = syncWatcherFor({ tenantId: "t", targetEnvId: "e" }, { ...ENV }, { lookup: async () => null, ...clock() });
  assert.match((await on.wait(b, C)).reason ?? "", /^AGENT_DEPLOY_TIMEOUT: 60초 안에 [^—]*$/);
  // 주입한 하트비트는 그대로 쓴다
  const inj = syncWatcherFor({ tenantId: "t", targetEnvId: "e" }, { ...ENV }, { lookup: async () => null, heartbeat: async () => null, ...clock() });
  assert.match((await inj.wait(b, C)).reason ?? "", /^AGENT_OFFLINE/);
});

test("멈춤 도움말: AGENT_OFFLINE 은 빠진 것 + 고치는 법(Agent 파드·VM·네트워크 → 재개), 다른 코드는 없음", () => {
  const h = agentStopHint("AGENT_OFFLINE");
  assert.deepEqual(h.missing, ["온프레 Agent 하트비트 (AGENT_OFFLINE_SEC 안)"]);
  assert.match(h.hint!, /kubectl -n svc-agent get pods.*VM.*네트워크.*재개/);
  assert.ok(agentStopHint("AGENT_DEPLOY_TIMEOUT").hint);
  assert.deepEqual(agentStopHint("ARGO_TIMEOUT"), {});
  assert.equal(progressNote({ sync: "OutOfSync", health: "Healthy", receivedAt: "2026-11-07T03:00:00.000Z" }), "마지막 상태 OutOfSync/Healthy, 03:00:00Z 보고");
});
