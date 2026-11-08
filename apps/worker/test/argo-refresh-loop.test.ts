import { test } from "node:test";
import assert from "node:assert/strict";
import { argoWatcherFromEnv, type ArgoAppStatus, type KubectlRun } from "../src/gitops/argo-watch.js";

// #380 E2·E3: Argo 반영을 기다리는 동안 15초(ARGO_REFRESH_SEC)마다 normal 새로고침을 도착 앱과 회사 fence 앱에 건다.
//   진짜 Argo 없이 kubectl·fetch 응답 모양 + 가짜 시계로 본다 (sleep 이 시간을 민다)
const C = "c".repeat(40);
const b = { tenant: "t-1a2b3c4d", app: "shop", env: "gcp-gke" as const };
const commit = { commit: C, bundleSha256: "x", resources: [], changed: true };
const clock = () => { let t = 0; return { now: () => t, sleep: async (ms: number) => { t += ms; }, at: () => t }; };
const progressing: ArgoAppStatus = { sync: { status: "OutOfSync", revision: C }, health: { status: "Missing" } };
const healthy: ArgoAppStatus = { sync: { status: "Synced", revision: C }, health: { status: "Healthy" } };
const APP = "t-1a2b3c4d-shop-gcp-gke", FENCE = "t-1a2b3c4d-fence";

/** 20초까지 앱 없음(ApplicationSet 이 아직 안 만듦), 그 뒤 OutOfSync, 50초부터 Synced+Healthy */
function hub(at: () => number) {
  const calls: Array<{ t: number; args: string[] }> = [];
  const kubectl: KubectlRun = async (args) => {
    calls.push({ t: at(), args });
    const target = args[args.indexOf("applications.argoproj.io") + 1];
    if (target === FENCE) return args.includes("annotate") ? { code: 0, stdout: "", stderr: "" } : { code: 0, stdout: JSON.stringify({ status: healthy }), stderr: "" };
    if (at() < 20_000) return { code: 1, stdout: "", stderr: `Error from server (NotFound): applications.argoproj.io "${target}" not found` };
    if (args.includes("annotate")) return { code: 0, stdout: "", stderr: "" };
    return { code: 0, stdout: JSON.stringify({ status: at() >= 50_000 ? healthy : progressing }), stderr: "" };
  };
  const refreshes = (name: string) => calls.filter((c) => c.args.includes("annotate") && c.args.includes(name))
    .map((c) => `${c.t / 1000}:${c.args.find((a) => a.startsWith("argocd.argoproj.io/refresh="))!.split("=")[1]}`);
  return { kubectl, calls, refreshes };
}

test("E2·E3: fence 앱은 첫 읽기 바로 뒤부터 15초마다, 도착 앱은 보인 뒤 15초마다 normal (hard 는 60초 전에 끝나 안 걸림)", async () => {
  const k = clock(); const h = hub(k.at);
  const r = await argoWatcherFromEnv({ ARGO_KUBE_CONTEXT: "hub" }, { kubectl: h.kubectl, sleep: k.sleep, now: k.now }).wait(b, commit);
  assert.equal(r.ok, true);
  assert.equal(k.at(), 50_000);
  // 도착 앱: 0초 첫 읽기(앱 없음), 20초에 처음 보임 → 22초 normal, 그 뒤 15초 넘은 첫 틱 38초에 normal
  assert.deepEqual(h.refreshes(APP), ["0:normal", "22:normal", "38:normal"]);
  // fence 앱: 앱이 없을 때도 0·16·32·48초 (틱 2초라 15초 넘은 첫 틱)
  assert.deepEqual(h.refreshes(FENCE), ["0:normal", "16:normal", "32:normal", "48:normal"]);
  // 판정은 도착 앱만 센다 (fence 읽기는 polls 에 안 들어감)
  assert.equal(r.observed?.polls, 26);
});

test("E3: 60초가 지나도 안 끝나면 hard 는 예전처럼 한 번, 그 사이 normal 은 15초마다", async () => {
  const k = clock(); const calls: string[] = [];
  const kubectl: KubectlRun = async (args) => {
    if (args.includes("annotate") && args.includes(APP)) calls.push(`${k.at() / 1000}:${args.at(-2)!.split("=")[1]}`);
    if (args.includes("annotate")) return { code: 0, stdout: "", stderr: "" };
    return { code: 0, stdout: JSON.stringify({ status: k.at() >= 100_000 ? healthy : progressing }), stderr: "" };
  };
  const r = await argoWatcherFromEnv({ ARGO_KUBE_CONTEXT: "hub" }, { kubectl, sleep: k.sleep, now: k.now }).wait(b, commit);
  assert.equal(r.ok, true);
  assert.deepEqual(calls, ["0:normal", "16:normal", "32:normal", "48:normal", "60:hard", "76:normal", "92:normal"]);
});

test("ARGO_REFRESH_SEC 로 간격을 바꾸고, 0 이면 예전 방식 (fence 를 안 건드리고 도착 앱은 첫 읽기·처음 보일 때만)", async () => {
  const k = clock(); const h = hub(k.at);
  await argoWatcherFromEnv({ ARGO_KUBE_CONTEXT: "hub", ARGO_REFRESH_SEC: "5" }, { kubectl: h.kubectl, sleep: k.sleep, now: k.now }).wait(b, commit);
  assert.deepEqual(h.refreshes(APP).slice(0, 4), ["0:normal", "22:normal", "28:normal", "34:normal"]);
  assert.deepEqual(h.refreshes(FENCE).slice(0, 3), ["0:normal", "6:normal", "12:normal"]);

  const k2 = clock(); const h2 = hub(k2.at);
  const r = await argoWatcherFromEnv({ ARGO_KUBE_CONTEXT: "hub", ARGO_REFRESH_SEC: "0" }, { kubectl: h2.kubectl, sleep: k2.sleep, now: k2.now }).wait(b, commit);
  assert.equal(r.ok, true);
  assert.deepEqual(h2.refreshes(FENCE), []);
  assert.equal(h2.calls.some((c) => c.args.includes(FENCE)), false);
  assert.deepEqual(h2.refreshes(APP), ["0:normal", "22:normal"]);
});

test("거부: fence 앱을 못 읽어도(REST 403·404) 도착 앱 판정은 그대로 ok, 실패로 세지 않는다", async () => {
  const k = clock(); const seen: string[] = [];
  const fetchImpl = (async (url: string) => {
    seen.push(url);
    if (url.includes(`/applications/${FENCE}`)) return { ok: false, status: 403, json: async () => ({}) };
    const s = k.at() >= 30_000 ? healthy : progressing;
    return { ok: true, status: 200, json: async () => ({ status: s }) };
  }) as unknown as typeof fetch;
  const r = await argoWatcherFromEnv({ ARGOCD_URL: "https://argo.example", ARGOCD_TOKEN: "tok", ARGO_MAX_ERRORS: "2" }, { fetchImpl, sleep: k.sleep, now: k.now }).wait(b, commit);
  assert.equal(r.ok, true, "fence 403 이 ARGO_AUTH_FAILED·ARGO_UNREACHABLE 로 번지지 않음");
  assert.ok(seen.some((u) => u.endsWith(`/applications/${FENCE}?refresh=normal`)));
  assert.equal(seen[0], `https://argo.example/api/v1/applications/${APP}?refresh=normal`, "첫 읽기는 도착 앱");
});
