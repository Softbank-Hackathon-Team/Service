// vCluster 리허설 계약 (sandbox.ts) 시험. 모양마다 정상 1·거부 1, 그리고 실행 종류별 격리 표
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  FidelityMatrix, RehearsalInput, RehearsalCheck, RehearsalResult, RehearsalView, SandboxRunJob, JOB_SCHEMAS, QUEUES,
  TransitionEvidence, SandboxMode, REHEARSAL_FAILURE_CLASS, RehearsalFailureCode, fidelityOwner, sandboxIsolation,
  rehearsalSettings, sandboxSettings,
} from "../src/index.js";

const SHA = "a".repeat(64);
const matrix = () => ({
  version: 1, target: "aws-eks", bundleSha256: SHA,
  items: [
    { id: "manifests", status: "identical", real: "커밋할 렌더", sandbox: "같은 바이트", reason: "지문 비교", refs: [] },
    { id: "replicas", status: "substituted", real: "3", sandbox: "1", reason: "작은 노드", refs: ["Deployment/app-shop/web"] },
  ],
});
const doc = { path: "manifests/web.yaml", yaml: "kind: Deployment" };
const input = () => ({
  version: 1, target: "onprem-k3s", app: "shop", namespace: "app-shop", bundleSha256: SHA, k8sMinor: "1.35",
  original: [doc], apply: [doc], images: [{ ref: "r/web@sha256:1", sandboxRef: "sandbox/web@sha256:1" }], imagesMirrored: true, runBudgetSec: 1200,
  databases: [{ service: "db", majorVersion: "16", database: "shop", owner: "app", secretName: "db-app", secretKeys: ["password"] }],
  targetPodSecurity: "baseline", targetQuota: { limitsCpuM: 4000, limitsMemoryMi: null },
  edges: [{ from: "web", host: "api", port: 8080 }], fidelity: matrix(),
});
const check = { id: "rollout", subject: "Deployment/web", required: true, ok: true, ms: 1200, detail: "2/2 ready" };
const result = (over: Record<string, unknown> = {}) => ({
  verdict: "passed", failureCode: null,
  sandbox: { podSecurity: "baseline", runtimeClass: null, name: "sbx-1", hostNamespace: "sbx-1", chart: "vcluster-0.37.6", k8sVersion: "v1.35.0", mock: false },
  bundleSha256: SHA, checks: [check], fidelity: matrix(), warnings: [],
  timingsMs: { create: 40000, apply: 3000, check: 60000, delete: 9000 }, deleted: true, ...over,
});

test("FidelityMatrix: 정상 / 같은 항목 id 두 번은 거부", () => {
  assert.ok(FidelityMatrix.safeParse(matrix()).success);
  const m = matrix();
  m.items.push({ ...m.items[0]! });
  assert.equal(FidelityMatrix.safeParse(m).success, false);
});

test("RehearsalInput: 정상 / 쿠버네티스 마이너 모양이 틀리면 거부", () => {
  assert.ok(RehearsalInput.safeParse(input()).success);
  assert.equal(RehearsalInput.safeParse({ ...input(), k8sMinor: "1.5" }).success, false);
  assert.equal(RehearsalInput.safeParse({ ...input(), apply: [] }).success, false, "적용할 사본 0개");
  const { imagesMirrored: _m, ...noFlag } = input();
  assert.equal(RehearsalInput.safeParse(noFlag).success, false, "복사했는지 모르는 입력은 받지 않는다");
  assert.equal(RehearsalInput.safeParse({ ...input(), runBudgetSec: 0 }).success, false, "실행 기한 0초");
});

test("RehearsalCheck: 정상 / 음수 시간·모르는 검사 id 는 거부", () => {
  assert.ok(RehearsalCheck.safeParse(check).success);
  assert.equal(RehearsalCheck.safeParse({ ...check, ms: -1 }).success, false);
  assert.equal(RehearsalCheck.safeParse({ ...check, id: "vibes" }).success, false);
});

test("RehearsalResult: 통과면 코드 없음, 실패·오류면 코드 있음 (어긋나면 거부)", () => {
  assert.ok(RehearsalResult.safeParse(result()).success);
  assert.ok(RehearsalResult.safeParse(result({ verdict: "failed", failureCode: "REHEARSAL_CRASHLOOP" })).success);
  assert.equal(RehearsalResult.safeParse(result({ failureCode: "REHEARSAL_CRASHLOOP" })).success, false, "통과인데 코드");
  assert.equal(RehearsalResult.safeParse(result({ verdict: "error" })).success, false, "오류인데 코드 없음");
  assert.equal(RehearsalResult.safeParse(result({ verdict: "failed", failureCode: "ARGO_TIMEOUT" })).success, false, "리허설 목록 밖 코드");
});

test("RehearsalView: 줄 없음(null)·줄 있음 정상 / 모르는 상태는 거부", () => {
  const migrationId = randomUUID();
  assert.ok(RehearsalView.safeParse({ migrationId, run: null }).success);
  const run = {
    id: randomUUID(), status: "passed", failureCode: null, phase: "done", skip: null, reusedFrom: null, sandboxName: "sbx-1",
    createdAt: "2026-11-04T00:00:00Z", startedAt: "2026-11-04T00:00:01Z", finishedAt: "2026-11-04T00:03:00Z", deadlineAt: "2026-11-04T00:20:00Z",
    fidelity: matrix(), result: result(), stale: false,
  };
  assert.ok(RehearsalView.safeParse({ migrationId, run }).success);
  assert.ok(RehearsalView.safeParse({ migrationId, run: { ...run, stale: true } }).success, "지난 시도의 줄도 그대로 보인다");
  assert.equal(RehearsalView.safeParse({ migrationId, run: { ...run, status: "done" } }).success, false);
  const timedOut = { ...run, status: "error", failureCode: "REHEARSAL_TIMEOUT", result: null };
  assert.ok(RehearsalView.safeParse({ migrationId, run: timedOut }).success, "결과 없이 실패 코드만 있는 줄");
  assert.equal(RehearsalView.safeParse({ migrationId, run: { ...timedOut, failureCode: "ARGO_TIMEOUT" } }).success, false, "리허설 목록 밖 코드");
  const { stale: _, ...noStale } = run;
  assert.equal(RehearsalView.safeParse({ migrationId, run: noStale }).success, false, "stale 칸은 빠질 수 없다");
});

test("sandbox-rehearsal 큐: 작업 내용은 줄 번호 하나 / 줄 번호 없거나 다른 칸이 있으면 거부", () => {
  const job = { tenantId: randomUUID(), requestId: "r", sandboxRunId: randomUUID() };
  assert.equal(QUEUES.sandboxRehearsal, "sandbox-rehearsal");
  assert.ok(JOB_SCHEMAS[QUEUES.sandboxRehearsal].safeParse(job).success);
  assert.equal(SandboxRunJob.safeParse({ ...job, sandboxRunId: undefined }).success, false);
  assert.equal(SandboxRunJob.safeParse({ ...job, input: {} }).success, false);
});

test("TransitionEvidence.rehearsal: 통과·재사용·건너뜀 이유만, 실패는 이 길로 못 옴", () => {
  for (const v of ["passed", "reused", "non_k8s", "no_cluster", "unsupported_target", "disabled", "mock"])
    assert.ok(TransitionEvidence.safeParse({ rehearsal: v }).success, v);
  assert.equal(TransitionEvidence.safeParse({ rehearsal: "failed" }).success, false);
});

test("SandboxMode: vcluster 를 받고 모르는 값은 거부", () => {
  assert.ok(SandboxMode.safeParse("vcluster").success);
  assert.equal(SandboxMode.safeParse("docker").success, false);
});

test("격리: 런타임은 둘 다 SANDBOX_RUNTIME_CLASS (비면 노드 기본), 파드 보안은 리허설 baseline·수정 고리 restricted", () => {
  const gvisor = { SANDBOX_RUNTIME_CLASS: " gvisor " };
  assert.deepEqual(sandboxIsolation("rehearsal", gvisor), { podSecurity: "baseline", runtimeClass: "gvisor" });
  assert.deepEqual(sandboxIsolation("rehearsal", {}), { podSecurity: "baseline", runtimeClass: null }, "gVisor 없는 로컬 kind");
  assert.deepEqual(sandboxIsolation("remediation", gvisor), { podSecurity: "restricted", runtimeClass: "gvisor" });
  assert.deepEqual(sandboxIsolation("remediation", { SANDBOX_RUNTIME_CLASS: "" }), { podSecurity: "restricted", runtimeClass: null });
});

test("실패 뜻: 샌드박스만의 거부·지원 밖 종류는 '실제도 실패'로 안 보인다, 앱 고장은 would_fail", () => {
  assert.equal(REHEARSAL_FAILURE_CLASS.REHEARSAL_POLICY_DENIED, "cannot_vouch");
  assert.equal(REHEARSAL_FAILURE_CLASS.REHEARSAL_UNSUPPORTED_KIND, "cannot_vouch");
  assert.equal(REHEARSAL_FAILURE_CLASS.REHEARSAL_CRASHLOOP, "would_fail");
  assert.equal(REHEARSAL_FAILURE_CLASS.REHEARSAL_TIMEOUT, "platform");
  assert.equal(RehearsalFailureCode.options.length, 14);
});

test("충실도 항목 주인: 샌드박스 쪽 두 항목만 agent-worker", () => {
  assert.equal(fidelityOwner("sandbox_pod_security"), "agent-worker");
  assert.equal(fidelityOwner("runtime_isolation"), "agent-worker");
  assert.equal(fidelityOwner("images"), "worker");
});

test("설정 읽기: 비면 기본값 (리허설 꺼짐·실행 1200초·줄 서기 3600초·60초, 만료 1800초, 내장 차트, 진짜 샌드박스)", () => {
  assert.deepEqual(rehearsalSettings({}), { enabled: false, timeoutSec: 1200, queueTimeoutSec: 3600, pollSec: 60, imageRegistry: null, mock: false });
  assert.deepEqual(sandboxSettings({}), { ttlSec: 1800, vclusterChart: "/app/vendor/vcluster-0.37.6.tgz", mockResult: null });
  assert.equal(rehearsalSettings({ SANDBOX_REHEARSAL: "on", REHEARSAL_TIMEOUT_SEC: "600" }).timeoutSec, 600);
});

test("MOCK_SANDBOX: 켜면 기본 통과, MOCK_SANDBOX_RESULT=fail 이면 실패, 안 켜면 결과를 골라도 진짜 샌드박스", () => {
  assert.equal(sandboxSettings({ MOCK_SANDBOX: "1" }).mockResult, "pass");
  assert.equal(sandboxSettings({ MOCK_SANDBOX: "1", MOCK_SANDBOX_RESULT: "fail" }).mockResult, "fail");
  assert.equal(sandboxSettings({ MOCK_SANDBOX: "0", MOCK_SANDBOX_RESULT: "fail" }).mockResult, null);
  assert.equal(rehearsalSettings({ MOCK_SANDBOX: "1" }).mock, true);
});
