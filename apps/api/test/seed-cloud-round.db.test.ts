// 0021 (Z77, Z62 주제 66): 실클라우드 회차 전용 회사·환경 셋. 로컬 회사(1111…) 환경과 다르고, 다시 돌려도 안전. DB 없으면 건너뛴다
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";

const OWNER = process.env.OWNER_DATABASE_URL;
const skip = !OWNER ? "OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;
const SQL = fileURLToPath(new URL("../../../db/migrations/0022_seed_cloud_round.sql", import.meta.url));
const T = "66666666-6666-4666-8666-666666666666";

test("0021 seed_cloud_round: 회사 6666… 에 onprem 7777…·gcp 8888…·aws 9999…, 재실행해도 셋", { skip }, async () => {
  const c = new pg.Client({ connectionString: OWNER });
  await c.connect();
  try {
    const read = async () => {
      await c.query("SELECT set_config('app.tenant_id', $1, false)", [T]);
      const r = await c.query("SELECT id, provider FROM environments WHERE tenant_id = $1 ORDER BY id", [T]);
      await c.query("SELECT set_config('app.tenant_id', '', false)");
      return r.rows;
    };
    const want = [
      { id: "77777777-7777-4777-8777-777777777777", provider: "onprem" },
      { id: "88888888-8888-4888-8888-888888888888", provider: "gcp" },
      { id: "99999999-9999-4999-8999-999999999999", provider: "aws" },
    ];
    assert.deepEqual(await read(), want);
    await c.query(readFileSync(SQL, "utf8"));
    assert.deepEqual(await read(), want);
  } finally { await c.end(); }
});
