// Z31: 워커의 앱 연결 훅 배선 (DB 없이). 쓰기 대상 → 프록시 upstream 이름, 측정값 모양, GitOps 설정 없을 때 건너뜀
import { test } from "node:test";
import assert from "node:assert/strict";
import { appLinkHooks, appLinkMeasurements, recordActiveWriter } from "../src/app-link.js";

const ends = {
  source: { label: "src", provider: "postgres" as const, adminUrl: "postgres://p@localhost:55432/shop", appRole: "app" },
  target: { label: "dst", provider: "postgres" as const, adminUrl: "postgres://p@localhost:55433/shop", appRole: "app" },
};

test("APP_LINK_URLS 가 없으면 훅 없음 (지금까지와 같음)", () => {
  assert.equal(appLinkHooks(ends, {}), null);
});

test("resume(도착 끝점) → upstream target, resume(출발) → source", async () => {
  const sent: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (u: string, init?: RequestInit) => {
    if (String(u).endsWith("/resume")) sent.push(JSON.parse(String(init?.body)).upstream);
    return new Response(JSON.stringify({ active: "source", released: 2, maxWaitMs: 40 }));
  }) as typeof fetch;
  try {
    const h = appLinkHooks(ends, { APP_LINK_URLS: "http://proxy:6480" })!;
    await h.resume(ends.target); await h.resume(ends.source);
    assert.deepEqual(sent, ["target", "source"]);
    const ms = appLinkMeasurements(h.report(), "00000000-0000-4000-8000-000000000000", "target");
    assert.ok(ms.some((m) => m.name === "app_link_released" && m.value === 2));
    assert.ok(ms.some((m) => m.name === "app_link_resume_failed" && m.value === 0));
  } finally { globalThis.fetch = realFetch; }
});

test("GitOps 설정이 없으면 activeWriter 기록은 건너뛴다 (no_gitops)", async () => {
  const saved = { ...process.env };
  delete process.env.GITOPS_REPO_URL; delete process.env.GITOPS_REPO_DIR; process.env.GITOPS_DISABLE = "1";
  try { assert.deepEqual(await recordActiveWriter(null, "target"), { skipped: "no_gitops" }); }
  finally { process.env = saved; }
});
