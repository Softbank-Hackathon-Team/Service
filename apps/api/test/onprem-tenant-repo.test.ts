import { test } from "node:test";
import assert from "node:assert/strict";
import { ensureTenantRepo, normalizePublicKey, tenantRepoConfig, tenantRepoFor } from "../src/onprem/tenant-repo.js";

// 회사 전용 gitops 레포 + 읽기 전용 배포 키. GitHub 는 가짜 fetch 로 (부른 순서·본문을 본다)
const KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl";
const cfg = tenantRepoConfig({ GITOPS_TENANT_REPO_URL: "https://github.com/Org-1/gitops-{tenant}.git", GITOPS_TENANT_TOKEN: "tok",
  GITHUB_API_URL: "https://gh.test" } as NodeJS.ProcessEnv)!;

function fakeGh(routes: Record<string, { status: number; body?: unknown }>) {
  const calls: Array<{ method: string; path: string; body?: unknown; auth?: string }> = [];
  const f = (async (url: string, init: RequestInit) => {
    const path = url.replace("https://gh.test", "");
    calls.push({ method: init.method!, path, body: init.body ? JSON.parse(String(init.body)) : undefined,
      auth: (init.headers as Record<string, string>).authorization });
    const r = routes[`${init.method} ${path}`] ?? { status: 599 };
    return new Response(r.body === undefined ? "" : JSON.stringify(r.body), { status: r.status });
  }) as unknown as typeof fetch;
  return { f, calls };
}

test("설정: 둘 다 있어야 켜지고, 주소에 {tenant} 가 없으면 거부", () => {
  assert.equal(tenantRepoConfig({}), null);
  assert.equal(tenantRepoConfig({ GITOPS_TENANT_REPO_URL: "https://github.com/o/gitops-{tenant}.git" } as NodeJS.ProcessEnv), null);
  assert.throws(() => tenantRepoConfig({ GITOPS_TENANT_REPO_URL: "https://github.com/o/gitops.git", GITOPS_TENANT_TOKEN: "t" } as NodeJS.ProcessEnv));
  assert.deepEqual(tenantRepoFor(cfg, "t-0a1b2c3d"),
    { owner: "Org-1", name: "gitops-t-0a1b2c3d", sshUrl: "ssh://git@ssh.github.com:443/Org-1/gitops-t-0a1b2c3d.git" });
  assert.throws(() => tenantRepoFor(cfg, "../x"), { code: "TENANT_REPO_FAILED" });
});

test("공개 키: ed25519 한 줄만 (설명 칸 버림), 그 밖은 거부", () => {
  assert.equal(normalizePublicKey(`${KEY} ops@server`), KEY);
  assert.equal(normalizePublicKey("ssh-rsa AAAAB3Nza"), null);
  assert.equal(normalizePublicKey(`${KEY}\nssh-ed25519 AAAA`), null);
  assert.equal(normalizePublicKey("-----BEGIN OPENSSH PRIVATE KEY-----"), null);
});

test("레포가 없으면 비공개로 만들고(첫 가지 포함) 읽기 전용 배포 키를 건다", async () => {
  const { f, calls } = fakeGh({
    "GET /repos/Org-1/gitops-t-0a1b2c3d": { status: 404 },
    "POST /orgs/Org-1/repos": { status: 201, body: {} },
    "GET /repos/Org-1/gitops-t-0a1b2c3d/keys?per_page=100": { status: 200, body: [] },
    "POST /repos/Org-1/gitops-t-0a1b2c3d/keys": { status: 201, body: {} },
  });
  const r = await ensureTenantRepo(cfg, "t-0a1b2c3d", KEY, "onprem agent ak_1", f);
  assert.equal(r.name, "gitops-t-0a1b2c3d");
  assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), ["GET /repos/Org-1/gitops-t-0a1b2c3d", "POST /orgs/Org-1/repos",
    "GET /repos/Org-1/gitops-t-0a1b2c3d/keys?per_page=100", "POST /repos/Org-1/gitops-t-0a1b2c3d/keys"]);
  assert.deepEqual(calls[1]!.body, { name: "gitops-t-0a1b2c3d", private: true, auto_init: true,
    description: "platform gitops bundles for t-0a1b2c3d (on-prem pull, written by the platform worker only)" });
  assert.deepEqual(calls[3]!.body, { title: "onprem agent ak_1", key: KEY, read_only: true });
  assert.ok(calls.every((c) => c.auth === "Bearer tok"));
});

test("같은 키가 이미 걸려 있으면 다시 걸지 않는다 (설치 다시 돌림)", async () => {
  const { f, calls } = fakeGh({
    "GET /repos/Org-1/gitops-t-0a1b2c3d": { status: 200, body: {} },
    "GET /repos/Org-1/gitops-t-0a1b2c3d/keys?per_page=100": { status: 200, body: [{ key: KEY }] },
  });
  await ensureTenantRepo(cfg, "t-0a1b2c3d", KEY, "x", f);
  assert.equal(calls.length, 2);
});

test("조직이 배포 키를 막으면 TENANT_REPO_DEPLOY_KEY_DENIED (502), 레포 확인 실패는 TENANT_REPO_FAILED", async () => {
  const denied = fakeGh({
    "GET /repos/Org-1/gitops-t-0a1b2c3d": { status: 200, body: {} },
    "GET /repos/Org-1/gitops-t-0a1b2c3d/keys?per_page=100": { status: 200, body: [] },
    "POST /repos/Org-1/gitops-t-0a1b2c3d/keys": { status: 422, body: { message: "Deploy keys are disabled for this repository" } },
  });
  await assert.rejects(ensureTenantRepo(cfg, "t-0a1b2c3d", KEY, "x", denied.f), { status: 502, code: "TENANT_REPO_DEPLOY_KEY_DENIED" });
  const down = fakeGh({ "GET /repos/Org-1/gitops-t-0a1b2c3d": { status: 401 } });
  await assert.rejects(ensureTenantRepo(cfg, "t-0a1b2c3d", KEY, "x", down.f), { status: 502, code: "TENANT_REPO_FAILED" });
});
