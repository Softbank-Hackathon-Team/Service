// DB 시험 격리 준비·정리 (작업 Z76, DRAFT(ai)). 시험 전용. 앱 코드는 이 파일을 쓰지 않는다
//
// 왜: test:db 34개 파일이 DB 하나(platform)를 같이 써서 --test-concurrency=1 로만 돌았다 (87초)
// 어떻게: 마이그레이션을 다 넣은 "틀 DB"(platform_test_tpl)를 한 번 만들고,
//         시험 파일마다 CREATE DATABASE … TEMPLATE 으로 복사본을 받는다 (tools/test/db-isolate.mjs)
//         파일끼리 표·pg-boss 큐·advisory lock 이 안 겹치므로 동시에 돌려도 된다
//
// 사용 (루트 package.json test:db 가 부른다)
//   node --env-file=.env tools/test/db-test-db.mjs setup     남은 복사본 지우기 → 틀 DB 새로 만들기
//   node --env-file=.env tools/test/db-test-db.mjs cleanup   복사본 + 틀 DB 지우기
// 틀 DB 만드는 법
//   psql 이 있으면 빈 DB 에 sh tools/db-migrate.sh --db platform_test_tpl (늘 깨끗)
//   psql 이 없으면 지금 DB(OWNER_DATABASE_URL 의 platform)를 TEMPLATE 으로 복사 (예전 test:db 와 같은 데이터에서 시작)
// 환경 변수
//   TEST_DB_TEMPLATE  틀 DB 이름 (기본 platform_test_tpl)
//   TEST_DB_PREFIX    복사본 이름 앞머리 (기본 platform_t_)
import { execFileSync, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const HERE = dirname(fileURLToPath(import.meta.url));
const OWNER = process.env.OWNER_DATABASE_URL;
if (!OWNER) { console.error("OWNER_DATABASE_URL 이 없다 (.env 확인)"); process.exit(2); }
const TPL = process.env.TEST_DB_TEMPLATE ?? "platform_test_tpl";
const PREFIX = process.env.TEST_DB_PREFIX ?? "platform_t_";
const NAME_OK = /^[a-z][a-z0-9_]{0,62}$/;
if (!NAME_OK.test(TPL) || !NAME_OK.test(PREFIX)) { console.error("DB 이름은 소문자·숫자·_ 만"); process.exit(2); }

const base = new URL(OWNER);
const SOURCE_DB = decodeURIComponent(base.pathname.slice(1)) || "platform";
const withDb = (db, url = OWNER) => { const u = new URL(url); u.pathname = `/${db}`; return u.toString(); };
const ident = (s) => `"${s.replace(/"/g, '""')}"`;

async function admin(fn) {
  // CREATE/DROP DATABASE 는 대상이 아닌 DB 에 붙어서 한다. postgres DB 가 없을 수도 있어 원래 DB 로 붙는다
  const c = new pg.Client({ connectionString: withDb(SOURCE_DB), application_name: "z76-db-test" });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}

async function dropCopies(c, alsoTemplate) {
  const r = await c.query("SELECT datname FROM pg_database WHERE starts_with(datname, $1)", [PREFIX]);
  const names = r.rows.map((x) => x.datname);
  if (alsoTemplate) names.push(TPL);
  // PG13+: WITH (FORCE) 는 남은 연결을 끊고 지운다 (죽은 시험 프로세스가 남긴 연결 대비)
  for (const n of names) await c.query(`DROP DATABASE IF EXISTS ${ident(n)} WITH (FORCE)`);
  return names.length;
}

function hasPsql() {
  return spawnSync("psql", ["--version"], { stdio: "ignore" }).status === 0;
}

async function setup() {
  const t0 = Date.now();
  let how;
  await admin(async (c) => {
    await dropCopies(c, true);
    if (hasPsql()) {
      await c.query(`CREATE DATABASE ${ident(TPL)}`);
      how = "migrate";
    } else {
      await c.query(`CREATE DATABASE ${ident(TPL)} TEMPLATE ${ident(SOURCE_DB)}`);
      how = `copy:${SOURCE_DB}`;
    }
  });
  if (how === "migrate") {
    execFileSync("sh", [join(HERE, "..", "db-migrate.sh"), "--db", TPL],
      { env: { ...process.env, DB_ADMIN_URL: OWNER }, stdio: ["ignore", "ignore", "inherit"] });
  }
  // 실제 환경은 워커가 한 번은 떴으므로 pg-boss 표(pgboss.job 등)와 큐가 있다. 틀 DB 에도 앱의 startBoss 로 똑같이 만든다
  // (예전 공용 DB 에서는 앞 시험이 만들어 둔 것을 뒤 시험이 몰래 기대했다. 예: observability 의 svc_queue_jobs)
  execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
    "const c = await import('@svc/core'); await c.startBoss(); await c.boss.stop({ graceful: false }); process.exit(0)"],
    { env: { ...process.env, DATABASE_URL: withDb(TPL, process.env.DATABASE_URL ?? OWNER) }, stdio: ["ignore", "ignore", "inherit"] });
  console.log(`[db-test] 틀 DB ${TPL} 준비 (${how}, ${Date.now() - t0}ms)`);
}

async function cleanup() {
  const n = await admin((c) => dropCopies(c, true));
  console.log(`[db-test] 시험 DB ${n}개 지움`);
}

const cmd = process.argv[2];
if (cmd === "setup") await setup();
else if (cmd === "cleanup") await cleanup();
else { console.error("사용: db-test-db.mjs setup|cleanup"); process.exit(2); }
