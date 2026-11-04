// W4: 클러스터 안 Argo Application 상태 → deploy 보고 (끝난 것만). kubectl 은 고정 JSON
import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentReport } from "@svc/contracts";
import { collectArgoDeploys, type Kubectl } from "../src/index.js";

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
