// 통합 테스트·측정 공용 도구: 두 DB 초기화, 앱 쓰기 부하, 프로세스 안 트래픽 라우터(PgBouncer 대역)
import pg from "pg";
import type { Endpoint, TrafficHooks } from "../src/index.js";

const env = process.env;
export const SOURCE: Endpoint = {
  label: "src", provider: "postgres", appRole: "app_user",
  adminUrl: env.IT_SOURCE_URL ?? "postgres://postgres:postgres@localhost:55432/app",
  // 도착 DB 컨테이너가 출발에 붙을 때 쓰는 주소 (같은 도커 네트워크 안 서비스 이름)
  peerUrl: env.IT_SOURCE_PEER_URL ?? "postgres://postgres:postgres@src:5432/app",
};
export const TARGET: Endpoint = {
  label: "dst", provider: "postgres", appRole: "app_user",
  adminUrl: env.IT_TARGET_URL ?? "postgres://postgres:postgres@localhost:55433/app",
  peerUrl: env.IT_TARGET_PEER_URL ?? "postgres://postgres:postgres@dst:5432/app",
};
export const TABLES = ["customers", "orders"];

export const appUrl = (e: Endpoint) => { const u = new URL(e.adminUrl); u.username = "app_user"; u.password = "app"; return u.toString(); };

export async function q(e: Endpoint, sql: string, args: unknown[] = []) {
  const c = new pg.Client({ connectionString: e.adminUrl }); await c.connect();
  try { return (await c.query(sql, args)).rows; } finally { await c.end(); }
}

export async function reachable(e: Endpoint) {
  try { await q(e, "SELECT 1"); return true; } catch { return false; }
}

const SCHEMA = `
  DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN CREATE ROLE app_user LOGIN PASSWORD 'app'; END IF; END $$;
  ALTER DATABASE app RESET default_transaction_read_only;
  DROP SCHEMA IF EXISTS _repl CASCADE;
  DROP TABLE IF EXISTS orders, customers, audit_log;
  CREATE TABLE customers (id bigserial PRIMARY KEY, name text NOT NULL, visits int NOT NULL DEFAULT 0);
  CREATE TABLE orders (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, customer_id bigint NOT NULL REFERENCES customers(id),
                       amount int NOT NULL, note text, created_at timestamptz NOT NULL DEFAULT now());
  CREATE TABLE audit_log (at timestamptz DEFAULT now(), msg text);   -- 기본키 없음: 점검이 잡아야 한다
`;

/** 두 DB를 빈 상태로: 남은 구독·슬롯·발행 제거 → 스키마 재생성 → 출발에만 데이터 */
export async function resetAndSeed(rows = 2000) {
  for (const e of [TARGET, SOURCE]) {
    for (const s of await q(e, `SELECT subname FROM pg_subscription WHERE subdbid = (SELECT oid FROM pg_database WHERE datname = current_database())`)) {
      await q(e, `ALTER SUBSCRIPTION "${s.subname}" DISABLE`);
      await q(e, `ALTER SUBSCRIPTION "${s.subname}" SET (slot_name = NONE)`);
      await q(e, `DROP SUBSCRIPTION "${s.subname}"`);
    }
  }
  for (const e of [SOURCE, TARGET]) {
    await q(e, `SELECT pg_drop_replication_slot(slot_name) FROM pg_replication_slots WHERE slot_type='logical' AND database = current_database()`);
    for (const p of await q(e, `SELECT pubname FROM pg_publication`)) await q(e, `DROP PUBLICATION "${p.pubname}"`);
    await q(e, SCHEMA);
  }
  await q(SOURCE, `GRANT USAGE ON SCHEMA public TO app_user;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
    GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO app_user;
    INSERT INTO customers(name) SELECT 'c' || g FROM generate_series(1, 100) g;
    INSERT INTO orders(customer_id, amount, note) SELECT 1 + g % 100, g, 'seed' FROM generate_series(1, ${rows}) g;`);
}

/** PgBouncer PAUSE/RESUME 대역. 요청은 라우터를 거쳐 지금 쓰기 담당에게 간다 */
export class Router implements TrafficHooks {
  writer: Endpoint;
  private gate: Promise<void> | null = null;
  private open: (() => void) | null = null;
  private inflight = 0;
  private drained: (() => void) | null = null;
  constructor(w: Endpoint) { this.writer = w; }
  async run<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    while (this.gate) await this.gate;
    this.inflight++;
    const c = new pg.Client({ connectionString: appUrl(this.writer) });
    c.on("error", () => {});
    try { await c.connect(); return await fn(c); }
    finally { await c.end().catch(() => {}); if (--this.inflight === 0) this.drained?.(); }
  }
  async pause() {
    this.gate = new Promise((r) => (this.open = r));
    if (this.inflight > 0) await new Promise<void>((r) => (this.drained = r));
    this.drained = null;
  }
  async resume(w: Endpoint) { this.writer = w; const o = this.open; this.gate = null; this.open = null; o?.(); }
}

export interface Load { ok: number; fail: number; errors: Record<string, number>; ids: number[]; lat: number[]; stop(): Promise<void> }

/** 앱 쓰기 부하: 요청마다 연결 → 주문 INSERT (+가끔 UPDATE) */
export function startLoad(router: Router, workers = 6, tag = "load"): Load {
  let stopping = false;
  const st: Load = { ok: 0, fail: 0, errors: {}, ids: [], lat: [], stop: async () => { stopping = true; await done; } };
  const one = async (k: number) => {
    let i = 0;
    while (!stopping) {
      const t0 = performance.now();
      try {
        const id = await router.run(async (c) => {
          const r = await c.query(`INSERT INTO orders(customer_id, amount, note) VALUES ($1, $2, $3) RETURNING id`, [1 + (i % 100), i, tag]);
          if (i % 5 === 0) await c.query(`UPDATE customers SET visits = visits + 1 WHERE id = $1`, [1 + (i % 100)]);
          return Number(r.rows[0].id);
        });
        st.ok++; st.ids.push(id);
      } catch (e) {
        st.fail++; const m = (e as Error).message.split("\n")[0]!; st.errors[m] = (st.errors[m] ?? 0) + 1;
        await new Promise((r) => setTimeout(r, 20));
      }
      st.lat.push(performance.now() - t0); i++; void k;
    }
  };
  const done = Promise.all(Array.from({ length: workers }, (_, k) => one(k)));
  return st;
}

export const pct = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0; };
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
