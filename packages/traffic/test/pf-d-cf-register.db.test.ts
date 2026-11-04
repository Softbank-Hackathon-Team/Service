// pf-d TRF-21: cf-check 가 만든 LB·풀을 --register 로 이전 하나에 등록 → 워커 trafficFor 가 DB 줄을 읽는다 (.env 4줄·워커 재시작 없음)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import pg from "pg";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DB 없음" : false;
let core: typeof import("@svc/core");
let owner: pg.Client;
const T = randomUUID(), U = randomUUID(), M = randomUUID(), N = randomUUID(), DONE = randomUUID();

const ROOT = resolve(import.meta.dirname, "../../..");
const ACC = "fedcba9876543210fedcba9876543210";
let nextPort = 20000 + Math.floor(Math.random() * 20000);

async function fake(env: Record<string, string> = {}): Promise<{ port: number; stop: () => void; get: (p: string) => Promise<any[]>; post: (p: string, b: unknown) => Promise<void> }> {
  const port = nextPort++;
  const ch: ChildProcess = spawn(process.execPath, ["scripts/cf-fake-server.mjs"], { cwd: ROOT, env: { ...process.env, PORT: String(port), ...env }, stdio: ["ignore", "pipe", "inherit"] });
  await new Promise<void>((res, rej) => { ch.stdout!.on("data", (d) => String(d).includes("fake cf up") && res()); ch.on("exit", () => rej(new Error("fake 종료"))); });
  const base = `http://127.0.0.1:${port}/client/v4`;
  const h = { authorization: "Bearer fake-token", "content-type": "application/json" };
  return {
    port, stop: () => ch.kill("SIGKILL"),
    get: async (p) => ((await (await fetch(base + p, { headers: h })).json()) as { result: any[] }).result,
    post: async (p, b) => { await fetch(base + p, { method: "POST", headers: h, body: JSON.stringify(b) }); },
  };
}
// .env 를 안 읽게 직접 node 로 (npm run cf:check 는 --env-file=.env). 실제 값이 섞이지 않게 CF 관련 변수는 비운다
function cfCheck(port: number, args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, ["--import", "tsx", "scripts/cf-check.ts", ...args], {
    cwd: ROOT, encoding: "utf8", timeout: 60_000,
    env: { PATH: process.env.PATH!, HOME: process.env.HOME ?? "/tmp", CLOUDFLARE_API_TOKEN: "fake-token", CLOUDFLARE_ZONE_NAME: "example.test",
      CF_CHECK_API_BASE: `http://127.0.0.1:${port}/client/v4`, ...env },
  });
  return { code: r.status, out: `${r.stdout}\n${r.stderr}` };
}
const ORIG = (s: string, t: string) => ({ CF_CHECK_SOURCE_ORIGIN: s, CF_CHECK_TARGET_ORIGIN: t });
const KEEP = ["--apply", "--keep", "--hold-sec=0", "--repeat=1"];

before(async () => {
  if (skip) return;
  core = await import("@svc/core");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  for (const [t, ms] of [[T, [[M, "provisioning"], [DONE, "completed"]]], [U, [[N, "shifting"]]]] as const) {
    const s = randomUUID(), d = randomUUID();
    await owner.query("INSERT INTO tenants (id, name) VALUES ($1, 'pf-d-cf-register')", [t]);
    await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES ($1,$3,'aws','s','connected'), ($2,$3,'gcp','g','connected')`, [s, d, t]);
    for (const [m, st] of ms) await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status) VALUES ($1,$2,$3,$4,$5)`, [m, t, s, d, st]);
  }
});
after(async () => { if (skip) return; await core.pool.end(); await owner.end(); });

test("TRF-21 정상: --apply --keep 로 만든 LB 를 --register 로 이전에 등록 (Cloudflare 는 안 바꿈), 워커가 읽는 줄이 생김", { skip }, async () => {
  const f = await fake();
  try {
    const a = cfCheck(f.port, KEEP, ORIG("src.example", "tgt.example"));
    assert.equal(a.code, 0, a.out);
    const r = cfCheck(f.port, [`--register=${M}`, `--tenant=${T}`], { DATABASE_URL: DB! });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /등록 → 워커는 다시 띄울 필요 없음/);
    const row = await core.withTenant(T, (tx) => core.trafficTargetFor(tx, M));
    const lbs = await f.get(`/zones/0123456789abcdef0123456789abcdef/load_balancers`);
    const pools = await f.get(`/accounts/fedcba9876543210fedcba9876543210/load_balancers/pools`);
    assert.equal(row?.provider, "cloudflare");
    assert.equal(row?.lbId, lbs[0].id);
    assert.equal(row?.sourcePoolId, pools.find((p) => p.name === "cf-check-src").id);
    assert.equal(row?.targetPoolId, pools.find((p) => p.name === "cf-check-tgt").id);
    assert.equal(row?.zoneId, "0123456789abcdef0123456789abcdef");
  } finally { f.stop(); }
});

test("TRF-21 거부: 남의 회사 이전·끝난 이전에는 등록 안 함, LB 가 없으면 등록 안 함 (rc 1, 줄 없음)", { skip }, async () => {
  const f = await fake();
  try {
    const none = cfCheck(f.port, [`--register=${M}`, `--tenant=${T}`], { DATABASE_URL: DB! });
    assert.equal(none.code, 1, none.out); assert.match(none.out, /등록할 cf-check LB·풀이 없다/);
    assert.equal(cfCheck(f.port, KEEP, ORIG("src.example", "tgt.example")).code, 0);
    const other = cfCheck(f.port, [`--register=${N}`, `--tenant=${T}`], { DATABASE_URL: DB! });
    assert.equal(other.code, 1, other.out); assert.match(other.out, /이 회사에 그 이전이 없다/);
    assert.equal(await core.withTenant(U, (tx) => core.trafficTargetFor(tx, N)), null);
    const done = cfCheck(f.port, [`--register=${DONE}`, `--tenant=${T}`], { DATABASE_URL: DB! });
    assert.equal(done.code, 1, done.out); assert.match(done.out, /끝난 이전 \(completed\)/);
  } finally { f.stop(); }
});
