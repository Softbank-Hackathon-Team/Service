// Z52 (모의 심사 Q35): "회사가 1,000개면 회사 벽(RLS)이 느려지나?"를 잰다.
// 같은 회사(P, 이전 20건·감사 200줄)의 API 응답 시간을 "회사 1개뿐일 때"와 "다른 회사 999개 + 큰 회사 1개가 있을 때" 비교한다.
// 큰 회사(B, 이전 5,000건)도 같이 재서 "회사 수"보다 "회사당 줄 수"가 중요한지 본다.
// 시험용 DB에서만: 표에 수만 줄을 넣고 지우지 않는다. LOAD_ALLOW_SEED=1 이 없으면 안 돈다.
// 실행: API를 RATE_LIMIT=0 으로 띄운 뒤  LOAD_ALLOW_SEED=1 npx tsx --env-file=.env tools/load/tenants-rls.ts
//   OTHER_TENANTS=999  PER_TENANT=20  AUDIT_PER_TENANT=100  BIG_TENANT_MIGRATIONS=5000  REQS=300  ROUNDS=3
import pg from "pg";
import { API, summary, r1 } from "./lib.js";

if (process.env.LOAD_ALLOW_SEED !== "1") { console.error("시험용 DB에서만: LOAD_ALLOW_SEED=1"); process.exit(2); }
const OTHERS = Number(process.env.OTHER_TENANTS ?? 999);
const PER = Number(process.env.PER_TENANT ?? 20);
const AUDIT = Number(process.env.AUDIT_PER_TENANT ?? 100);
const BIG = Number(process.env.BIG_TENANT_MIGRATIONS ?? 5000);
const REQS = Number(process.env.REQS ?? 300);
const ROUNDS = Number(process.env.ROUNDS ?? 3);
const owner = new pg.Pool({ connectionString: process.env.OWNER_DATABASE_URL, max: 2 });
const app = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });

/** 회사 n개를 한 번에: 회사 → 환경 2개 → 이전 per건 → 감사 audit줄. 반환: 회사 번호들 */
async function seedTenants(n: number, per: number, audit: number, tag: string): Promise<string[]> {
  const r = await owner.query<{ id: string }>(
    `WITH t AS (INSERT INTO tenants(name) SELECT $1 || g FROM generate_series(1, $2::int) g RETURNING id),
          e AS (INSERT INTO environments(tenant_id, provider, name)
                SELECT t.id, p, 'z52-' || p FROM t CROSS JOIN (VALUES ('aws'),('gcp')) v(p) RETURNING tenant_id, id, provider)
     SELECT id FROM t`, [tag, n]);
  const ids = r.rows.map((x) => x.id);
  await owner.query(
    `INSERT INTO migrations(tenant_id, source_env_id, target_env_id, status, updated_at)
     SELECT s.tenant_id, s.id, d.id, (ARRAY['completed','syncing','rolled_back','awaiting_approval'])[1 + g % 4], now() - (g || ' min')::interval
       FROM environments s JOIN environments d ON d.tenant_id = s.tenant_id AND d.provider = 'gcp'
       CROSS JOIN generate_series(1, $2::int) g
      WHERE s.provider = 'aws' AND s.tenant_id = ANY($1::uuid[])`, [ids, per]);
  if (audit > 0) await owner.query(
    `INSERT INTO audit_events(tenant_id, actor, action, target, result, detail, prev_hash, hash)
     SELECT m.tenant_id, 'user:load', 'migration.transition', 'migration:' || m.id, 'ok', '{}'::jsonb, 'x', 'x'
       FROM (SELECT DISTINCT ON (tenant_id) tenant_id, id FROM migrations WHERE tenant_id = ANY($1::uuid[]) ORDER BY tenant_id) m
       CROSS JOIN generate_series(1, $2::int) g`, [ids, audit]);
  return ids;
}

async function timed(tenant: string, path: string): Promise<number[]> {
  const xs: number[] = [];
  for (let i = 0; i < REQS; i++) {
    const t = performance.now();
    const res = await fetch(`${API}${path}`, { headers: { "x-dev-tenant": tenant } });
    await res.arrayBuffer();
    if (res.status !== 200) throw new Error(`${path} ${res.status}`);
    xs.push(performance.now() - t);
  }
  return xs;
}

async function plan(tenant: string, sql: string, args: unknown[] = []) {
  const c = await app.connect();
  try {
    await c.query("BEGIN");
    await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenant]);
    const r = await c.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`, args);
    await c.query("ROLLBACK");
    const p = r.rows[0]["QUERY PLAN"][0];
    const nodes: string[] = [];
    const walk = (n: any) => { nodes.push(`${n["Node Type"]}${n["Index Name"] ? `(${n["Index Name"]})` : ""}`); (n.Plans ?? []).forEach(walk); };
    walk(p.Plan);
    return { execMs: r1(p["Execution Time"]), nodes: nodes.join(" > ") };
  } finally { c.release(); }
}

async function measure(label: string, P: string, pMig: string, B?: string) {
  const out: Record<string, unknown> = { label };
  const rounds: Record<string, number[]> = { list: [], one: [], timeline: [], bigList: [] };
  for (let r = 0; r < ROUNDS; r++) {
    rounds.list!.push(...await timed(P, "/migrations"));
    rounds.one!.push(...await timed(P, `/migrations/${pMig}`));
    rounds.timeline!.push(...await timed(P, `/migrations/${pMig}/timeline`));
    if (B) rounds.bigList!.push(...await timed(B, "/migrations"));
  }
  for (const [k, v] of Object.entries(rounds)) if (v.length) out[k] = summary(v);
  out.planList = await plan(P, `SELECT id FROM migrations ORDER BY updated_at DESC LIMIT 50`);
  out.planAudit = await plan(P, `SELECT seq FROM audit_events WHERE target = $1 ORDER BY seq`, [`migration:${pMig}`]);
  const counts = (await owner.query(`SELECT (SELECT count(*) FROM tenants) t, (SELECT count(*) FROM migrations) m, (SELECT count(*) FROM audit_events) a`)).rows[0];
  out.rows = counts;
  console.log(JSON.stringify(out));
  return out;
}

const tag = `z52-${Date.now()}-`;
const [P] = await seedTenants(1, PER, AUDIT * 2, `${tag}probe-`);
const pMig = (await owner.query(`SELECT id FROM migrations WHERE tenant_id=$1 LIMIT 1`, [P])).rows[0].id;
await owner.query("ANALYZE");
await measure("before (probe tenant only)", P!, pMig);
const t0 = performance.now();
await seedTenants(OTHERS, PER, AUDIT, `${tag}other-`);
const [B] = await seedTenants(1, BIG, AUDIT, `${tag}big-`);
await owner.query("ANALYZE");
console.log(`seeded ${OTHERS} + 1 big tenant in ${r1(performance.now() - t0)} ms`);
await measure(`after (+${OTHERS} tenants, +1 tenant with ${BIG} migrations)`, P!, pMig, B);
await owner.end(); await app.end();
