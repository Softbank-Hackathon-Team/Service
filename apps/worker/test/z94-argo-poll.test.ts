import { test } from "node:test";
import assert from "node:assert/strict";
import { argoWatcherFromEnv, argoReaderFromEnv, type KubectlRun } from "../src/gitops/argo-watch.js";

// Z94: Argo 반영 확인 실폴링. 진짜 Argo 없이 REST 응답 / kubectl 출력 모양만 흉내 내 판정·재시도·시간을 본다
const C = "c".repeat(40);
const b = { tenant: "t-1a2b3c4d", app: "guestbook", env: "gcp-gke" as const };
const commit = { commit: C, bundleSha256: "x", resources: [], changed: true };
const app = (sync: string, health: string, rev = C) => ({ status: { sync: { status: sync, revision: rev }, health: { status: health } } });
type R = { status: number; body?: unknown } | Error;
function fakeFetch(seq: R[], seen: string[] = []) {
  let i = 0;
  return (async (url: string) => {
    seen.push(url);
    const r = seq[Math.min(i++, seq.length - 1)]!;
    if (r instanceof Error) throw r;
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body };
  }) as unknown as typeof fetch;
}
// 가짜 시계: sleep 이 시간을 앞으로 민다 → 시험이 실제로 기다리지 않는다
function clock() { let t = 0; return { now: () => t, sleep: async (ms: number) => { t += ms; }, slept: () => t }; }
const REST = { ARGOCD_URL: "https://argo.example", ARGOCD_TOKEN: "tok" };

test("REST: OutOfSync → 남의 커밋 → 내 커밋 Synced+Healthy 면 ok, 관찰 기록 남김, refresh 는 첫 번만", async () => {
  const seen: string[] = []; const k = clock();
  const w = argoWatcherFromEnv(REST, { fetchImpl: fakeFetch([
    { status: 200, body: app("OutOfSync", "Healthy", "d".repeat(40)) },
    { status: 200, body: app("Synced", "Progressing") },
    { status: 200, body: app("Synced", "Healthy") },
  ], seen), sleep: k.sleep, now: k.now });
  const r = await w.wait(b, commit);
  assert.equal(r.ok, true);
  assert.equal(r.observed?.source, "rest");
  assert.equal(r.observed?.polls, 3);
  assert.equal(r.observed?.health, "Healthy");
  assert.equal(seen[0], "https://argo.example/api/v1/applications/t-1a2b3c4d-guestbook-gcp-gke?refresh=normal");
  assert.equal(seen[1], "https://argo.example/api/v1/applications/t-1a2b3c4d-guestbook-gcp-gke");
  assert.equal(k.slept(), 4000);   // 틱 2초 × 2
});

test("REST: 401·403 은 기다리지 않고 ARGO_AUTH_FAILED", async () => {
  for (const s of [401, 403]) {
    const r = await argoWatcherFromEnv(REST, { fetchImpl: fakeFetch([{ status: s }]), ...clock() }).wait(b, commit);
    assert.equal(r.ok, false);
    assert.match(r.reason!, new RegExp(`^ARGO_AUTH_FAILED: HTTP ${s}`));
    assert.equal(r.observed?.polls, 1);
  }
});

test("REST: 네트워크·5xx 는 재시도(간격 2배, 최대 10초) 후 회복되면 ok", async () => {
  const k = clock();
  const r = await argoWatcherFromEnv(REST, { fetchImpl: fakeFetch([
    new Error("ECONNREFUSED"), { status: 502 }, { status: 503 }, { status: 200, body: app("Synced", "Healthy") },
  ]), sleep: k.sleep, now: k.now }).wait(b, commit);
  assert.equal(r.ok, true);
  assert.equal(k.slept(), 2000 + 4000 + 8000);
});

test("REST: 연속 오류가 ARGO_MAX_ERRORS 에 닿으면 ARGO_UNREACHABLE", async () => {
  const r = await argoWatcherFromEnv({ ...REST, ARGO_MAX_ERRORS: "3" }, { fetchImpl: fakeFetch([{ status: 500 }]), ...clock() }).wait(b, commit);
  assert.match(r.reason!, /^ARGO_UNREACHABLE: 연속 3회/);
});

test("REST: 상태는 받는데 끝내 Healthy 가 아니면 ARGO_TIMEOUT (마지막 상태 포함)", async () => {
  const k = clock();
  const r = await argoWatcherFromEnv({ ...REST, ARGO_WAIT_SEC: "10" }, { fetchImpl: fakeFetch([{ status: 200, body: app("Synced", "Progressing") }]), sleep: k.sleep, now: k.now }).wait(b, commit);
  assert.match(r.reason!, /^ARGO_TIMEOUT: 10s, last Synced\/Progressing @cccccccc/);
  assert.ok(k.slept() <= 10000);
});

test("데모 모드는 틱 1초, ARGO_TICK_MS 가 있으면 그것", async () => {
  const run = async (env: Record<string, string>) => {
    const k = clock();
    await argoWatcherFromEnv({ ...REST, ...env }, { fetchImpl: fakeFetch([{ status: 200, body: app("Synced", "Progressing") }, { status: 200, body: app("Synced", "Healthy") }]), sleep: k.sleep, now: k.now }).wait(b, commit);
    return k.slept();
  };
  assert.equal(await run({ DEMO_MODE: "1" }), 1000);
  assert.equal(await run({ DEMO_MODE: "1", ARGO_TICK_MS: "300" }), 300);
});

test("구 이름 ARGOCD_SERVER/ARGOCD_AUTH_TOKEN 도 REST 로 받는다", () => {
  assert.equal(argoReaderFromEnv({ ARGOCD_SERVER: "https://a", ARGOCD_AUTH_TOKEN: "t" })?.source, "rest");
  assert.equal(argoReaderFromEnv({}), null);
  assert.equal(argoReaderFromEnv({ ARGO_KUBE_CONTEXT: "hub" })?.source, "k8s");
  assert.equal(argoReaderFromEnv({ ...REST, ARGO_SOURCE: "k8s" })?.source, "k8s");
});

test("k8s CR: kubectl get applications.argoproj.io 로 읽고, NotFound 는 계속·Forbidden 은 바로 실패", async () => {
  const calls: string[][] = [];
  const outs = [
    { code: 1, stdout: "", stderr: 'Error from server (NotFound): applications.argoproj.io "t-1a2b3c4d-guestbook-gcp-gke" not found' },
    { code: 0, stdout: JSON.stringify(app("Synced", "Healthy")), stderr: "" },
  ];
  let i = 0;
  const kubectl: KubectlRun = async (args) => { calls.push(args); if (args.includes("annotate")) return { code: 1, stdout: "", stderr: "NotFound" }; return outs[Math.min(i++, outs.length - 1)]!; };
  const r = await argoWatcherFromEnv({ ARGO_KUBE_CONTEXT: "hub" }, { kubectl, ...clock() }).wait(b, commit);
  assert.equal(r.ok, true);
  assert.equal(r.observed?.source, "k8s");
  // 첫 읽기 전에 refresh 주석 한 번 (Z103), 그 뒤로는 get 만
  assert.deepEqual(calls[0], ["--context", "hub", "annotate", "applications.argoproj.io", "t-1a2b3c4d-guestbook-gcp-gke", "-n", "argocd", "argocd.argoproj.io/refresh=normal", "--overwrite"]);
  assert.deepEqual(calls[1], ["--context", "hub", "get", "applications.argoproj.io", "t-1a2b3c4d-guestbook-gcp-gke", "-n", "argocd", "-o", "json"]);
  assert.equal(calls.filter((c) => c.includes("annotate")).length, 1);

  const deny: KubectlRun = async () => ({ code: 1, stdout: "", stderr: "Error from server (Forbidden): applications.argoproj.io is forbidden" });
  assert.match((await argoWatcherFromEnv({ ARGO_KUBE_CONTEXT: "hub" }, { kubectl: deny, ...clock() }).wait(b, commit)).reason!, /^ARGO_AUTH_FAILED/);
});

test("k8s CR: Degraded 면 ARGO_DEGRADED (deploy 가 paused 로)", async () => {
  const kubectl: KubectlRun = async () => ({ code: 0, stdout: JSON.stringify({ status: { sync: { status: "Synced", revision: C }, health: { status: "Degraded", message: "ImagePullBackOff" } } }), stderr: "" });
  const r = await argoWatcherFromEnv({ ARGO_SOURCE: "k8s" }, { kubectl, ...clock() }).wait(b, commit);
  assert.equal(r.reason, "ARGO_DEGRADED: ImagePullBackOff");
});

test("온프레·Azure Mock 은 설정이 없어도 여기서 기다리지 않는다 (Agent 보고·Mock 실행기 몫)", async () => {
  assert.deepEqual(await argoWatcherFromEnv({}).wait({ ...b, env: "onprem-k3s" }, commit), { ok: true });
  assert.deepEqual(await argoWatcherFromEnv({}).wait({ ...b, env: "azure-mock" }, commit), { ok: true });
});
