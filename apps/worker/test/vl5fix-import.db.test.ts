// VL5fix DB 시험: 분류 경계가 가져오기 재시도에 그대로 이어지는지. kubectl 은 PATH 앞 가짜 스크립트 (온프레 출발, MOCK_SEED 끔)
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
const bin = mkdtempSync(join(tmpdir(), "vl5fix-bin-"));
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
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1, 'test-vl5fix')", [T]);
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
const job = (id: string) => ({ tenantId: T, requestId: `r-vl5fix-${id.slice(0, 8)}`, migrationId: id });
const row = async (id: string) => (await owner.query("SELECT status, failure_code FROM migrations WHERE id=$1", [id])).rows[0];

const failed = async (id: string) => (await owner.query("SELECT detail FROM audit_events WHERE target=$1 AND action='migration.failed'", [id])).rows[0]?.detail;

test("그 밖(NotFound 등 모르는 문구): 재시도 없이 바로 failed, 기존 동작 그대로 (permanent=true, attempts=1)", { skip }, async () => {
  writeFileSync(msgFile, 'Error from server (NotFound): the server could not find the requested resource\n');
  const id = await seed();
  await imp.handleImport(job(id));   // 던지지 않음 = 재시도 없음
  assert.equal((await row(id)).status, "failed");
  const d = await failed(id);
  assert.equal(d.permanent, true); assert.equal(d.attempts, 1);
});

test("오탐 고침 확인: 리소스 이름에 timeout 이 들어간 NotFound 는 재시도하지 않는다", { skip }, async () => {
  writeFileSync(msgFile, 'Error from server (NotFound): deployments.apps "timeout-svc" not found\n');
  const id = await seed();
  await imp.handleImport(job(id));
  const d = await failed(id);
  assert.equal(d.permanent, true); assert.equal(d.attempts, 1);
});

test("일시 오류 대문자·여러 줄 stderr 도 재시도 → 소진 뒤 permanent=false, 사유 IMPORT_SOURCE_UNAVAILABLE", { skip }, async () => {
  writeFileSync(msgFile, "E1102 12:00:00 reflector.go: warming up\nUNABLE TO CONNECT TO THE SERVER: CONNECTION REFUSED\nerror: exit status 1\n");
  const id = await seed();
  let throws = 0;
  for (let i = 0; i < 4; i++) { try { await imp.handleImport(job(id)); } catch { throws++; } }
  assert.equal(throws, 3);
  assert.deepEqual(await row(id), { status: "failed", failure_code: "IMPORT_SOURCE_UNAVAILABLE" });
  const d = await failed(id);
  assert.equal(d.permanent, false); assert.equal(d.attempts, 4);
});

test("거부가 앞줄, 일시가 뒷줄이어도 거부 우선 = 영구 (재시도 낭비 없음)", { skip }, async () => {
  writeFileSync(msgFile, 'Error from server (Forbidden): nodes is forbidden\nUnable to connect to the server: i/o timeout\n');
  const id = await seed();
  await imp.handleImport(job(id));
  const d = await failed(id);
  assert.equal(d.permanent, true); assert.equal(d.attempts, 1);
});
