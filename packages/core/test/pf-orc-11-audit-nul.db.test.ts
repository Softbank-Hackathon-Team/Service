// PF FM-ORC-11: 감사 detail·target 에 Postgres 가 못 받는 글자(NUL, 짝 없는 서로게이트)가 있어도 감사가 저장되고 상태 전이가 취소되지 않는다
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;
let core: typeof import("../src/index.js");
let owner: pg.Client;
const T = randomUUID();
before(async () => {
  if (skip) return;
  core = await import("../src/index.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1, 'pf-orc-11')", [T]);
});
after(async () => { if (skip) return; await core.pool.end(); await owner.end(); });

test("PF FM-ORC-11 정상: NUL·짝 없는 서로게이트가 든 오류 원문도 감사에 U+FFFD 로 저장", { skip }, async () => {
  const id = randomUUID();
  await core.withTenant(T, (tx) => core.writeAudit(tx, T, { actor: "worker", action: "x.failed", target: id, result: "error",
    detail: { error: "terraform: bad\u0000byte \ud800 end", ["k\u0000"]: "v", nested: [{ log: "a\u0000b" }] } }));
  const d = (await owner.query("SELECT detail FROM audit_events WHERE target=$1", [id])).rows[0].detail;
  assert.equal(d.error, "terraform: bad�byte � end");
  assert.equal(d.nested[0].log, "a�b");
  assert.ok("k�" in d);
});

test("PF FM-ORC-11 거부(전이 지킴): 실패 전이 감사에 NUL 이 있어도 provisioning → failed 가 확정된다", { skip }, async () => {
  const id = randomUUID(), src = randomUUID(), dst = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES
    ($1,$3,'aws','s','connected'), ($2,$3,'gcp','g','connected')`, [src, dst, T]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status) VALUES ($1,$2,$3,$4,'provisioning')`, [id, T, src, dst]);
  await core.withTenant(T, (tx) => core.advance(tx, { id, tenantId: T }, "provisioning", "failed", { failureCode: "TF_APPLY_FAILED", analyze: false,
    audit: { actor: "worker", action: "apply.failed", target: id, result: "ok", detail: { log: ["Error\u0000: x"] } } }));
  assert.equal((await owner.query("SELECT status FROM migrations WHERE id=$1", [id])).rows[0].status, "failed");
});
