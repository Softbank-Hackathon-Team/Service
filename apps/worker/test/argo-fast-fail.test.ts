import { test } from "node:test";
import assert from "node:assert/strict";
import { argoStopHint, argoWatcherFromEnv, clusterFailure, judgeArgo, type ArgoAppStatus, type KubectlRun } from "../src/gitops/argo-watch.js";
import type { RevisionCovers } from "../src/gitops/revision-check.js";

// #373 D1·D3: Argo 반영 확인을 진짜 Argo 없이 응답 모양 + 가짜 시계로 본다 (sleep 이 시간을 민다 → 시험이 실제로 안 기다림)
const C = "c".repeat(40);
const D = "d".repeat(40);   // 다른 이전이 뒤이어 올린 커밋 (후손)
const b = { tenant: "t-1a2b3c4d", app: "shop", env: "aws-eks" as const };
const commit = { commit: C, bundleSha256: "x", resources: [], changed: true };
const REST = { ARGOCD_URL: "https://argo.example", ARGOCD_TOKEN: "tok" };
// #380 E2·E3 의 주기 새로고침을 끈 예전 방식 (첫 읽기·처음 보일 때 normal, hard 한 번). 새 방식은 argo-refresh-loop.test.ts
const OLD_REFRESH = { ARGO_REFRESH_SEC: "0" };
const clock = () => { let t = 0; return { now: () => t, sleep: async (ms: number) => { t += ms; }, at: () => t }; };

// 실측 문구 (2026-11-07 온프레→AWS, GKE)
const EKS_LIVE = 'Failed to load live state: failed to get cluster info for "https://ABCDEF.gr7.ap-northeast-2.eks.amazonaws.com": error synchronizing cache state : the server has asked for the client to provide credentials';
const GKE_SYNC = 'Failed to load live state: failed to sync cluster https://34.1.2.3: failed to load initial state of resource BackendConfig.cloud.google.com: backendconfigs.cloud.google.com is forbidden: User "x" cannot list resource "backendconfigs" in API group "cloud.google.com" in the namespace "app-shop3"';
const unreachable = (rev = "main"): ArgoAppStatus => ({ sync: { status: "Unknown", revision: rev }, health: { status: "Healthy" }, conditions: [{ type: "ComparisonError", message: EKS_LIVE }] });
const progressing = (rev = C): ArgoAppStatus => ({ sync: { status: "Synced", revision: rev }, health: { status: "Progressing" } });
const healthy = (rev = C): ArgoAppStatus => ({ sync: { status: "Synced", revision: rev }, health: { status: "Healthy" } });

type R = { status: number; body?: unknown };
/** 시각(ms) → 응답. seen 에 부른 주소를 남긴다 */
function timedFetch(at: () => number, f: (t: number) => R, seen: Array<{ t: number; url: string }> = []) {
  return (async (url: string) => {
    seen.push({ t: at(), url });
    const r = f(at());
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body };
  }) as unknown as typeof fetch;
}
const ok = (s: ArgoAppStatus): R => ({ status: 200, body: { status: s } });

test("clusterFailure: 클러스터 수준 문구만 잡는다 (실측 EKS·GKE), 자원·git 쪽 오류는 안 잡는다", () => {
  assert.match(clusterFailure(unreachable())!, /^ComparisonError: Failed to load live state: failed to get cluster info/);
  assert.match(clusterFailure({ conditions: [{ type: "ComparisonError", message: GKE_SYNC }] })!, /failed to sync cluster/);
  assert.ok(clusterFailure({ conditions: [{ type: "UnknownError", message: 'Failed to load live state: Get "https://10.0.0.1/version": dial tcp 10.0.0.1:443: i/o timeout' }] }));
  assert.ok(clusterFailure({ conditions: [{ type: "ComparisonError", message: "Failed to load live state: Unauthorized" }] }));
  // 거부: 자원 하나의 오류·git(repo-server) 쪽·조건 밖 메시지
  const no: ArgoAppStatus[] = [
    { conditions: [{ type: "ComparisonError", message: "failed to generate manifest for source 1 of 1: rpc error" }] },
    { conditions: [{ type: "ComparisonError", message: "Failed to load target state: failed to generate manifest: dial tcp: lookup github.com: no such host" }] },
    { conditions: [{ type: "SyncError", message: 'Deployment.apps "web" is invalid: spec.template.spec.containers[0].image: Required value' }] },
    { conditions: [{ type: "SharedResourceWarning", message: "Service/web is part of applications argocd/a and argocd/b" }] },
    { conditions: [{ type: "SyncError", message: 'Internal error occurred: failed calling webhook "mcluster.cnpg.io": Post "https://cnpg-webhook-service.cnpg-system.svc:443/mutate-postgresql-cnpg-io-v1-cluster?timeout=10s": dial tcp 10.0.0.5:443: i/o timeout' }] },
    { conditions: [{ type: "ComparisonError", message: "cluster-scoped resource Namespace is not permitted: Unauthorized" }] },
    { health: { status: "Degraded", message: "Unauthorized" }, operationState: { phase: "Running", message: "dial tcp 1.2.3.4:443: i/o timeout" } },
    { resources: [{ kind: "Deployment", name: "web", health: { status: "Degraded", message: "failed to sync cluster" } }] },
    {},
  ];
  for (const s of no) assert.equal(clusterFailure(s), null, JSON.stringify(s));
});

test("judgeArgo: alsoMine 이 받은 후손 리비전은 우리 커밋처럼 판정 (Healthy·Degraded·SyncFailed), 없으면 예전처럼 계속", () => {
  const mine = (r: string) => r === D;
  assert.deepEqual(judgeArgo(healthy(D), C, mine), { done: true, ok: true });
  assert.equal(judgeArgo(healthy(D), C).done, false, "판정기 없음 = 정확히 같은 커밋만");
  assert.equal(judgeArgo(healthy("e".repeat(40)), C, mine).done, false);
  assert.match(judgeArgo({ sync: { status: "Synced", revision: D }, health: { status: "Degraded", message: "x" } }, C, mine).reason!, /^ARGO_DEGRADED: x/);
  assert.match(judgeArgo({ operationState: { phase: "Failed", message: "boom", syncResult: { revision: D } } }, C, mine).reason!, /^ARGO_SYNC_FAILED/);
  assert.equal(judgeArgo({ operationState: { phase: "Failed", message: "boom", syncResult: { revision: D } } }, C).done, false, "남의 리비전 실패는 계속");
});

test("D1(c): 클러스터를 못 읽는 상태가 120초 이어지면 ARGO_CLUSTER_UNREACHABLE (600초를 다 안 기다림)", async () => {
  const k = clock();
  const r = await argoWatcherFromEnv(REST, { fetchImpl: timedFetch(k.at, () => ok(unreachable())), sleep: k.sleep, now: k.now }).wait(b, commit);
  assert.equal(r.ok, false);
  assert.match(r.reason!, /^ARGO_CLUSTER_UNREACHABLE: 120s 동안 Argo 허브가 도착 클러스터를 못 읽음, last ComparisonError: Failed to load live state: failed to get cluster info/);
  assert.equal(k.at(), 120_000, "처음 본 때(0초)부터 120초");
  assert.equal(r.observed?.sync, "Unknown");
});

test("D1(c): 사이에 깨끗한 읽기가 오면 처음부터 다시 센다, ARGO_UNREACHABLE_SEC 로 바꾸고 0 이면 끈다", async () => {
  // 0~98초 못 읽음, 100초 깨끗(Progressing), 102초부터 다시 못 읽음 → 102+120 = 222초에 멈춤
  const k = clock();
  const seq = (t: number) => ok(t === 100_000 ? progressing() : unreachable());
  const r = await argoWatcherFromEnv(REST, { fetchImpl: timedFetch(k.at, seq), sleep: k.sleep, now: k.now }).wait(b, commit);
  assert.match(r.reason!, /^ARGO_CLUSTER_UNREACHABLE: 120s/);
  assert.equal(k.at(), 222_000);

  const k2 = clock();
  const r2 = await argoWatcherFromEnv({ ...REST, ARGO_UNREACHABLE_SEC: "30" }, { fetchImpl: timedFetch(k2.at, () => ok(unreachable())), sleep: k2.sleep, now: k2.now }).wait(b, commit);
  assert.match(r2.reason!, /^ARGO_CLUSTER_UNREACHABLE: 30s/);

  const k3 = clock();
  const r3 = await argoWatcherFromEnv({ ...REST, ARGO_UNREACHABLE_SEC: "0", ARGO_WAIT_SEC: "200" }, { fetchImpl: timedFetch(k3.at, () => ok(unreachable())), sleep: k3.sleep, now: k3.now }).wait(b, commit);
  assert.match(r3.reason!, /^ARGO_TIMEOUT: 200s, last Unknown\/Healthy @main ComparisonError: Failed to load live state/);
});

test("거부 D1(c): 자원 수준 오류가 계속돼도 클러스터 실패로 멈추지 않는다 (예전처럼 ARGO_TIMEOUT)", async () => {
  const k = clock();
  const res: ArgoAppStatus = { sync: { status: "OutOfSync", revision: C }, health: { status: "Progressing" }, conditions: [{ type: "SyncError", message: 'Deployment.apps "web" is invalid' }] };
  const r = await argoWatcherFromEnv({ ...REST, ARGO_WAIT_SEC: "300" }, { fetchImpl: timedFetch(k.at, () => ok(res)), sleep: k.sleep, now: k.now }).wait(b, commit);
  assert.match(r.reason!, /^ARGO_TIMEOUT: 300s/);
});

test("D1(a): REST 는 60초 지나도 안 끝나면 refresh=hard 한 번, ARGO_HARD_REFRESH_SEC=0 이면 안 건다", async () => {
  const run = async (extra: Record<string, string>) => {
    const k = clock(); const seen: Array<{ t: number; url: string }> = [];
    const r = await argoWatcherFromEnv({ ...REST, ...OLD_REFRESH, ...extra }, { fetchImpl: timedFetch(k.at, (t) => ok(t >= 90_000 ? healthy() : progressing()), seen), sleep: k.sleep, now: k.now }).wait(b, commit);
    assert.equal(r.ok, true);
    return seen;
  };
  const seen = await run({});
  assert.match(seen[0]!.url, /\?refresh=normal$/);
  const hard = seen.filter((s) => s.url.endsWith("?refresh=hard"));
  assert.deepEqual(hard.map((s) => s.t), [60_000], "60초에 한 번만");
  assert.equal(seen.filter((s) => s.url.includes("?refresh=")).length, 2, "첫 normal + hard 하나");
  assert.equal((await run({ ARGO_HARD_REFRESH_SEC: "0" })).filter((s) => s.url.endsWith("?refresh=hard")).length, 0);
});

test("D1(a)(b): k8s 길도 hard 주석 한 번, 없던 Application 이 처음 보이면 normal 한 번 더", async () => {
  const k = clock();
  const calls: Array<{ t: number; args: string[] }> = [];
  const kubectl: KubectlRun = async (args) => {
    calls.push({ t: k.at(), args });
    if (args.includes("annotate")) return k.at() < 10_000 ? { code: 1, stdout: "", stderr: "NotFound" } : { code: 0, stdout: "", stderr: "" };
    if (k.at() < 10_000) return { code: 1, stdout: "", stderr: 'Error from server (NotFound): applications.argoproj.io "x" not found' };
    return { code: 0, stdout: JSON.stringify({ status: k.at() >= 90_000 ? healthy() : progressing() }), stderr: "" };
  };
  const r = await argoWatcherFromEnv({ ARGO_KUBE_CONTEXT: "hub", ...OLD_REFRESH }, { kubectl, sleep: k.sleep, now: k.now }).wait(b, commit);
  assert.equal(r.ok, true);
  const ann = calls.filter((c) => c.args.includes("annotate")).map((c) => ({ t: c.t, v: c.args.find((a) => a.startsWith("argocd.argoproj.io/refresh="))! }));
  // 0초 첫 읽기 normal(앱 없음), 10초에 처음 보임 → 12초 normal, 60초 hard
  assert.deepEqual(ann, [
    { t: 0, v: "argocd.argoproj.io/refresh=normal" },
    { t: 12_000, v: "argocd.argoproj.io/refresh=normal" },
    { t: 60_000, v: "argocd.argoproj.io/refresh=hard" },
  ]);
});

test("D1(a)(b): REST 도 404 뒤 처음 보이면 normal 한 번, 앱이 안 보이는 동안은 hard 를 미룬다", async () => {
  const k = clock(); const seen: Array<{ t: number; url: string }> = [];
  // 70초까지 404, 그 뒤 Progressing, 100초부터 Healthy
  const r = await argoWatcherFromEnv({ ...REST, ...OLD_REFRESH }, { fetchImpl: timedFetch(k.at, (t) => (t < 70_000 ? { status: 404 } : ok(t >= 100_000 ? healthy() : progressing())), seen), sleep: k.sleep, now: k.now }).wait(b, commit);
  assert.equal(r.ok, true);
  const refreshes = seen.filter((s) => s.url.includes("?refresh=")).map((s) => `${s.t}:${s.url.split("?refresh=")[1]}`);
  assert.deepEqual(refreshes, ["0:normal", "72000:normal", "74000:hard"]);
});

test("D3: Argo 가 후손 리비전으로 Synced+Healthy 를 보고하면 성공, 판정은 리비전마다 한 번", async () => {
  const asked: string[] = [];
  const covers: RevisionCovers = async (bb, c, rev) => { asked.push(`${bb.app}:${c.slice(0, 4)}..${rev.slice(0, 4)}`); return rev === D; };
  const k = clock();
  const r = await argoWatcherFromEnv(REST, { fetchImpl: timedFetch(k.at, (t) => ok(t >= 6_000 ? healthy(D) : progressing(D))), sleep: k.sleep, now: k.now, covers }).wait(b, commit);
  assert.equal(r.ok, true);
  assert.equal(r.observed?.revision, D);
  assert.deepEqual(asked, ["shop:cccc..dddd"], "같은 (커밋, 리비전) 은 한 번만 git 에 묻는다");
});

test("거부 D3: 판정기가 아니라고 하거나 던지면 예전처럼 정확한 커밋만 기다린다 (ARGO_TIMEOUT)", async () => {
  for (const covers of [async () => false, async () => { throw new Error("git 실패"); }] as RevisionCovers[]) {
    const k = clock();
    const r = await argoWatcherFromEnv({ ...REST, ARGO_WAIT_SEC: "20" }, { fetchImpl: timedFetch(k.at, () => ok(healthy(D))), sleep: k.sleep, now: k.now, covers }).wait(b, commit);
    assert.match(r.reason!, /^ARGO_TIMEOUT: 20s, last Synced\/Healthy @dddddddd/);
  }
});

test("멈춤 도움말: ARGO_CLUSTER_UNREACHABLE 만, 환경별로 고칠 곳을 적는다", () => {
  const aws = argoStopHint("ARGO_CLUSTER_UNREACHABLE", "aws-eks")!;
  assert.ok(aws.missing.some((m) => /^aws: .*접근 항목/.test(m)));
  assert.ok(aws.missing.includes("argocd: tenants/<회사>/argocd/cluster-aws-eks.yaml 의 namespaces"));
  assert.match(aws.hint, /namespaces/);
  assert.ok(argoStopHint("ARGO_CLUSTER_UNREACHABLE", "gcp-gke")!.missing.some((m) => /^gcp: .*RoleBinding/.test(m)));
  assert.equal(argoStopHint("ARGO_TIMEOUT", "aws-eks"), null);
});
