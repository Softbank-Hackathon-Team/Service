// PF FM-ORC-26: 시작할 때 안 넣은 마이그레이션이 있으면 멈춘다 (워커·API main 이 assertMigrations 를 부름)
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readdirSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DB = process.env.DATABASE_URL;
const skip = !DB ? "DB 없음" : false;
const core = await import("@svc/core");
after(async () => { await core.pool.end(); });
const REPO_MIG = new URL("../../../db/migrations/", import.meta.url).pathname;

test("PF FM-ORC-26 정상: 레포의 모든 마이그레이션이 들어간 DB 는 통과 (앱 계정이 migrate.applied 를 읽음)", { skip }, async () => {
  const r = await core.checkMigrations(core.pool, { env: {} });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(!("skipped" in r), JSON.stringify(r));
});

test("PF FM-ORC-26 거부: 안 넣은 파일이 있으면 그 이름과 함께 끝 코드 2", { skip }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "mig-"));
  for (const f of readdirSync(REPO_MIG)) copyFileSync(join(REPO_MIG, f), join(dir, f));
  writeFileSync(join(dir, "9999_not_applied.sql"), "SELECT 1;");
  let code = -1; const lines: string[] = [];
  const r = await core.assertMigrations("worker", core.pool, { env: {}, dir, exit: (c) => { code = c; }, log: (l) => lines.push(l) });
  assert.equal(code, 2);
  assert.deepEqual(r.ok === false && r.pending, ["9999_not_applied.sql"]);
  assert.match(lines.join("\n"), /db:migrate/);
});

test("PF FM-ORC-26 거부: 기록 표를 못 읽으면(0042 전) 남은 것으로 본다, 끄기 MIGRATION_CHECK=0", async () => {
  const denied = { query: async () => { throw Object.assign(new Error("permission denied for schema migrate"), { code: "42501" }); } };
  const r = await core.checkMigrations(denied, { env: {}, dir: REPO_MIG });
  assert.equal(r.ok, false);
  assert.ok(r.ok === false && r.pending.includes("0042_migrate_status_read.sql"));
  assert.deepEqual(await core.checkMigrations(denied, { env: { MIGRATION_CHECK: "0" } }), { ok: true, skipped: "MIGRATION_CHECK=0" });
});
