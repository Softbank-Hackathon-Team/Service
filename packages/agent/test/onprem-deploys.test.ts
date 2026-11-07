// W4: 클러스터 안 Argo Application 상태 → deploy 보고 (끝난 것 + #373 D2 진행 중). kubectl 은 고정 JSON
import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentReport } from "@svc/contracts";
import { collectArgoDeploys, DeployReportGate, periodic, SLOW_REPORT_PERIOD_MS, type DeployReport, type Kubectl } from "../src/index.js";

const REV = "c".repeat(40);
const app = (name: string, sync: string, health: string, extra: Record<string, unknown> = {}) => ({
  metadata: { name },
  status: { sync: { status: sync, revision: REV }, health: { status: health }, resources: [{ kind: "Deployment", namespace: "app-shop", name: "api" }], ...extra },
});

test("Synced+Healthy = applied, Degraded·동기화 실패 = failed + 이유, 진행 중·커밋 없음 = 안 보냄", async () => {
  const calls: string[][] = [];
  const kubectl: Kubectl = async (args) => {
    calls.push(args);
    return JSON.stringify({ items: [
      app("t-0a1b2c3d-shop-onprem-k3s", "Synced", "Healthy"),
      app("t-0a1b2c3d-blog-onprem-k3s", "Synced", "Degraded", { health: { status: "Degraded", message: "Deployment api: 0/1 ready" } }),
      app("t-0a1b2c3d-wiki-onprem-k3s", "OutOfSync", "Missing", { operationState: { phase: "Failed", message: "one or more objects failed to apply" } }),
      app("t-0a1b2c3d-news-onprem-k3s", "OutOfSync", "Progressing"),
      { metadata: { name: "no-rev" }, status: { sync: { status: "Synced" }, health: { status: "Healthy" } } },
    ] });
  };
  const r = await collectArgoDeploys({ kubectl, agentVersion: "t", now: () => new Date("2026-11-04T00:00:00Z"), argocdNamespace: "argocd", tenant: "t-0a1b2c3d" });
  for (const x of r) AgentReport.parse(x);
  assert.deepEqual(r.map((x) => [x.app, x.status]), [
    ["t-0a1b2c3d-shop-onprem-k3s", "applied"], ["t-0a1b2c3d-blog-onprem-k3s", "failed"], ["t-0a1b2c3d-wiki-onprem-k3s", "failed"],
  ]);
  assert.equal(r[0]!.bundleHash, REV);
  assert.deepEqual(r[0]!.resources, ["Deployment/app-shop/api"]);
  assert.equal(r[0]!.reason, undefined);
  assert.match(r[1]!.reason!, /0\/1 ready/);
  assert.match(r[2]!.reason!, /failed to apply/);
  // 회사 라벨로 거른다 (다른 회사 Application 을 보고하지 않게)
  assert.deepEqual(calls[0], ["get", "applications.argoproj.io", "-n", "argocd", "-l", "svc.tenant=t-0a1b2c3d", "-o", "json"]);
});

// #373 D2: 진행 중(progressing) 보고. CNPG Cluster 가 아직 준비 안 됨 = Argo 상태 판정(tools/onprem-argocd-health.yaml)이 Progressing
const cnpgWaiting = app("t-0a1b2c3d-shop-onprem-k3s", "Synced", "Progressing", {
  resources: [
    { kind: "Deployment", namespace: "app-shop", name: "api", status: "Synced", health: { status: "Healthy" } },
    { kind: "Cluster", namespace: "app-shop", name: "shop-db", status: "Synced", health: { status: "Progressing", message: "Setting up primary" } },
    { kind: "Service", namespace: "app-shop", name: "api", status: "Synced" },
  ],
});

test("progress 를 켜면 진행 중 앱도 progressing 으로: Argo 커밋 + 동기화·건강 + Healthy 아닌 첫 자원과 이유. 끄면 예전처럼 안 냄", async () => {
  const kubectl: Kubectl = async () => JSON.stringify({ items: [cnpgWaiting, app("t-0a1b2c3d-news-onprem-k3s", "OutOfSync", "Healthy", {
    resources: [{ kind: "Deployment", namespace: "app-news", name: "web", status: "OutOfSync", health: { status: "Healthy" } }] })] });
  const o = { kubectl, agentVersion: "t", now: () => new Date("2026-11-07T03:00:00Z"), argocdNamespace: "argocd" };
  assert.deepEqual(await collectArgoDeploys(o), []);
  const r = await collectArgoDeploys({ ...o, progress: true });
  for (const x of r) AgentReport.parse(x);
  assert.deepEqual(r.map((x) => [x.app, x.status]), [["t-0a1b2c3d-shop-onprem-k3s", "progressing"], ["t-0a1b2c3d-news-onprem-k3s", "progressing"]]);
  assert.equal(r[0]!.bundleHash, REV);
  assert.deepEqual(r[0]!.progress, { sync: "Synced", health: "Progressing",
    waitingOn: { resource: "Cluster/app-shop/shop-db", health: "Progressing", sync: "Synced", message: "Setting up primary" } });
  assert.equal(r[0]!.reason, "Synced/Progressing — Cluster/app-shop/shop-db Progressing: Setting up primary");
  // Healthy 아닌 자원이 없으면 OutOfSync 인 첫 자원
  assert.equal(r[1]!.progress?.waitingOn?.resource, "Deployment/app-news/web");
  assert.equal(r[1]!.reason, "OutOfSync/Healthy — Deployment/app-news/web Healthy·OutOfSync");
});

const dep = (status: DeployReport["status"], o: { rev?: string; msg?: string } = {}): DeployReport => ({
  kind: "deploy", agentVersion: "t", sentAt: "2026-11-07T03:00:00Z", app: "t-0a1b2c3d-shop-onprem-k3s", bundleHash: o.rev ?? REV, resources: [], status,
  ...(status === "progressing" ? { progress: { sync: "Synced", health: "Progressing", ...(o.msg ? { message: o.msg } : {}) } } : {}),
});

test("DeployReportGate: progressing 은 바뀔 때만 + 앱마다 60초에 한 번, 새 커밋·끝→진행 중은 바로, applied·failed 는 (커밋, 결과)가 바뀔 때만", () => {
  let t = 0;
  const g = new DeployReportGate({ now: () => t });
  const send = (r: DeployReport) => { const due = g.due(r); if (due) g.sent(r); return due; };
  assert.equal(send(dep("progressing", { msg: "a" })), true, "처음");
  t = 10_000; assert.equal(send(dep("progressing", { msg: "a" })), false, "같은 상태는 다시 안 보냄");
  t = 20_000; assert.equal(send(dep("progressing", { msg: "b" })), false, "바뀌었지만 60초 안");
  t = 60_000; assert.equal(send(dep("progressing", { msg: "b" })), true, "60초 지나 바뀐 상태");
  t = 70_000; assert.equal(send(dep("progressing", { msg: "b", rev: "d".repeat(40) })), true, "새 커밋은 바로");
  t = 80_000; assert.equal(send(dep("applied", { rev: "d".repeat(40) })), true, "끝나면 바로");
  t = 90_000; assert.equal(send(dep("applied", { rev: "d".repeat(40) })), false, "applied 는 한 번");
  t = 95_000; assert.equal(send(dep("progressing", { rev: "d".repeat(40) })), true, "끝난 뒤 다시 진행 중이면 바로");
  // 보내기 실패면 기억하지 않는다 → 다음 차례에 다시
  const g2 = new DeployReportGate({ now: () => t });
  assert.equal(g2.due(dep("failed")), true);
  assert.equal(g2.due(dep("failed")), true);
});

test("DeployReportGate: 예전 API 가 progressing 을 400 으로 거절하면 10분 동안 progressing 만 끈다", () => {
  let t = 0;
  const g = new DeployReportGate({ now: () => t });
  assert.equal(g.rejected(dep("applied"), 400), false, "applied 400 은 끄지 않음");
  assert.equal(g.rejected(dep("progressing"), 503), false, "400 이 아니면 끄지 않음");
  assert.equal(g.rejected(dep("progressing"), 400), true);
  t = 599_999; assert.equal(g.due(dep("progressing")), false);
  assert.equal(g.due(dep("applied")), true, "applied 는 계속");
  t = 600_000; assert.equal(g.due(dep("progressing")), true);
});

test("#373 A3: 무거운 보고 시간표는 시간 기준 (처음 한 번 + 300초마다). --every 를 10초로 줄여도 늘지 않는다", () => {
  assert.equal(SLOW_REPORT_PERIOD_MS, 300_000);
  for (const every of [10_000, 30_000]) {
    const due = periodic(SLOW_REPORT_PERIOD_MS);
    let n = 0;
    for (let t = 0; t < 900_000; t += every) if (due(t)) n++;
    assert.equal(n, 3, `every=${every}`);   // 0, 300, 600초
  }
  const due = periodic(1000);
  assert.deepEqual([due(5), due(500), due(1004), due(1005), due(2004), due(2005)], [true, false, false, true, false, true]);
});
