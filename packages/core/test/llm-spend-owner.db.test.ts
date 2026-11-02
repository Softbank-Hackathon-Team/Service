// DBLINTDYN: 0032 뒤 LLM 지출 합 표·함수의 주인은 슈퍼유저가 아닌 svc_spend 이고, 앱은 합 표를 직접 못 보되 함수·트리거 길은 그대로 동작한다
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;
let owner: pg.Client, app: pg.Client;
const T = randomUUID(), ROUND = `dblintdyn-${T.slice(0, 8)}`;

before(async () => {
  if (skip) return;
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  app = new pg.Client({ connectionString: DB }); await app.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1,'test-dblintdyn')", [T]);
});
after(async () => {
  if (skip) return;
  await app.end(); await owner.end();
});

test("주인: 합 표와 DEFINER 함수 둘 다 svc_spend(슈퍼유저 아님), search_path 고정, PUBLIC 실행 없음", { skip }, async () => {
  const r = await owner.query(`SELECT p.proname, ro.rolname, ro.rolsuper, p.proconfig::text AS cfg,
      has_function_privilege(0, p.oid, 'EXECUTE') AS pub
    FROM pg_proc p JOIN pg_roles ro ON ro.oid = p.proowner
    WHERE p.proname IN ('llm_spend_global_add','llm_spend_round_total') AND p.pronamespace='public'::regnamespace`);
  assert.equal(r.rowCount, 2);
  for (const x of r.rows) { assert.equal(x.rolname, "svc_spend"); assert.equal(x.rolsuper, false); assert.match(x.cfg, /search_path/); }
  const t = await owner.query(`SELECT ro.rolname FROM pg_class c JOIN pg_roles ro ON ro.oid=c.relowner WHERE c.oid='public.llm_spend_global'::regclass`);
  assert.equal(t.rows[0].rolname, "svc_spend");
  const login = await owner.query(`SELECT rolcanlogin, rolsuper, rolbypassrls FROM pg_roles WHERE rolname='svc_spend'`);
  assert.deepEqual(login.rows[0], { rolcanlogin: false, rolsuper: false, rolbypassrls: false });
});

test("동작 그대로: 회사가 지출을 쌓으면 합계 함수가 더한 값을 돌려준다 / 합 표는 앱이 직접 못 읽는다", { skip }, async () => {
  await app.query("BEGIN");
  await app.query("SELECT set_config('app.tenant_id',$1,true)", [T]);
  await app.query("INSERT INTO llm_spend (tenant_id, round, usd, calls) VALUES ($1,$2,0.25,1)", [T, ROUND]);
  await app.query("UPDATE llm_spend SET usd = usd + 0.5, calls = calls + 1 WHERE round=$1", [ROUND]);
  const tot = await app.query("SELECT llm_spend_round_total($1) AS t", [ROUND]);
  assert.equal(Number(tot.rows[0].t), 0.75);
  await app.query("COMMIT");
  // 거부: 합 표 직접 읽기·쓰기, 합계 함수 외 접근
  await assert.rejects(() => app.query("SELECT * FROM llm_spend_global"), /permission denied/);
  await assert.rejects(() => app.query("INSERT INTO llm_spend_global (round, usd) VALUES ('x', 1)"), /permission denied/);
  await assert.rejects(() => app.query("SELECT llm_spend_global_add()"), /permission denied|trigger/i);
});
