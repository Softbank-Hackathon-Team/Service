// #373 D3 DB 시험: 같은 커밋 보고가 없을 때 볼 후보 (리비전마다 가장 최근 보고 · 같은 커밋 제외 · applied|failed 만 · 같은 회사만). DB 없으면 건너뛴다
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import pg from "pg";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;

let core: typeof import("@svc/core");
let aw: typeof import("../src/gitops/agent-watch.js");
let owner: pg.Client;
const T = randomUUID(), T2 = randomUUID();
const C = "c".repeat(40), D = "d".repeat(40), E = "e".repeat(40), F = "f".repeat(40);

before(async () => {
  if (skip) return;
  core = await import("@svc/core");
  aw = await import("../src/gitops/agent-watch.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  await owner.query("INSERT INTO tenants (id, name) VALUES ($1,'agent-desc'), ($2,'agent-desc-other')", [T, T2]);
});
after(async () => { if (skip) return; await core.pool.end(); await owner.end(); });

async function env(tenant = T) {
  const id = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name) VALUES ($1,$2,'onprem',$3)`, [id, tenant, `o-${id.slice(0, 6)}`]);
  const k = `ak_${randomBytes(12).toString("hex")}`;
  await owner.query(`INSERT INTO agent_keys (id, tenant_id, env_id) VALUES ($1,$2,$3)`, [k, tenant, id]);
  return { id, k, tenant };
}
async function deploy(e: { id: string; k: string; tenant: string }, app: string, rev: string, status: string, agoSec: number) {
  await owner.query(`INSERT INTO agent_reports (tenant_id, env_id, key_id, kind, signature, sent_at, received_at, body)
    VALUES ($1,$2,$3,'deploy',$4, now() - make_interval(secs => $5), now() - make_interval(secs => $5), $6)`,
    [e.tenant, e.id, e.k, randomBytes(16).toString("hex"), agoSec, JSON.stringify({ kind: "deploy", app, bundleHash: rev, status })]);
}

test("후보 = 다른 리비전마다 가장 최근 보고, 최근 순, 같은 커밋·applied|failed 아닌 것·다른 앱 제외", { skip }, async () => {
  const e = await env();
  await deploy(e, "app", C, "applied", 10);     // 같은 커밋 → 후보 아님 (정확히 같은 보고 찾기 몫)
  await deploy(e, "app", D, "failed", 300);
  await deploy(e, "app", D, "applied", 60);     // D 의 가장 최근 = applied
  await deploy(e, "app", E, "applied", 200);
  await deploy(e, "app", E, "syncing", 30);     // E 의 가장 최근이 applied|failed 아님 → 빠짐
  await deploy(e, "other", F, "applied", 5);    // 다른 앱
  const rows = await aw.dbAgentDeployCandidates(T, e.id)("app", C);
  assert.deepEqual(rows.map((r) => [r.rev, r.status]), [[D, "applied"]]);
  assert.deepEqual((await aw.dbAgentDeployLookup(T, e.id)("app", C))?.status, "applied", "정확히 같은 보고 찾기는 그대로");
});

test("거부: 다른 회사의 보고는 후보로 안 보인다 (회사 벽)", { skip }, async () => {
  const mine = await env(T), theirs = await env(T2);
  await deploy(theirs, "app", D, "applied", 5);
  assert.deepEqual(await aw.dbAgentDeployCandidates(T, theirs.id)("app", C), []);
  assert.deepEqual(await aw.dbAgentDeployCandidates(T, mine.id)("app", C), []);
});
