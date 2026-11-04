// FM-APP-hunt-deploy-db-07·FM-ORC-26: 판 교체 뒤 db:migrate 를 잊어도 막는다 — db-migrate --status 가 남은 파일을 pending 으로 찍고
//   (up-preflight 가 이걸로 FAIL), demo-day up 은 워커를 띄우기 전에 db:migrate 를 돌린다 (dry-run 줄로 확인, 클라우드 호출 없음)
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, copyFileSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = new URL("../../../", import.meta.url).pathname;
const OWNER = process.env.OWNER_DATABASE_URL;
const skip = !OWNER ? "OWNER_DATABASE_URL 없음" : false;
const status = (dir: string) => spawnSync("sh", [join(ROOT, "tools/db-migrate.sh"), "--status"],
  { encoding: "utf8", env: { ...process.env, DB_ADMIN_URL: OWNER, MIGRATIONS_DIR: dir } });

test("정상: 레포 마이그레이션이 다 들어간 DB 는 pending 0줄", { skip }, () => {
  const r = status(join(ROOT, "db/migrations"));
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /^pending/m);
});

test("거부: 안 넣은 파일이 있으면 pending 으로 찍힌다 (up-preflight db-migrate FAIL 의 근거)", { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), "mg-"));
  for (const f of readdirSync(join(ROOT, "db/migrations"))) copyFileSync(join(ROOT, "db/migrations", f), join(dir, f));
  writeFileSync(join(dir, "9999_not_yet.sql"), "SELECT 1;");
  const r = status(dir);
  assert.match(r.stdout, /^pending  9999_not_yet\.sql$/m, r.stdout + r.stderr);
  const up = readFileSync(join(ROOT, "tools/up-preflight.sh"), "utf8");
  assert.match(up, /fail db-migrate/);
});

test("demo-day up 은 워커를 띄우기 전에 db:migrate (dry-run 진행 줄)", () => {
  const dir = mkdtempSync(join(tmpdir(), "dd-"));
  spawnSync("bash", [join(ROOT, "tools/demo-day.sh"), "up", "--dry-run", "--fg"], { encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: dir, DEMO_DAY_LOG_DIR: dir } });
  const p = readFileSync(join(dir, "progress.log"), "utf8");
  const mig = p.indexOf("DRY: db:migrate"), work = p.indexOf("nohup npm run");
  assert.ok(mig >= 0 && work > mig, p.slice(0, 400));
});
