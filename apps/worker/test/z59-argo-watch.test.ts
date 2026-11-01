import { test } from "node:test";
import assert from "node:assert/strict";
import { argoWatcherFromEnv, judgeArgo } from "../src/gitops/argo-watch.js";

// Z59: Argo Degraded → paused 길을 코드로 재현 (진짜 Argo 없이 API 응답 모양만)
const C = "a".repeat(40);
const b = { tenant: "t-1a2b3c4d", app: "guestbook", env: "aws-eks" as const };
const commit = { commit: C, bundleSha256: "x", resources: [], changed: true };

test("judgeArgo: 내 커밋 Synced+Healthy 만 ok, Degraded·SyncFailed 는 끝(실패), 남의 커밋은 계속", () => {
  assert.deepEqual(judgeArgo({ sync: { status: "Synced", revision: C }, health: { status: "Healthy" } }, C), { done: true, ok: true });
  assert.equal(judgeArgo({ sync: { status: "Synced", revision: C }, health: { status: "Degraded", message: "x" } }, C).reason, "ARGO_DEGRADED: x");
  assert.match(judgeArgo({ operationState: { phase: "Failed", message: "namespaces \"t-1a2b3c4d-guestbook\" not found", syncResult: { revision: C } } }, C).reason!, /^ARGO_SYNC_FAILED/);
  assert.equal(judgeArgo({ sync: { status: "Synced", revision: "b".repeat(40) }, health: { status: "Healthy" } }, C).done, false);
  assert.equal(judgeArgo({ sync: { status: "OutOfSync", revision: C }, health: { status: "Progressing" } }, C).done, false);
});

// Z94: 설정 없으면 조용히 ok 하던 STUB 을 없앴다 → ARGO_NOT_CONFIGURED. 흉내는 MOCK_ARGO=1 만
test("설정 없으면 ARGO_NOT_CONFIGURED, MOCK_ARGO=1 이면 ok", async () => {
  assert.match((await argoWatcherFromEnv({}).wait(b, commit)).reason!, /^ARGO_NOT_CONFIGURED/);
  assert.equal((await argoWatcherFromEnv({ MOCK_ARGO: "1" }).wait(b, commit)).ok, true);
});

test("Progressing → Degraded 를 받으면 ok:false + ARGO_DEGRADED, 404 는 계속 기다린다", async () => {
  const seq = [
    { status: 404 },
    { status: 200, body: { status: { sync: { status: "Synced", revision: C }, health: { status: "Progressing" } } } },
    { status: 200, body: { status: { sync: { status: "Synced", revision: C }, health: { status: "Degraded", message: "Deployment exceeded its progress deadline" } } } },
  ];
  let i = 0; const seen: string[] = [];
  const fake = (async (url: string, init: { headers: Record<string, string> }) => {
    seen.push(url); assert.equal(init.headers.Authorization, "Bearer tok");
    const r = seq[Math.min(i++, seq.length - 1)]!;
    return { ok: r.status === 200, status: r.status, json: async () => r.body };
  }) as unknown as typeof fetch;
  const w = argoWatcherFromEnv({ ARGOCD_SERVER: "https://argo.example/", ARGOCD_AUTH_TOKEN: "tok", ARGO_TICK_MS: "1", ARGO_WAIT_SEC: "5" }, fake);
  const r = await w.wait(b, commit);
  assert.equal(r.ok, false);
  assert.match(r.reason!, /^ARGO_DEGRADED: Deployment exceeded/);
  assert.equal(seen[0], "https://argo.example/api/v1/applications/t-1a2b3c4d-guestbook-aws-eks?refresh=normal");
});

test("시간 안에 안 끝나면 ARGO_TIMEOUT, 온프레·Mock 은 기다리지 않는다", async () => {
  const fake = (async () => ({ ok: false, status: 404, json: async () => ({}) })) as unknown as typeof fetch;
  const w = argoWatcherFromEnv({ ARGOCD_SERVER: "https://a", ARGOCD_AUTH_TOKEN: "t", ARGO_TICK_MS: "1", ARGO_WAIT_SEC: "0.05" }, fake);
  assert.match((await w.wait(b, commit)).reason!, /^ARGO_APP_MISSING/);   // Z94: 끝까지 404 면 TIMEOUT 대신 APP_MISSING
  assert.deepEqual(await w.wait({ ...b, env: "azure-mock" }, commit), { ok: true });
  assert.deepEqual(await w.wait({ ...b, env: "onprem-k3s" }, commit), { ok: true });
});
