import { test } from "node:test";
import assert from "node:assert/strict";
import type { RehearsalInput, RehearsalResult, SandboxRunPhase, SandboxRunStatus } from "@svc/contracts";
import { asHostKube, mockRehearsalResult, type KubeClient } from "@svc/agent";
import { handleRehearsal } from "../src/handle-rehearsal.js";
import { handleAgentRun, memoryStore } from "../src/handle-agent-run.js";
import { sweepOnce } from "../src/sweeper.js";
import type { RehearsalFinish, SandboxRunStore } from "../src/pg-sandbox-run-store.js";

const T = "11111111-1111-4111-8111-111111111111";
const ID = "22222222-2222-4222-8222-222222222222";
const input: RehearsalInput = {
  version: 1, target: "aws-eks", app: "shop", namespace: "app-shop", bundleSha256: "d".repeat(64), k8sMinor: "1.35",
  original: [{ path: "m.yaml", yaml: JSON.stringify({ apiVersion: "v1", kind: "ConfigMap", metadata: { name: "cfg" } }) }],
  apply: [{ path: "m.yaml", yaml: JSON.stringify({ apiVersion: "apps/v1", kind: "Deployment", metadata: { name: "web" },
    spec: { selector: { matchLabels: { app: "web" } }, template: { metadata: { labels: { app: "web" } }, spec: { containers: [{ name: "web", image: "x" }] } } } }) }],
  images: [], databases: [], targetPodSecurity: "privileged", targetQuota: null, edges: [],
  fidelity: { version: 1, target: "aws-eks", bundleSha256: "d".repeat(64), items: [{ id: "manifests", status: "identical", real: "a", sandbox: "a", reason: "r", refs: [] }] },
};

function store(row: { status: SandboxRunStatus; input: unknown; deadlineAt?: Date | null } | null) {
  const s = { claimed: [] as string[], phases: [] as SandboxRunPhase[], finished: [] as RehearsalFinish[], claimOk: true };
  const st: SandboxRunStore = {
    load: async () => (row ? { migrationId: "m", tenantId: T, status: row.status, input: row.input, deadlineAt: row.deadlineAt ?? null } : null),
    claim: async (_t, _id, name) => { s.claimed.push(name); return s.claimOk; },
    phase: async (_t, _id, p) => { s.phases.push(p); },
    finish: async (_t, _id, f) => { s.finished.push(f); return { status: "result" in f ? f.result.verdict : "error", woken: 1 }; },
  };
  return { st, s };
}
const job = { tenantId: T, requestId: "r", sandboxRunId: ID };

test("리허설 작업: 줄을 잡고(running) 단계를 남기고 결과를 쓴 뒤 deploy 작업을 깨운다", async () => {
  const { st, s } = store({ status: "queued", input });
  const tenants: string[] = [];
  const r = await handleRehearsal(job, { store: st, rehearse: async (i, run) => {
    tenants.push(run.tenantId);
    await run.onPhase?.("creating"); await run.onPhase?.("checking");
    return mockRehearsalResult(i, run.id, "fail");
  } });
  assert.deepEqual(tenants, [T], "샌드박스 회사 라벨은 줄의 회사");
  assert.deepEqual(r, { skipped: false, status: "failed", failureCode: "REHEARSAL_CRASHLOOP", woken: 1 });
  assert.deepEqual(s.claimed, ["sbx-rehearsal-222222222222"]);
  assert.deepEqual(s.phases, ["creating", "checking"]);
  assert.equal((s.finished[0] as { result: RehearsalResult }).result.sandbox.name, "sbx-rehearsal-222222222222");
});

test("리허설 작업: 두 번 온 작업·기한 지난 줄·다른 워커가 잡은 줄은 아무것도 안 한다", async () => {
  const never = async () => { throw new Error("돌면 안 됨"); };
  for (const [row, reason] of [
    [null, "missing"], [{ status: "running", input }, "not_queued"], [{ status: "queued", input, deadlineAt: new Date(Date.now() - 1000) }, "deadline"],
  ] as const) {
    const { st, s } = store(row as never);
    assert.deepEqual(await handleRehearsal(job, { store: st, rehearse: never }), { skipped: true, reason });
    assert.equal(s.claimed.length + s.finished.length, 0, reason);
  }
  const { st, s } = store({ status: "queued", input });
  s.claimOk = false;
  assert.deepEqual(await handleRehearsal(job, { store: st, rehearse: never }), { skipped: true, reason: "claimed_elsewhere" });
  assert.equal(s.finished.length, 0);
});

test("리허설 작업: 입력이 계약에 안 맞거나 처리기가 던지면 결과 없이 REHEARSAL_SANDBOX_UNAVAILABLE", async () => {
  const bad = store({ status: "queued", input: { version: 2 } });
  let ran = false;
  const r1 = await handleRehearsal(job, { store: bad.st, rehearse: async (i, run) => { ran = true; return mockRehearsalResult(i, run.id, "pass"); } });
  assert.deepEqual([r1.skipped, ran], [false, false]);
  assert.deepEqual(bad.s.finished[0] && "failureCode" in bad.s.finished[0] ? bad.s.finished[0].failureCode : null, "REHEARSAL_SANDBOX_UNAVAILABLE");
  const boom = store({ status: "queued", input });
  const r2 = await handleRehearsal(job, { store: boom.st, rehearse: async () => { throw new Error("socket hang up"); } });
  assert.deepEqual(r2, { skipped: false, status: "error", failureCode: "REHEARSAL_SANDBOX_UNAVAILABLE", woken: 1 });
  assert.match((boom.s.finished[0] as { reason: string }).reason, /socket hang up/);
});

test("만료 청소: 지우기 실패를 실행 번호·네임스페이스와 함께 경고로 남긴다 (#177)", async () => {
  const items = [
    { metadata: { name: "sbx-rehearsal-aaaaaaaaaaaa", labels: { "platform.svc/sandbox": "true", "platform.svc/expires-at": "1000000000", "platform.svc/sandbox-run": "run-a" } } },
    { metadata: { name: "sbx-rehearsal-bbbbbbbbbbbb", labels: { "platform.svc/sandbox": "true", "platform.svc/expires-at": "1000000000", "platform.svc/sandbox-run": "run-b" } } },
  ];
  const deleted: string[] = [];
  const kube: KubeClient = { call: async (method, path) => {
    if (method === "GET") return { status: 200, body: { items }, text: "", warnings: [] };
    if (path.endsWith("bbbbbbbbbbbb")) return { status: 403, body: { message: "denied by sbx-namespace-guard" }, text: "", warnings: [] };
    deleted.push(path); return { status: 200, body: {}, text: "", warnings: [] };
  } };
  const warns: Array<Record<string, unknown>> = [];
  const r = await sweepOnce(asHostKube(kube), { info: () => {}, warn: (o) => { warns.push(o as Record<string, unknown>); } }, 2_000_000_000_000);
  assert.deepEqual(r?.deleted, ["sbx-rehearsal-aaaaaaaaaaaa"]);
  assert.deepEqual(warns, [{ sandbox_run_id: "run-b", namespace: "sbx-rehearsal-bbbbbbbbbbbb", err: "403: denied by sbx-namespace-guard" }]);
});

test("수정 고리: 샌드박스 지우기 실패를 실행 번호·네임스페이스와 함께 경고로 남긴다 (#177)", async () => {
  const R = "33333333-3333-4333-8333-333333333333";
  const st = memoryStore({ [R]: { status: "queued", task: "x", repo: new Map() } });
  const warns: Array<Record<string, unknown>> = [];
  const { scriptedLlm, memorySandbox } = await import("@svc/agent");
  await handleAgentRun({ tenantId: T, requestId: "r", agentRunId: R }, {
    store: st, llm: scriptedLlm([{ name: "finish", input: { outcome: "give_up", title: "x", rationale: "-", verified: [], not_verified: [] } }]),
    sandbox: () => ({ ...memorySandbox(), namespace: "sbx-11111111-33333333-abcd", dispose: async () => { throw new Error("kube API 연결 실패"); } }),
    log: { warn: (o) => { warns.push(o as Record<string, unknown>); } },
  });
  assert.deepEqual(warns, [{ agent_run_id: R, namespace: "sbx-11111111-33333333-abcd", err: "kube API 연결 실패" }]);
});
