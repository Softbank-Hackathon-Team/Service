// 시험 파일 하나 = DB 하나 (작업 Z76, DRAFT(ai)). 시험 전용, node --import 로 먼저 읽힌다
//
// node --test 는 시험 파일마다 자식 프로세스를 띄운다. 이 파일은 그 자식 안에서
//   1) 틀 DB(platform_test_tpl)를 복사해 그 파일 전용 DB 를 만들고
//   2) DATABASE_URL / OWNER_DATABASE_URL 의 DB 이름을 그 DB 로 바꾼다
// 시험 코드는 그대로 process.env 의 URL 을 읽으므로 고칠 것이 없다
// 부모(시험 실행기) 프로세스나 TEST_DB_ISOLATE=1 이 아닐 때는 아무것도 안 한다
import { createHash } from "node:crypto";
import { basename, relative } from "node:path";
import pg from "pg";

const file = process.argv[1] ?? "";
const isTestFile = /\.(it|db\.test)\.[cm]?[jt]s$/.test(file);

if (process.env.TEST_DB_ISOLATE === "1" && isTestFile && process.env.OWNER_DATABASE_URL) {
  const TPL = process.env.TEST_DB_TEMPLATE ?? "platform_test_tpl";
  const PREFIX = process.env.TEST_DB_PREFIX ?? "platform_t_";
  const rel = relative(process.cwd(), file);
  // 이름: 앞머리 + 파일 이름 조각 + 경로 해시 6자리 (같은 이름 파일이 다른 폴더에 있어도 안 겹침), 63자 이내
  const stem = basename(file).replace(/\.(it|db\.test)\.[cm]?[jt]s$/, "").toLowerCase().replace(/[^a-z0-9]+/g, "_");
  const hash = createHash("sha256").update(rel).digest("hex").slice(0, 6);
  const db = `${PREFIX}${stem}`.slice(0, 63 - 7) + `_${hash}`;

  const swap = (url) => { const u = new URL(url); u.pathname = `/${db}`; return u.toString(); };
  const owner = process.env.OWNER_DATABASE_URL;
  const c = new pg.Client({ connectionString: owner, application_name: "z76-db-isolate" });
  await c.connect();
  try {
    await c.query(`DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`);
    // 틀 DB 에 다른 연결이 있으면 복사가 실패한다(55006). 동시에 시작한 파일끼리 잠깐 겹칠 수 있어 몇 번 다시 한다
    for (let i = 0; ; i++) {
      try { await c.query(`CREATE DATABASE "${db}" TEMPLATE "${TPL}"`); break; }
      catch (e) {
        if (e?.code !== "55006" || i >= 50) throw e;
        await new Promise((r) => setTimeout(r, 50 + Math.random() * 100));
      }
    }
  } finally { await c.end(); }

  process.env.OWNER_DATABASE_URL = swap(owner);
  if (process.env.DATABASE_URL) process.env.DATABASE_URL = swap(process.env.DATABASE_URL);
  process.env.TEST_DB_NAME = db;
}
