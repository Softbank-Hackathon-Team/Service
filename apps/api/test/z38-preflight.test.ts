// Z38 REVIEW-8: demo-preflight (z75-22) 비밀값 가리기 · CF_API_TOKEN 별칭 · 풀 health 지역 이름
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { regionHealth, secretsFrom, makeScrub } from "../../../tools/demo-preflight.js";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

test("R8-2: DB URL 비밀번호 조각·OWNER URL·별칭 토큰도 가린다", () => {
  const env = {
    DATABASE_URL: "postgres://app_user:Pw%2Fsecret9@db:5432/platform",
    OWNER_DATABASE_URL: "postgres://platform_owner:OwnerPw77@db:5432/platform",
    CF_API_TOKEN: "cf-alias-token-123",
  };
  const scrub = makeScrub(secretsFrom(env));
  const msg = "auth failed Pw/secret9 / OwnerPw77 / cf-alias-token-123 / postgres://app_user:Pw%2Fsecret9@db:5432/platform";
  const out = scrub(msg);
  for (const s of ["Pw/secret9", "Pw%2Fsecret9", "OwnerPw77", "cf-alias-token-123", "app_user:"]) assert.ok(!out.includes(s), `${s} 남음: ${out}`);
  assert.equal(makeScrub(secretsFrom({ DATABASE_URL: "not a url" }))("not a url"), "***");
});

test("R8-3: 풀 health 두 모양 모두 지역 이름과 함께 읽는다", () => {
  assert.deepEqual(regionHealth({ healthy: false, origins: [] }), [{ region: "(전체)", healthy: false }]);
  assert.deepEqual(regionHealth({ "Northeast Asia": { healthy: true }, "Western Europe": { healthy: false }, junk: 1 }),
    [{ region: "Northeast Asia", healthy: true }, { region: "Western Europe", healthy: false }]);
  assert.deepEqual(regionHealth(undefined), []);
});

test("R8-1: CF_API_TOKEN 만 있어도 Cloudflare 풀 health 를 보고, 비밀값은 출력에 없다", async (t) => {
  const port = 18000 + Math.floor(Math.random() * 2000);
  const fake = spawn(process.execPath, ["scripts/cf-fake-server.mjs"], { cwd: ROOT, env: { ...process.env, PORT: String(port) } });
  t.after(() => fake.kill("SIGTERM"));
  await new Promise<void>((res) => fake.stdout.once("data", () => res()));
  const base = `http://127.0.0.1:${port}/client/v4`;
  const mk = async (body: object) => {
    const r = await fetch(`${base}/accounts/fedcba9876543210fedcba9876543210/load_balancers/pools`, {
      method: "POST", headers: { authorization: "Bearer fake-token", "content-type": "application/json" }, body: JSON.stringify(body) });
    return ((await r.json()) as { result: { id: string } }).result.id;
  };
  const src = await mk({ name: "src-pool", enabled: true });
  const dst = await mk({ name: "dst-pool", enabled: true, healthy: false });
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, HOME: process.env.HOME,
    CF_API_TOKEN: "fake-token", CLOUDFLARE_ZONE_NAME: "example.test", CF_CHECK_API_BASE: base,
    CLOUDFLARE_SOURCE_POOL_ID: src, CLOUDFLARE_TARGET_POOL_ID: dst,
    DATABASE_URL: "postgres://u:VerySecretPw1@127.0.0.1:1/x",
    PREFLIGHT_API_URL: "http://127.0.0.1:1", PREFLIGHT_WORKER_URL: "http://127.0.0.1:1/metrics",
    PREFLIGHT_TIMEOUT_MS: "3000", AGENT_LLM_PROVIDER: "mock",
  };
  const out = await new Promise<string>((res) => execFile(process.execPath, ["--import", "tsx", "tools/demo-preflight.ts"], { cwd: ROOT, env, timeout: 30_000 },
    (_e, so, se) => res(String(so) + String(se))));
  const line = out.split("\n").find((l) => l.includes("Cloudflare LB 풀 health")) ?? "";
  assert.match(line, /^FAIL/, out);
  assert.match(line, /출발 src-pool 지역 1\/1 healthy/);
  assert.match(line, /도착 dst-pool 지역 0\/1 healthy \(아님: [^)]+\)/);
  for (const s of ["fake-token", "VerySecretPw1", "fedcba9876543210fedcba9876543210"]) assert.ok(!out.includes(s), `${s} 출력됨`);
});
