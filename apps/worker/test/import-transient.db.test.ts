// L5fix DB 시험: 가져오기 중 kubectl 일시 오류는 재시도, 거부는 바로 영구 실패. kubectl 은 PATH 앞 가짜 스크립트 (온프레 출발, MOCK_SEED 끔)
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
let owner: pg.Client;
const T = randomUUID();
const bin = mkdtempSync(join(tmpdir(), "l5fix-bin-"));
const msgFile = join(bin, "msg");
const saved = { PATH: process.env.PATH, MOCK_SEED: process.env.MOCK_SEED, ONPREM_FLOOR_VIA_GIT: process.env.ONPREM_FLOOR_VIA_GIT };

before(async () => {
  if (skip) return;
  writeFileSync(join(bin, "kubectl"), `#!/bin/sh\ncat ${msgFile} >&2\nexit 1\n`);
  chmodSync(join(bin, "kubectl"), 0o755);
  process.env.PATH = `${bin}:${saved.PATH}`;
  delete process.env.MOCK_SEED;
  // kubectl 로 직접 읽는 길(push)을 본다. pull 이면 가져오기는 Agent 인벤토리 스냅숏을 쓴다 (_onprem-snapshot.ts, import-onprem-snapshot 시험)
  process.env.ONPREM_FLOOR_VIA_GIT = "0";
  core = await import("@svc/core");
  imp = await import("../src/jobs/import.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1, 'test-l5fix')", [T]);
});
after(async () => {
  if (skip) return;
  process.env.PATH = saved.PATH;
  if (saved.MOCK_SEED !== undefined) process.env.MOCK_SEED = saved.MOCK_SEED;
  if (saved.ONPREM_FLOOR_VIA_GIT === undefined) delete process.env.ONPREM_FLOOR_VIA_GIT; else process.env.ONPREM_FLOOR_VIA_GIT = saved.ONPREM_FLOOR_VIA_GIT;
  await core.pool.end(); await owner.end(); rmSync(bin, { recursive: true, force: true });
});

async function seed() {
  const id = randomUUID(), src = randomUUID(), dst = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES
    ($1,$3,'onprem','s','connected'), ($2,$3,'gcp','d','connected')`, [src, dst, T]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status) VALUES ($1,$2,$3,$4,'importing')`, [id, T, src, dst]);
  return id;
}
const job = (id: string) => ({ tenantId: T, requestId: `r-l5fix-${id.slice(0, 8)}`, migrationId: id });
const row = async (id: string) => (await owner.query("SELECT status, failure_code FROM migrations WHERE id=$1", [id])).rows[0];

test("일시 오류(연결 거부): 3번은 다시 던지고(importing 유지) 4번째에 failed(IMPORT_SOURCE_UNAVAILABLE, permanent=false, attempts=4)", { skip }, async () => {
  writeFileSync(msgFile, "Unable to connect to the server: dial tcp 10.0.0.1:6443: connect: connection refused\n");
  const id = await seed();
  const thrown: boolean[] = [];
  for (let i = 0; i < 4; i++) {
    try { await imp.handleImport(job(id)); thrown.push(false); } catch { thrown.push(true); }
    if (i < 3) assert.equal((await row(id)).status, "importing", `시도 ${i + 1} 뒤`);
  }
  assert.deepEqual(thrown, [true, true, true, false]);
  assert.deepEqual(await row(id), { status: "failed", failure_code: "IMPORT_SOURCE_UNAVAILABLE" });
  const f = (await owner.query("SELECT detail FROM audit_events WHERE target=$1 AND action='migration.failed'", [id])).rows[0];
  assert.equal(f.detail.permanent, false); assert.equal(f.detail.attempts, 4);
});

test("거부(Forbidden): 재시도 없이 바로 failed(IMPORT_SOURCE_UNAVAILABLE, permanent=true, attempts=1)", { skip }, async () => {
  writeFileSync(msgFile, 'Error from server (Forbidden): nodes is forbidden: User "x" cannot list resource "nodes"\n');
  const id = await seed();
  await imp.handleImport(job(id));   // 던지지 않음
  assert.deepEqual(await row(id), { status: "failed", failure_code: "IMPORT_SOURCE_UNAVAILABLE" });
  const f = (await owner.query("SELECT detail FROM audit_events WHERE target=$1 AND action='migration.failed'", [id])).rows[0];
  assert.equal(f.detail.permanent, true); assert.equal(f.detail.attempts, 1);
});

test("거부(인증서 x509): 연결 실패 문구가 섞여도 영구", { skip }, async () => {
  writeFileSync(msgFile, "Unable to connect to the server: x509: certificate signed by unknown authority\n");
  const id = await seed();
  await imp.handleImport(job(id));
  const f = (await owner.query("SELECT detail FROM audit_events WHERE target=$1 AND action='migration.failed'", [id])).rows[0];
  assert.equal(f.detail.permanent, true);
});
