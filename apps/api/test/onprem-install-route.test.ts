// 온프레 설치 한 줄: 스크립트·묶음 파일은 로그인 없이 받고, 스크립트에 박힌 sha256 이 실제 파일과 맞는다
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { authPlugin } from "../src/plugins/auth.js";
import { onpremInstallRoutes, loadBundle, bundleRoot, renderBootstrap } from "../src/routes/onprem-install.js";
import { enrollCommand } from "../src/routes/agent-enroll.js";

const IMG = `ghcr.io/softbank-hackathon-team/svc-onprem-agent@sha256:${"a".repeat(64)}`;

async function app(env: Record<string, string | undefined>) {
  const saved = { ...process.env };
  Object.assign(process.env, env);
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k];
  const a = Fastify();
  await a.register(authPlugin);
  await a.register(onpremInstallRoutes, { prefix: "/api/v1" });
  await a.ready();
  return { a, restore: () => { process.env = saved; } };
}

test("공개 Agent 이미지가 없으면 503 + '준비 안 됨' 스크립트 (로그인 없이)", async () => {
  const { a, restore } = await app({ ONPREM_AGENT_IMAGE: undefined, DEV_AUTH: undefined });
  try {
    const r = await a.inject({ method: "GET", url: "/api/v1/install/onprem.sh" });
    assert.equal(r.statusCode, 503);
    assert.match(r.body, /^#!\/usr\/bin\/env bash\n/);
    assert.match(r.body, /exit 1/);
  } finally { restore(); await a.close(); }
});

test("스크립트: 로그인 없이 받고, 자리표시가 다 채워지고, bash 문법이 맞고, 박힌 sha256 = 파일 내려받기 내용", async () => {
  const { a, restore } = await app({ ONPREM_AGENT_IMAGE: IMG, PUBLIC_API_URL: "https://console.example.test" });
  const dir = mkdtempSync(join(tmpdir(), "onprem-install-"));
  try {
    const r = await a.inject({ method: "GET", url: "/api/v1/install/onprem.sh" });
    assert.equal(r.statusCode, 200);
    assert.equal(r.headers["cache-control"], "no-store");
    assert.doesNotMatch(r.body, /__SVC_[A-Z_]+__/);
    assert.match(r.body, /^API="https:\/\/console\.example\.test"$/m);
    assert.ok(r.body.includes(`AGENT_IMAGE="${IMG}"`));
    writeFileSync(join(dir, "s.sh"), r.body);
    execFileSync("bash", ["-n", join(dir, "s.sh")]);
    const manifest = /^MANIFEST='([^']*)'$/m.exec(r.body)![1]!.split("\n").map((l) => l.split("  ") as [string, string]);
    assert.ok(manifest.some(([, p]) => p === "tools/onprem-install.sh"));
    assert.ok(manifest.some(([, p]) => p === "tools/cnpg-1.30.1.yaml"));
    assert.ok(manifest.some(([, p]) => p === "tools/external-secrets-2.14.0.tgz"));
    assert.ok(manifest.some(([, p]) => p === "deploy/helm/onprem-agent/Chart.yaml"));
    for (const [sum, p] of manifest) {
      const f = await a.inject({ method: "GET", url: `/api/v1/install/onprem/${p}` });
      assert.equal(f.statusCode, 200, p);
      assert.equal(createHash("sha256").update(f.rawPayload).digest("hex"), sum, p);
    }
  } finally { restore(); await a.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("묶음 밖 파일·경로 탈출은 404, 다른 경로는 여전히 로그인 필요", async () => {
  const { a, restore } = await app({ ONPREM_AGENT_IMAGE: IMG, DEV_AUTH: undefined });
  try {
    for (const u of ["/api/v1/install/onprem/package.json", "/api/v1/install/onprem/../../package.json",
                     "/api/v1/install/onprem/tools/onprem-bootstrap.sh", "/api/v1/install/onprem/.env"])
      assert.equal((await a.inject({ method: "GET", url: u })).statusCode === 200, false, u);
    assert.equal((await a.inject({ method: "GET", url: "/api/v1/environments" })).statusCode, 401);
  } finally { restore(); await a.close(); }
});

test("채우는 값 모양 검사 (스크립트 따옴표를 깨는 값 거부)", () => {
  const b = loadBundle(bundleRoot());
  assert.throws(() => renderBootstrap(b, "https://x\"; rm -rf /", IMG));
  assert.throws(() => renderBootstrap(b, "https://x.test", "ghcr.io/x/y:latest"));
});

test("콘솔 명령: 공개 이미지가 있으면 설치 한 줄, 없으면 예전 레포 명령", () => {
  assert.equal(enrollCommand("et_x", "https://c.test", { ONPREM_AGENT_IMAGE: IMG }),
    "curl -fsSL https://c.test/api/v1/install/onprem.sh | SVC_ENROLL_TOKEN=et_x bash");
  assert.match(enrollCommand("et_x", "https://c.test", {}), /^SVC_ENROLL_TOKEN=et_x .*--enroll$/);
});
