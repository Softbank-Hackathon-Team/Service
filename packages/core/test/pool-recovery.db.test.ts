// DB 시험(작업 Z12) 시나리오 2-A: DB 연결이 서버 쪽에서 끊길 때 프로세스가 안 죽고 다음 요청이 다시 붙는가
// 끊는 방법: 소유자 계정으로 pg_terminate_backend(그 연결의 pid). 서버 재시작·네트워크 끊김·펜스와 같은 오류(57P01)가 난다.
// 다른 시험 파일의 연결은 건드리지 않게, 이 파일이 빌린 연결의 pid만 골라 끊는다.
// "프로세스가 안 죽는다" = 'error' 이벤트에 처리기가 없으면 node가 uncaught 오류로 시험 프로세스를 죽인다 → 시험이 끝까지 돌면 통과.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;
const T = randomUUID();
let core: typeof import("@svc/core");
let owner: pg.Client;
const errs: string[] = [];
const origErr = console.error;
const origOut = process.stdout.write.bind(process.stdout);

before(async () => {
  if (skip) return;
  core = await import("@svc/core");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1,'test-z12-pool')", [T]);
  // 풀 오류 처리기가 찍는 줄을 모은다 (출력은 그대로). Z81-08: 이제 core 로거가 stdout 에 JSON 한 줄로 찍는다
  console.error = (...a: unknown[]) => { errs.push(a.map(String).join(" ")); origErr(...a); };
  process.stdout.write = ((s: string | Uint8Array, ...rest: unknown[]) => { errs.push(String(s)); return (origOut as (...x: unknown[]) => boolean)(s, ...rest); }) as typeof process.stdout.write;
});
after(async () => {
  if (skip) return;
  console.error = origErr;
  process.stdout.write = origOut;
  await core.pool.end(); await owner.end();
});

const kill = (pid: number) => owner.query("SELECT pg_terminate_backend($1) AS ok", [pid]).then((r) => r.rows[0].ok as boolean);
const pidOf = (tx: pg.PoolClient) => tx.query("SELECT pg_backend_pid() AS p").then((r) => r.rows[0].p as number);
const tick = (ms = 150) => new Promise((r) => setTimeout(r, ms));

test("쉬는 연결이 끊김 → 풀 error 처리기가 받고 프로세스 생존, 다음 withTenant 정상", { skip }, async () => {
  const pid = await core.withTenant(T, pidOf);           // 빌렸다 돌려준 연결 = 쉬는 연결
  const n0 = errs.length;
  assert.equal(await kill(pid), true);
  await tick();
  assert.ok(errs.slice(n0).some((l) => /"component":"pg-pool".*"msg":"idle client error"/.test(l)), `로그: ${errs.slice(n0).join(" | ")}`);
  const pid2 = await core.withTenant(T, pidOf);
  assert.notEqual(pid2, pid, "죽은 연결은 버리고 새 연결");
});

test("빌린 연결이 트랜잭션 도중 끊김 → withTenant가 57P01로 거절, 연결은 버림, 바로 다음 호출 정상", { skip }, async () => {
  let pid = 0;
  const t0 = performance.now();
  await assert.rejects(core.withTenant(T, async (tx) => {
    pid = await pidOf(tx);
    await kill(pid);
    await tx.query("SELECT 1");                          // 여기서 오류
  }), (e: Error & { code?: string }) => { assert.ok(e.code === "57P01" || /terminat|Connection/i.test(e.message), e.message); return true; });
  const pid2 = await core.withTenant(T, pidOf);
  assert.notEqual(pid2, pid);
  console.log(`[z12] mid-tx kill → reject → next ok in ${(performance.now() - t0).toFixed(1)} ms`);
});

test("풀 연결 10개를 한꺼번에 끊음 → 다음 동시 10건 모두 성공", { skip }, async () => {
  // 연결 10개를 동시에 잡아 pid를 모은다
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const pids: number[] = [];
  const holds = Array.from({ length: 10 }, () => core.withTenant(T, async (tx) => { pids.push(await pidOf(tx)); await gate; }));
  await new Promise<void>((r) => { const i = setInterval(() => { if (pids.length === 10) { clearInterval(i); r(); } }, 10); });
  release(); await Promise.all(holds);
  for (const p of pids) await kill(p);
  await tick(300);
  const t0 = performance.now();
  const r = await Promise.allSettled(Array.from({ length: 10 }, () => core.withTenant(T, (tx) => tx.query("SELECT 1 AS x"))));
  const ok = r.filter((x) => x.status === "fulfilled").length;
  console.log(`[z12] 10 idle killed → next 10 parallel: ${ok}/10 ok in ${(performance.now() - t0).toFixed(1)} ms`);
  assert.equal(ok, 10);
});

test("생존 신호용 전용 풀(createDedicatedPool)도 쉬는 연결이 끊겨도 안 죽음", { skip }, async () => {
  const dp = core.createDedicatedPool(1);
  const c = await dp.connect(); const pid = (await c.query("SELECT pg_backend_pid() AS p")).rows[0].p as number; c.release();
  const n0 = errs.length;
  await kill(pid); await tick();
  assert.ok(errs.slice(n0).some((l) => /"component":"pg-dedicated-pool".*"msg":"idle client error"/.test(l)));
  assert.equal((await dp.query("SELECT 1 AS x")).rows[0].x, 1);
  await dp.end();
});

test("pg.Pool을 처리기 없이 만들면 같은 상황에서 프로세스가 죽는다 (대조군: 처리기가 왜 필요한지)", { skip }, async () => {
  // 대조군은 자식 프로세스로 돌린다 (시험 러너가 uncaught 오류를 가로채므로)
  const { spawn } = await import("node:child_process");
  const code = `import pg from "pg"; const p = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    const c = await p.connect(); console.log("PID", (await c.query("SELECT pg_backend_pid() AS p")).rows[0].p); c.release();
    setTimeout(() => { console.log("ALIVE"); process.exit(0); }, 1500);`;
  const ch = spawn(process.execPath, ["--input-type=module", "-e", code], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  let out = ""; ch.stdout.on("data", (b) => { out += b; }); ch.stderr.on("data", (b) => { out += b; });
  const exit = new Promise<number | null>((r) => ch.on("exit", (c) => r(c)));
  while (!/PID (\d+)/.test(out)) await tick(20);
  await kill(Number(/PID (\d+)/.exec(out)![1]));
  const c = await exit;
  assert.notEqual(c, 0, `처리기 없는 풀: exit ${c}, out=${out.slice(0, 200)}`);
  assert.ok(!out.includes("ALIVE"));
});
