// 리허설 동시 실행: 회사마다 다른 sandbox 노드에 고정한다 (다른 회사 샌드박스가 있는 노드는 피함). 흉내 호스트로 본다 (클러스터 호출 0)
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sandboxSettings } from "@svc/contracts";
import { asHostKube, createVcluster, KubeError, leftoverRehearsal, pickSandboxNode, vclusterValues, type SandboxNamespace, type VclusterSpec } from "../src/index.js";
import { fakeHelm, fakeHost, fakeVirtual } from "./fake-kube.js";

const T1 = "11111111-1111-4111-8111-111111111111", T2 = "22222222-2222-4222-8222-222222222222", T3 = "33333333-3333-4333-8333-333333333333";
const NOW = 1_800_000_000;
const nodeA = { name: "ip-a", hostname: "ip-a.internal" }, nodeB = { name: "ip-b", hostname: "ip-b.internal" };
const ns = (name: string, tenant: string, host: string | null, expires = NOW + 600): SandboxNamespace => ({ name, terminating: false, labels: {
  "platform.svc/sandbox": "true", "platform.svc/sandbox-purpose": "rehearsal", "platform.svc/tenant": tenant, "platform.svc/expires-at": String(expires),
  ...(host ? { "platform.svc/sandbox-node": host } : {}) } });
const spec = (tenantId: string, runId: string, o: Partial<VclusterSpec> = {}): VclusterSpec => ({
  kind: "rehearsal", runId, tenantId, isolation: { podSecurity: "baseline", runtimeClass: null }, k8sMinor: "1.35",
  quota: { requests: { cpuM: 900, memoryMi: 1200 }, limitsMemoryMi: 3000, pods: 9, storageMi: 1024 }, images: [], ttlSec: 1800, ...o,
});

test("노드 고르기: 다른 회사 샌드박스가 있는 노드는 빼고, 같은 회사·빈 노드 중 샌드박스가 적은 노드. 만료 지난 것·노드 라벨 없는 것은 안 셈", () => {
  assert.equal(pickSandboxNode([], [], T1, NOW), null, "노드 없음");
  assert.deepEqual(pickSandboxNode([nodeA, nodeB], [ns("sbx-x", T2, nodeA.hostname)], T1, NOW), nodeB, "다른 회사가 있는 A 는 안 고름");
  assert.equal(pickSandboxNode([nodeA], [ns("sbx-x", T2, nodeA.hostname)], T1, NOW), null, "빈 노드가 없으면 null (기다림)");
  assert.deepEqual(pickSandboxNode([nodeA], [ns("sbx-x", T1, nodeA.hostname)], T1, NOW), nodeA, "같은 회사만 있는 노드는 된다");
  assert.deepEqual(pickSandboxNode([nodeA, nodeB], [ns("sbx-x", T1, nodeA.hostname)], T1, NOW), nodeB, "둘 다 되면 샌드박스가 적은 노드");
  assert.deepEqual(pickSandboxNode([nodeA], [ns("sbx-old", T2, nodeA.hostname, NOW - 1)], T1, NOW), nodeA, "만료 지난 것은 청소 대상이라 안 셈");
  assert.deepEqual(pickSandboxNode([nodeB, nodeA], [], T1, NOW), nodeA, "같으면 이름 순 (결정적)");
  assert.deepEqual(pickSandboxNode([nodeA], [ns("sbx-legacy", T2, null)], T1, NOW), nodeA, "노드 라벨 없는 옛 샌드박스는 위치를 몰라 안 셈 (PR 남은 위험)");
});

test("차트 값: 노드를 주면 제어판·동기화 파드 모두 pool=sandbox + 그 hostname, 안 주면 예전처럼 pool 만", () => {
  const pinned = vclusterValues(spec(T1, "r1", { node: nodeA.hostname }), "sbx-rehearsal-r1") as any;
  const want = { pool: "sandbox", "kubernetes.io/hostname": nodeA.hostname };
  assert.deepEqual(pinned.controlPlane.statefulSet.scheduling.nodeSelector, want);
  assert.deepEqual(pinned.sync.fromHost.nodes.selector.labels, want);
  const plain = vclusterValues(spec(T1, "r1"), "sbx-rehearsal-r1") as any;
  assert.deepEqual(plain.controlPlane.statefulSet.scheduling.nodeSelector, { pool: "sandbox" });
  assert.deepEqual(plain.sync.fromHost.nodes.selector.labels, { pool: "sandbox" });
});

// 흉내 호스트 + sandbox 노드 목록
function hostWithNodes(nodes: Array<{ name: string; ready?: boolean; unschedulable?: boolean }>, seed: Array<{ name: string; labels: Record<string, string> }> = []) {
  const host = fakeHost(seed);
  const inner = host.kube.call.bind(host.kube);
  host.kube = { async call(method: string, path: string, o?: any) {
    const u = new URL(path, "http://x");
    if (method === "GET" && u.pathname === "/api/v1/nodes") {
      assert.equal(u.searchParams.get("labelSelector"), "pool=sandbox");
      return { status: 200, body: { items: nodes.map((n) => ({ metadata: { name: n.name, labels: { pool: "sandbox", "kubernetes.io/hostname": `${n.name}.internal` } },
        spec: n.unschedulable ? { unschedulable: true } : {}, status: { conditions: [{ type: "Ready", status: n.ready === false ? "False" : "True" }] } })) }, text: "" };
    }
    return inner(method, path, o);
  } } as any;
  return host;
}
const clock = () => { let t = NOW * 1000; return { now: () => t, sleep: async (ms: number) => { t += ms; } }; };

test("동시 실행: 두 회사가 같이 만들면 서로 다른 노드에 고정되고, 네임스페이스에 노드 라벨, 차트 값에 hostname", async () => {
  const host = hostWithNodes([{ name: "ip-a" }, { name: "ip-b" }, { name: "ip-c", ready: false }, { name: "ip-d", unschedulable: true }]);
  const helm = fakeHelm(host);
  const mk = (tenant: string, run: string) => createVcluster({ kube: asHostKube(host.kube), helm, chart: "c.tgz", workDir: mkdtempSync(join(tmpdir(), "vcp-")),
    ...clock(), pinNodes: true, connect: () => fakeVirtual({ readyAfter: 1 }).kube }, spec(tenant, run));
  const [a, b] = await Promise.all([mk(T1, "aaaaaaaa-0000-4000-8000-000000000001"), mk(T2, "bbbbbbbb-0000-4000-8000-000000000002")]);
  const nodeOf = (name: string) => host.namespaces.get(name)!["platform.svc/sandbox-node"];
  assert.deepEqual(new Set([nodeOf(a.name), nodeOf(b.name)]), new Set(["ip-a.internal", "ip-b.internal"]), "준비 안 됨·스케줄 막힘 노드는 안 고름, 둘이 다른 노드");
  const pinnedHosts = helm.values.map((v) => v.controlPlane.statefulSet.scheduling.nodeSelector["kubernetes.io/hostname"]).sort();
  assert.deepEqual(pinnedHosts, ["ip-a.internal", "ip-b.internal"]);
  await a.dispose(); await b.dispose();
});

test("동시 실행: 빈 노드가 없으면 기다렸다가 나면 쓰고, 끝까지 없으면 SANDBOX_NO_NODE 로 실패 (네임스페이스 안 남김)", async () => {
  const busy = { name: "sbx-rehearsal-other", labels: ns("sbx-rehearsal-other", T2, "ip-a.internal").labels };
  // 끝까지 없음
  const h1 = hostWithNodes([{ name: "ip-a" }], [busy]);
  const err = await createVcluster({ kube: asHostKube(h1.kube), helm: fakeHelm(h1), chart: "c.tgz", workDir: mkdtempSync(join(tmpdir(), "vcp-")),
    ...clock(), pinNodes: true, nodeWaitMs: 20_000, connect: () => fakeVirtual({ readyAfter: 1 }).kube }, spec(T1, "cccccccc-0000-4000-8000-000000000003")).then(() => null, (e) => e);
  assert.ok(err instanceof KubeError);
  assert.equal(err.code, "SANDBOX_NO_NODE");
  assert.deepEqual([...h1.namespaces.keys()], ["sbx-rehearsal-other"], "자기 네임스페이스는 안 만듦");
  // 기다리는 중에 다른 회사 것이 지워지면 그 노드를 쓴다
  const h2 = hostWithNodes([{ name: "ip-a" }], [busy]);
  const c = clock();
  const sleep = async (ms: number) => { await c.sleep(ms); h2.namespaces.delete("sbx-rehearsal-other"); };
  const vc = await createVcluster({ kube: asHostKube(h2.kube), helm: fakeHelm(h2), chart: "c.tgz", workDir: mkdtempSync(join(tmpdir(), "vcp-")),
    now: c.now, sleep, pinNodes: true, nodeWaitMs: 60_000, connect: () => fakeVirtual({ readyAfter: 1 }).kube }, spec(T1, "dddddddd-0000-4000-8000-000000000004"));
  assert.equal(h2.namespaces.get(vc.name)!["platform.svc/sandbox-node"], "ip-a.internal");
});

test("고정을 끄면(동시 1건) 노드를 묻지 않고 예전처럼 pool 만, 노드 라벨 없음", async () => {
  const host = fakeHost();
  const helm = fakeHelm(host);
  const vc = await createVcluster({ kube: asHostKube(host.kube), helm, chart: "c.tgz", workDir: mkdtempSync(join(tmpdir(), "vcp-")), ...clock(),
    connect: () => fakeVirtual({ readyAfter: 1 }).kube }, spec(T1, "eeeeeeee-0000-4000-8000-000000000005"));
  assert.ok(!host.requests.some((r) => r.includes("/api/v1/nodes")));
  assert.equal(host.namespaces.get(vc.name)!["platform.svc/sandbox-node"], undefined);
  assert.deepEqual(helm.values[0].controlPlane.statefulSet.scheduling.nodeSelector, { pool: "sandbox" });
});

test("남은 리허설 청소: 회사를 주면 그 회사 것만 (다른 회사는 지금 도는 중일 수 있다), 안 주면 예전처럼 전부", () => {
  const spaces = [ns("sbx-rehearsal-me", T1, "a"), ns("sbx-rehearsal-old", T1, "a"), ns("sbx-rehearsal-t2", T2, "b"), ns("sbx-rehearsal-t3", T3, null)];
  assert.deepEqual(spaces.filter(leftoverRehearsal("sbx-rehearsal-me", T1)).map((s) => s.name), ["sbx-rehearsal-old"]);
  assert.deepEqual(spaces.filter(leftoverRehearsal("sbx-rehearsal-me")).map((s) => s.name), ["sbx-rehearsal-old", "sbx-rehearsal-t2", "sbx-rehearsal-t3"]);
});

test("설정: SANDBOX_REHEARSAL_CONCURRENCY 기본 1(고정 끔), 2 이상이면 노드 고정, SANDBOX_NODE_PIN=1 이면 1건이어도 고정", () => {
  assert.deepEqual([sandboxSettings({}).concurrency, sandboxSettings({}).pinNodes, sandboxSettings({}).nodeWaitSec], [1, false, 300]);
  assert.deepEqual([sandboxSettings({ SANDBOX_REHEARSAL_CONCURRENCY: "3" }).concurrency, sandboxSettings({ SANDBOX_REHEARSAL_CONCURRENCY: "3" }).pinNodes], [3, true]);
  assert.equal(sandboxSettings({ SANDBOX_NODE_PIN: "1" }).pinNodes, true);
  assert.equal(sandboxSettings({ SANDBOX_REHEARSAL_CONCURRENCY: "0" }).concurrency, 1, "1 아래는 1");
});
