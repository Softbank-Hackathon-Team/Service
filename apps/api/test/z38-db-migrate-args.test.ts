// Z38 REVIEW-6 R6-3: db-migrate.sh --db 는 URL 에 DB 이름 자리가 없으면 멈춘다 (예전엔 조용히 기본 DB 에 넣음). DB 없음
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../../../tools/db-migrate.sh", import.meta.url));
const run = (url: string) => spawnSync("sh", [SCRIPT, "--db", "tpl_x", "--status"],
  { env: { PATH: process.env.PATH, DB_ADMIN_URL: url }, encoding: "utf8", timeout: 15_000 });

test("db-migrate --db: DB 경로 없는 URL·key=value 형식은 거절(종료 2), 경로 있으면 검사 통과", () => {
  for (const u of ["postgres://u:p@h:5432", "postgres://u:p@h:5432?sslmode=require", "host=h dbname=platform"]) {
    const r = run(u);
    assert.equal(r.status, 2, u);
    assert.match(r.stderr, /DB 이름 자리가 없어 tpl_x/, u);
  }
  for (const u of ["postgres://u:p@127.0.0.1:1/platform", "postgresql://u:p@127.0.0.1:1/platform?sslmode=disable", "postgres://u:p@127.0.0.1:1/"]) {
    const r = run(u);   // 검사는 통과하고 그 뒤 psql 접속에서 실패한다 (포트 1)
    assert.doesNotMatch(r.stderr, /DB 이름 자리가 없어/, u);
  }
});
