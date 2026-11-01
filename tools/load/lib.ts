// 부하 시험 공통 도구: API 호출, 백분위, DB 연결 수 표본, 시험용 환경 만들기
// 실행 전 조건: api(:3000)와 worker 가 떠 있고 .env 의 OWNER_DATABASE_URL 로 DB 에 붙을 수 있다
import pg from "pg";
import { randomUUID } from "node:crypto";

export const API = `http://localhost:${process.env.API_PORT ?? 3000}/api/v1`;
export const TENANT = process.env.LOAD_TENANT ?? "11111111-1111-4111-8111-111111111111";
export const SRC = "22222222-2222-4222-8222-222222222222";
export const DST = "33333333-3333-4333-8333-333333333333";

export interface Res { status: number; json: any; ms: number; headers: Headers }
export const statusCount = new Map<number, number>();

export async function call(method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<Res> {
  const t = performance.now();
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { "content-type": "application/json", "x-dev-tenant": TENANT, ...extra },
    body: body === undefined ? (method === "POST" ? "{}" : undefined) : JSON.stringify(body),
  });
  const text = await res.text();
  const ms = performance.now() - t;
  statusCount.set(res.status, (statusCount.get(res.status) ?? 0) + 1);
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json, ms, headers: res.headers };
}

export function pct(xs: number[], p: number): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]!;
}
export const r1 = (x: number) => Math.round(x * 10) / 10;
export function summary(xs: number[]) {
  return { n: xs.length, p50: r1(pct(xs, 50)), p95: r1(pct(xs, 95)), max: r1(Math.max(...xs)) };
}
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 관리자 연결 (RLS 밖에서 확인용). 시험이 상태를 "몰래" 바꾸지는 않는다. 읽기 + 시험용 환경 넣기만
export const owner = new pg.Pool({ connectionString: process.env.OWNER_DATABASE_URL, max: 2 });

// 이전마다 다른 출발·도착 환경이 있어야 승인 때 환경 잠금(ENV_BUSY)에 안 걸린다
export async function seedEnvPairs(n: number): Promise<{ src: string; dst: string }[]> {
  const out: { src: string; dst: string }[] = [];
  const tag = Date.now().toString(36);
  for (let i = 0; i < n; i++) {
    const src = randomUUID(), dst = randomUUID();
    await owner.query(
      `INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES
        ($1,$3,'aws',$4,'connected'), ($2,$3,'gcp',$5,'connected')`,
      [src, dst, TENANT, `load-${tag}-src-${i}`, `load-${tag}-dst-${i}`]);
    out.push({ src, dst });
  }
  return out;
}

// pg_stat_activity 를 주기적으로 읽어 DB 연결 수 최대값을 잰다 (앱 계정만)
export function sampleConnections(everyMs = 200) {
  const peak = { total: 0, active: 0, idleInTx: 0, lockWait: 0, samples: 0 };
  let max = 0;
  const waits = new Map<string, number>();
  const timer = setInterval(async () => {
    try {
      const q = await owner.query(`
        SELECT count(*)::int AS total,
               count(*) FILTER (WHERE state='active')::int AS active,
               count(*) FILTER (WHERE state LIKE 'idle in transaction%')::int AS idle_in_tx,
               count(*) FILTER (WHERE wait_event_type='Lock')::int AS lock_wait,
               current_setting('max_connections')::int AS max
          FROM pg_stat_activity WHERE usename='app_user'`);
      const r = q.rows[0];
      peak.samples++;
      peak.total = Math.max(peak.total, r.total);
      peak.active = Math.max(peak.active, r.active);
      peak.idleInTx = Math.max(peak.idleInTx, r.idle_in_tx);
      peak.lockWait = Math.max(peak.lockWait, r.lock_wait);
      max = r.max;
      const w = await owner.query(`SELECT wait_event || ' | ' || left(regexp_replace(query, '\\s+', ' ', 'g'), 80) AS q
          FROM pg_stat_activity WHERE usename='app_user' AND wait_event_type='Lock'`);
      for (const x of w.rows) waits.set(x.q, (waits.get(x.q) ?? 0) + 1);
    } catch { /* 표본 하나 놓쳐도 된다 */ }
  }, everyMs);
  return { stop: () => { clearInterval(timer); return { ...peak, maxConnections: max, topLockWaits: [...waits].sort((a, b) => b[1] - a[1]).slice(0, 5) }; } };
}

// Z32: paused 는 "사람 재개 대기"라 저절로 안 바뀐다. FLOW_PAUSED_SETTLE_MS(기본 30초) 동안 paused 그대로면 끝난 것으로 본다
// (예전: FLOW_TIMEOUT_MS 1200초까지 기다려 시험 하나가 20분). 0 이면 예전처럼 끝까지 기다린다
const PAUSED_SETTLE_MS = Number(process.env.FLOW_PAUSED_SETTLE_MS ?? 30_000);
export async function waitStatus(id: string, targets: string[], timeoutMs: number, everyMs = 250): Promise<string> {
  const t0 = Date.now();
  let pausedSince = 0;
  for (;;) {
    const r = await call("GET", `/migrations/${id}`);
    const s = r.json?.status as string;
    if (targets.includes(s)) return s;
    if (["failed", "cancelled", "rolled_back", "rejected", "stale"].includes(s)) return s;
    if (s === "paused" && PAUSED_SETTLE_MS > 0) {
      pausedSince ||= Date.now();
      if (Date.now() - pausedSince >= PAUSED_SETTLE_MS) return "paused";
    } else pausedSince = 0;
    if (Date.now() - t0 > timeoutMs) return `TIMEOUT@${s}`;
    await sleep(everyMs);
  }
}

export function printStatusCounts() {
  const o: Record<string, number> = {};
  for (const [k, v] of [...statusCount].sort()) o[k] = v;
  console.log("HTTP status counts:", JSON.stringify(o));
}
