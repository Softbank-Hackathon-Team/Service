import { test } from "node:test";
import assert from "node:assert/strict";
import { progressLine, reportLine } from "../src/features/environments/agentReports";
import type { AgentReportBody } from "../src/lib/types";

type DeployReport = Extract<AgentReportBody, { kind: "deploy" }>;
const deploy = (over: Partial<DeployReport>): DeployReport => ({ kind: "deploy", status: "applied", resources: ["Deployment/shop/web", "Service/shop/web"], ...over });

test("Agent deploy 보고: 진행 중(#377)은 실패로 보이지 않고 Argo 상태와 기다리는 자원을 말한다", () => {
  const progressing = deploy({ status: "progressing", progress: { sync: "Synced", health: "Progressing", message: "waiting for rollout", waitingOn: { resource: "Cluster/shop/shop-db", health: "Progressing" } } });
  assert.equal(reportLine(progressing), "배포 진행 중 · Synced/Progressing · 기다리는 자원 Cluster/shop/shop-db (Progressing)");
  assert.doesNotMatch(reportLine(progressing), /실패/);
  assert.equal(progressLine({ sync: "OutOfSync", health: "Missing", message: "app syncing" }), "배포 진행 중 · OutOfSync/Missing · app syncing");
  assert.equal(progressLine({ sync: "Synced", health: "Progressing", waitingOn: { resource: "Deployment/shop/web" } }), "배포 진행 중 · Synced/Progressing · 기다리는 자원 Deployment/shop/web");
  assert.equal(progressLine({ sync: "Synced", health: "Progressing" }), "배포 진행 중 · Synced/Progressing");
  assert.equal(progressLine(undefined), "배포 진행 중");
});

test("Agent deploy 보고: 적용·실패 문장은 예전 그대로", () => {
  assert.equal(reportLine(deploy({})), "배포 적용 · 자원 2개");
  assert.equal(reportLine(deploy({ status: "failed", reason: "ImagePullBackOff" })), "배포 실패 · ImagePullBackOff");
  assert.equal(reportLine(deploy({ status: "failed" })), "배포 실패");
});
