// PF-E1·E2: 사전 점검 단계가 출발 DB 논리 복제 설정을 자원 만들기 전에 본다. {tf:키}(REPL_FACTS_FILES)도 sync 와 같이 채운다
//   진짜 Postgres(IT_SOURCE_URL, 기본 localhost:55432 wal_level=logical)가 있을 때만 DB 시험, 없으면 건너뜀
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { replSourcePrecheck } from "../src/jobs/precheck.js";
import { resolveTfRefs } from "@svc/replication";

const URL0 = process.env.IT_SOURCE_URL ?? "postgres://postgres:postgres@localhost:55432/app";
async function up(): Promise<boolean> {
  const c = new pg.Client({ connectionString: URL0, connectionTimeoutMillis: 1500 });
  try { await c.connect(); await c.query("SELECT 1"); return true; } catch { return false; } finally { await c.end().catch(() => {}); }
}

test("PF-E1: REPL_SOURCE_URL 이 없으면 아무 줄도 안 냄 (STUB 길 그대로)", async () => {
  assert.deepEqual(await replSourcePrecheck({}), []);
});

test("PF-E1 거부: 못 붙는 출발이면 block 이 아니라 warn PC-REPL-CONN (TCP 점검이 이유를 따로 냄)", async () => {
  const r = await replSourcePrecheck({ REPL_SOURCE_URL: "postgres://u:p@127.0.0.1:1/x" });
  assert.equal(r.length, 1);
  assert.equal(r[0]!.id, "PC-REPL-CONN"); assert.equal(r[0]!.level, "warn");
  assert.ok(!r[0]!.message.includes("u:p"), "주소의 비밀번호를 안 남김");
});

test("PF-E2: {tf:키} 를 REPL_FACTS_FILES 로 채운 주소로 붙음 → 기본키 없는 표는 block PC-REPL-DB-T2, 고른 표면 줄 없음", async (t) => {
  if (!(await up())) return t.skip("출발 DB 없음");
  const u = new URL(URL0);
  const dir = mkdtempSync(join(tmpdir(), "pfe2-"));
  const f = join(dir, "facts.json");
  writeFileSync(f, JSON.stringify({ src_user: decodeURIComponent(u.username), src_pw: decodeURIComponent(u.password), src_host: u.hostname }), { mode: 0o600 });
  const env0 = { REPL_SOURCE_URL: `postgres://{tf:src_user}:{tf:src_pw}@{tf:src_host}:${u.port}${u.pathname}`, REPL_FACTS_FILES: f };
  const env = resolveTfRefs(env0, "00000000-0000-4000-8000-000000000000");
  const c = new pg.Client({ connectionString: URL0 }); await c.connect();
  try {
    await c.query("CREATE TABLE IF NOT EXISTS pfe2_nopk (x int)");
    const all = await replSourcePrecheck(env);
    assert.ok(all.some((i) => i.id === "PC-REPL-DB-T2" && i.level === "block" && /pfe2_nopk/.test(i.message)), JSON.stringify(all));
    const tables = (await c.query("SELECT relname FROM pg_class c JOIN pg_index i ON i.indrelid=c.oid AND i.indisprimary JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' LIMIT 1")).rows.map((r) => r.relname as string);
    if (tables.length) {
      const picked = await replSourcePrecheck({ ...env, REPL_TABLES: tables.join(",") });
      assert.ok(!picked.some((i) => i.level === "block"), JSON.stringify(picked));
    }
  } finally { await c.query("DROP TABLE IF EXISTS pfe2_nopk"); await c.end(); }
});
