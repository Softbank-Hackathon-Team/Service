// 0016: 개발용 onprem 도착 환경 시드가 있고, 파일을 다시 돌려도 안전하다. DB 없으면 건너뛴다
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";

const OWNER = process.env.OWNER_DATABASE_URL;
const skip = !OWNER ? "OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;
const SQL = fileURLToPath(new URL("../../../db/migrations/0016_seed_dev_onprem.sql", import.meta.url));
const ID = "55555555-5555-4555-8555-555555555555";

test("0016 seed_dev_onprem: 5555… onprem/dev-onprem-k3d 한 줄, 재실행해도 한 줄", { skip }, async () => {
  const c = new pg.Client({ connectionString: OWNER });
  await c.connect();
  try {
    const read = async () => {
      await c.query("SELECT set_config('app.tenant_id', '11111111-1111-4111-8111-111111111111', false)");
      const r = await c.query("SELECT tenant_id, provider, name, connection_status FROM environments WHERE id = $1", [ID]);
      await c.query("SELECT set_config('app.tenant_id', '', false)");
      return r.rows;
    };
    assert.deepEqual(await read(), [{ tenant_id: "11111111-1111-4111-8111-111111111111", provider: "onprem", name: "dev-onprem-k3d", connection_status: "connected" }]);
    await c.query(readFileSync(SQL, "utf8"));
    assert.equal((await read()).length, 1);
  } finally { await c.end(); }
});
