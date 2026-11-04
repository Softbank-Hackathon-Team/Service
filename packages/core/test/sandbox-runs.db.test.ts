// sandbox_runs 표 (db 0046): 회사 벽, 같은 회사의 이전만, deploying 차례마다 줄 하나, 상태와 코드·건너뜀 이유가 맞아야 함
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;

let core: typeof import("../src/index.js");
let owner: pg.Client;
const A = randomUUID(), B = randomUUID();
const A_M = randomUUID(), B_M = randomUUID();

before(async () => {
  if (skip) return;
  core = await import("../src/index.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1,'test-sbx-runs-a'), ($2,'test-sbx-runs-b')", [A, B]);
  for (const [t, m] of [[A, A_M], [B, B_M]] as const) {
    const s = randomUUID(), g = randomUUID();
    await owner.query(`SELECT set_config('app.tenant_id', $1, false)`, [t]);
    await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES
      ($1,$3,'aws','s','connected'), ($2,$3,'gcp','g','connected')`, [s, g, t]);
    await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status) VALUES ($1,$2,$3,$4,'deploying')`, [m, t, s, g]);
  }
});
after(async () => {
  if (skip) return;
  await core.pool.end(); await owner.end();
});

type Row = { migration: string; tenant: string; epoch?: number; status?: string; skip?: string | null; code?: string | null };
const insert = (tx: import("../src/index.js").Tx, r: Row) => tx.query(
  `INSERT INTO sandbox_runs (tenant_id, migration_id, epoch, status, skip_reason, failure_code) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
  [r.tenant, r.migration, r.epoch ?? 1, r.status ?? "queued", r.skip ?? null, r.code ?? null]);

test("정상: 회사 A 는 자기 이전의 줄을 만들고 읽고 고친다 (queued → running → passed)", { skip }, async () => {
  const id = await core.withTenant(A, async (tx) => (await insert(tx, { migration: A_M, tenant: A, epoch: 10 })).rows[0].id as string);
  const r = await core.withTenant(A, async (tx) => {
    await tx.query("UPDATE sandbox_runs SET status='running', started_at=now() WHERE id=$1 AND status='queued'", [id]);
    await tx.query("UPDATE sandbox_runs SET status='passed', finished_at=now() WHERE id=$1 AND status='running'", [id]);
    return (await tx.query("SELECT status FROM sandbox_runs WHERE id=$1", [id])).rows[0];
  });
  assert.equal(r.status, "passed");
});

test("회사 벽: A 에서 B 의 줄은 안 보이고, B 회사 번호로 만들면 RLS 위반, 남의 이전을 가리키면 외래 키 위반", { skip }, async () => {
  await core.withTenant(B, (tx) => insert(tx, { migration: B_M, tenant: B, epoch: 20 }));
  const seen = await core.withTenant(A, async (tx) => (await tx.query("SELECT count(*)::int n FROM sandbox_runs WHERE tenant_id=$1", [B])).rows[0].n);
  assert.equal(seen, 0);
  await assert.rejects(core.withTenant(A, (tx) => insert(tx, { migration: B_M, tenant: B, epoch: 21 })), { code: "42501" });
  await assert.rejects(core.withTenant(A, (tx) => insert(tx, { migration: B_M, tenant: A, epoch: 22 })), { code: "23503" });
});

test("차례마다 줄 하나: 같은 이전·같은 epoch 두 번째 줄은 거부, 재개(새 epoch)는 새 줄", { skip }, async () => {
  await core.withTenant(A, (tx) => insert(tx, { migration: A_M, tenant: A, epoch: 30 }));
  await assert.rejects(core.withTenant(A, (tx) => insert(tx, { migration: A_M, tenant: A, epoch: 30, status: "skipped", skip: "disabled" })), { code: "23505" });
  await core.withTenant(A, (tx) => insert(tx, { migration: A_M, tenant: A, epoch: 31, status: "skipped", skip: "disabled" }));
});

test("상태와 칸이 맞아야 함: 건너뜀은 이유 있음, 실패·오류는 REHEARSAL_* 코드 있음, 통과는 코드 없음", { skip }, async () => {
  let epoch = 40;
  const bad = (r: Omit<Row, "migration" | "tenant">) =>
    assert.rejects(core.withTenant(A, (tx) => insert(tx, { migration: A_M, tenant: A, epoch: epoch++, ...r })), { code: "23514" }, JSON.stringify(r));
  await bad({ status: "skipped" });
  await bad({ status: "queued", skip: "mock" });
  await bad({ status: "failed" });
  await bad({ status: "error", code: "ARGO_TIMEOUT" });
  await bad({ status: "passed", code: "REHEARSAL_CRASHLOOP" });
  await bad({ status: "done" });
  await core.withTenant(A, (tx) => insert(tx, { migration: A_M, tenant: A, epoch: epoch++, status: "error", code: "REHEARSAL_TIMEOUT" }));
});

test("앱 계정은 줄을 지울 수 없다 (기록은 남긴다)", { skip }, async () => {
  await assert.rejects(core.withTenant(A, (tx) => tx.query("DELETE FROM sandbox_runs WHERE migration_id=$1", [A_M])), { code: "42501" });
});
