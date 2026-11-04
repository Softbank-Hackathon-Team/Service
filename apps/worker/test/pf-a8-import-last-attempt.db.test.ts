// PF-A8 (11회차 롤백·실패 복구): pg-boss 마지막 시도에서 실패하면 감사에 센 횟수와 상관없이 failed 로 보낸다.
// 예전: 처리기는 감사의 실패 횟수(recordAttemptFailure)만 셌다. 워커가 시도 도중 죽으면(kill·tsx watch 재시작, FM-ORC-17)
//   그 시도는 안 세지는데 pg-boss 재시도는 하나 줄어서, 마지막 시도가 "아직 3번째"로 보고 다시 던짐 → 재시도 없음 → importing 에 영원히 남음
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;

let core: typeof import("@svc/core");
let imp: typeof import("../src/jobs/import.js");
let step: typeof import("../src/jobs/_step.js");
let owner: pg.Client;
const T = randomUUID();
const bin = mkdtempSync(join(tmpdir(), "pfa8-bin-"));
const saved = { PATH: process.env.PATH, MOCK_SEED: process.env.MOCK_SEED };

before(async () => {
  if (skip) return;
  writeFileSync(join(bin, "kubectl"), `#!/bin/sh\necho "Unable to connect to the server: dial tcp 10.0.0.1:6443: i/o timeout" >&2\nexit 1\n`);
  chmodSync(join(bin, "kubectl"), 0o755);
  process.env.PATH = `${bin}:${saved.PATH}`;
  delete process.env.MOCK_SEED;
  core = await import("@svc/core");
  imp = await import("../src/jobs/import.js");
  step = await import("../src/jobs/_step.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1, 'test-pfa8')", [T]);
});
after(async () => {
  if (skip) return;
  process.env.PATH = saved.PATH;
  if (saved.MOCK_SEED !== undefined) process.env.MOCK_SEED = saved.MOCK_SEED;
  await core.pool.end(); await owner.end(); rmSync(bin, { recursive: true, force: true });
});

async function seed() {
  const id = randomUUID(), src = randomUUID(), dst = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES
    ($1,$3,'onprem','s','connected'), ($2,$3,'gcp','d','connected')`, [src, dst, T]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status) VALUES ($1,$2,$3,$4,'importing')`, [id, T, src, dst]);
  return id;
}
const job = (id: string) => ({ tenantId: T, requestId: `r-pfa8-${id.slice(0, 8)}`, migrationId: id });
const row = async (id: string) => (await owner.query("SELECT status, failure_code FROM migrations WHERE id=$1", [id])).rows[0];
const attempt = (retryCount: number, fn: () => Promise<unknown>) =>
  step.jobAttempt.run({ queue: "import", retryCount, retryLimit: 3 }, fn);

test("PF-A8: 시도 하나가 워커 죽음으로 안 세진 뒤 마지막 pg-boss 시도의 일시 오류 → failed(IMPORT_SOURCE_UNAVAILABLE)", { skip }, async () => {
  const id = await seed();
  // pg-boss 시도 0 = 워커가 죽어 처리기 catch 가 안 돎(기록 없음). 시도 1·2 = 일시 오류로 기록 후 재시도
  for (const rc of [1, 2]) await assert.rejects(attempt(rc, () => imp.handleImport(job(id))));
  assert.equal((await row(id)).status, "importing");
  // 시도 3 = pg-boss 마지막 (retryCount = retryLimit). 감사 횟수로는 3번째지만 다음 재시도가 없다
  await attempt(3, () => imp.handleImport(job(id)));
  assert.deepEqual(await row(id), { status: "failed", failure_code: "IMPORT_SOURCE_UNAVAILABLE" });
});

test("PF-A8 거부 쪽: 마지막 시도가 아니면 그대로 던져 재시도(importing 유지)", { skip }, async () => {
  const id = await seed();
  await assert.rejects(attempt(0, () => imp.handleImport(job(id))));
  assert.equal((await row(id)).status, "importing");
});

// PF-A9 (12회차 관측·증거): 가져오기도 runStep 처럼 상태 이동 로그 한 줄. 예전엔 영구 실패로 failed 가 돼도 워커 로그는 "job finished result:ok" 뿐
async function captureLog(fn: () => Promise<unknown>) {
  const lines: Record<string, unknown>[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  (process.stdout as { write: unknown }).write = (chunk: unknown, ...rest: unknown[]) => {
    for (const l of String(chunk).split("\n")) { try { const j = JSON.parse(l); if (j && typeof j === "object") lines.push(j); } catch { /* 시험 출력 */ } }
    return (orig as (...a: unknown[]) => boolean)(chunk, ...rest);
  };
  try { return { out: await fn(), lines }; } finally { (process.stdout as { write: unknown }).write = orig; }
}

test("PF-A9: 마지막 시도 실패 → transition 로그(importing → failed, failure_code·reason) + 돌려주는 값 advanced", { skip }, async () => {
  const id = await seed();
  const { out, lines } = await captureLog(() => attempt(3, () => imp.handleImport(job(id))));
  assert.equal(out, "advanced");
  const t = lines.find((l) => l.msg === "transition");
  assert.ok(t, "transition 줄 있음");
  assert.equal(t.prev_state, "importing"); assert.equal(t.state, "failed");
  assert.equal(t.failure_code, "IMPORT_SOURCE_UNAVAILABLE");
  assert.match(String(t.reason), /i\/o timeout/);
});

test("PF-A9 거부 쪽: 이미 취소된 이전은 아무것도 안 하고 skipped (transition 로그 없음)", { skip }, async () => {
  const id = await seed();
  await owner.query("UPDATE migrations SET status='cancelled' WHERE id=$1", [id]);
  const { out, lines } = await captureLog(() => imp.handleImport(job(id)));
  assert.equal(out, "skipped");
  assert.equal(lines.filter((l) => l.msg === "transition").length, 0);
});
