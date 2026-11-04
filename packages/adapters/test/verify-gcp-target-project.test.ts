// 결정 3번 A안: GCP 이전 전용 프로젝트 연결 확인 — 가짜 exec 만 (실제 gcloud 호출 없음)
//   전용 프로젝트 번호를 고정하고, svc-operate 는 전용 프로젝트에서 찾고, 도착 GKE 가 전용 프로젝트에 있으면 거기서 can-i
import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyGcpObserve } from "../src/verify/gcp.js";
import type { Exec } from "../src/terraform/real-runner.js";

type Reply = { code?: number; out?: unknown; err?: string };
function fakeExec(table: Array<[RegExp, Reply]>) {
  const calls: string[] = [];
  const exec: Exec = async (cmd, args) => {
    const line = `${cmd} ${args.join(" ")}`; calls.push(line);
    const hit = table.find(([re]) => re.test(line));
    const r = hit?.[1] ?? { code: 1, err: `no fake for: ${line}` };
    return { code: r.code ?? 0, stdout: typeof r.out === "string" ? r.out : JSON.stringify(r.out ?? null), stderr: r.err ?? "", ms: 1 };
  };
  return { exec, calls };
}
const P = "cust-proj-123", T = "cust-mig-123";
const table = (over: Array<[RegExp, Reply]> = []): Array<[RegExp, Reply]> => [...over,
  [new RegExp(`^gcloud projects describe ${P} `), { out: { projectId: P, projectNumber: "123456789012" } }],
  [new RegExp(`^gcloud projects describe ${T} `), { out: { projectId: T, projectNumber: "222222222222" } }],
  [new RegExp(`^gcloud container clusters list --project ${P} `), { out: [] }],
  [new RegExp(`^gcloud container clusters list --project ${T} `), { out: [{ name: "shop-gke", location: "asia-northeast3" }] }],
  [new RegExp(`^gcloud container clusters get-credentials shop-gke --location asia-northeast3 --project ${T} `), { out: "" }],
  [/^kubectl --kubeconfig \S+ auth can-i list deployments --all-namespaces/, { out: "yes\n" }],
  [/^gcloud sql instances list/, { out: [] }],
  [new RegExp(`^gcloud iam service-accounts describe svc-operate@${T}\\.iam\\.gserviceaccount\\.com --project ${T} `), { out: { email: "x" } }],
];
const input = { projectId: P, targetProjectId: T, token: "ya29.secret", clusterName: "shop-gke" };

test("A안 정상: 전용 프로젝트 번호를 돌려주고, svc-operate·도착 GKE 는 전용 프로젝트에서 본다", async () => {
  const f = fakeExec(table());
  const r = await verifyGcpObserve({ exec: f.exec, env: {} }, input);
  assert.deepEqual(r, { ok: true, clusters: ["shop-gke"], projectNumber: "123456789012", targetProjectNumber: "222222222222" });
  assert.ok(f.calls.some((c) => c.startsWith(`gcloud container clusters get-credentials shop-gke --location asia-northeast3 --project ${T}`)));
  assert.ok(!f.calls.some((c) => c.includes(`svc-operate@${P}`)), "원래 프로젝트의 svc-operate 는 안 찾음");
});

test("A안 거부: 전용 프로젝트 번호가 처음과 다르거나 ID 가 다르면 ACCOUNT_MISMATCH, 전용 프로젝트에 svc-operate 없으면 ROLE_NOT_FOUND", async () => {
  const f = fakeExec(table());
  assert.deepEqual(await verifyGcpObserve({ exec: f.exec, env: {} }, { ...input, expectedTargetProjectNumber: "999999999999" }), { ok: false, reason: "ACCOUNT_MISMATCH" });
  const other = fakeExec(table([[new RegExp(`^gcloud projects describe ${T} `), { out: { projectId: "someone-else", projectNumber: "333333333333" } }]]));
  assert.deepEqual(await verifyGcpObserve({ exec: other.exec, env: {} }, input), { ok: false, reason: "ACCOUNT_MISMATCH" });
  const noOp = fakeExec(table([[/^gcloud iam service-accounts describe/, { code: 1, err: "ERROR: NOT_FOUND: Unknown service account" }]]));
  assert.deepEqual(await verifyGcpObserve({ exec: noOp.exec, env: {} }, input), { ok: false, reason: "ROLE_NOT_FOUND" });
  const denied = fakeExec(table([[new RegExp(`^gcloud projects describe ${T} `), { code: 1, err: "ERROR: PERMISSION_DENIED" }]]));
  assert.deepEqual(await verifyGcpObserve({ exec: denied.exec, env: {} }, input), { ok: false, reason: "PERMISSION_MISSING:resourcemanager.projects.get" });
});
