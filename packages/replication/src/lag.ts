import type pg from "pg";
import { type Endpoint, withClient } from "./endpoint.js";
import { now, waitFor } from "./sql.js";
import { fq, markerRef } from "./tables.js";

// "따라왔나"를 두 가지로 잰다.
//  1) 마커 왕복(ms): 출발에 1행 넣고 도착에 보일 때까지. 사용자가 느끼는 지연과 같은 단위라 판정에 쓴다
//  2) 슬롯 바이트: 출발 WAL 끝과 구독이 확인한 위치의 차. 보조 지표 (idle일 때 0이 아닐 수 있음)

export interface CopyStatus { tables: number; ready: number; states: Record<string, number>; done: boolean }

/** 초기 스냅샷 진행. srsubstate: i=초기화 d=복사중 f/s=동기화 r=준비 끝 */
export async function copyStatus(to: pg.Client, sub: string): Promise<CopyStatus> {
  const r = await to.query<{ st: string; n: string }>(
    `SELECT r.srsubstate st, count(*) n FROM pg_subscription_rel r JOIN pg_subscription s ON s.oid=r.srsubid
      WHERE s.subname=$1 GROUP BY 1`, [sub]);
  const states: Record<string, number> = {};
  for (const x of r.rows) states[x.st] = Number(x.n);
  const tables = Object.values(states).reduce((a, b) => a + b, 0);
  const ready = states["r"] ?? 0;
  return { tables, ready, states, done: tables > 0 && ready === tables };
}

// Z80: 100ms 간격이면 복사가 끝나도 최대 ~100ms + 왕복 늦게 알아챈다(맥 initial_copy 139ms 의 상당 부분【추정】). 25ms 로.
//   늘어나는 건 도착 DB 의 가벼운 카탈로그 조회뿐(초당 최대 ~40번, 복사 동안만)
export async function waitInitialCopy(target: Endpoint, sub: string, timeoutMs = 120_000): Promise<number> {
  return withClient(target, (c) => waitInitialCopyOn(c, sub, timeoutMs));
}
/** Z80 06: 이미 연 도착 연결로 기다리기 (sync 가 연결을 새로 열지 않게) */
export function waitInitialCopyOn(c: pg.Client, sub: string, timeoutMs = 120_000): Promise<number> {
  return waitFor(async () => (await copyStatus(c, sub)).done, { timeoutMs, everyMs: 25, what: `initial copy of ${sub}` });
}

export async function markerLagMs(src: pg.Client, dst: pg.Client, timeoutMs = 30_000): Promise<number> {
  const token = `lag-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await src.query(`INSERT INTO ${fq(markerRef)}(token) VALUES ($1)`, [token]);
  const t0 = now();
  await waitFor(async () => (await dst.query(`SELECT 1 FROM ${fq(markerRef)} WHERE token=$1`, [token])).rowCount === 1,
    { timeoutMs, everyMs: 10, what: "lag marker" });
  return now() - t0;
}

/** Z52 (Q16): walStatus·safeWalBytes는 PG 13+ pg_replication_slots 열.
 *  walStatus: reserved(정상) | extended(max_wal_size 넘김, 아직 보관) | unreserved(곧 지워질 WAL에 기댐) | lost(필요한 WAL이 지워짐 = 슬롯 못 씀)
 *  safeWalBytes: 슬롯이 무효가 되기까지 남은 WAL 바이트. max_slot_wal_keep_size = -1(무제한)이면 null */
export interface SlotLag { bytes: number | null; active: boolean; workerRunning: boolean; walStatus?: string | null; safeWalBytes?: number | null }
export async function slotLag(src: pg.Client, dst: pg.Client, name: string): Promise<SlotLag> {
  // Z80 06: 두 DB 는 서로 다른 연결이라 동시에 묻는다 (왕복 2번 → 1번 시간)
  const [s, w] = await Promise.all([
    src.query<{ lag: string | null; active: boolean; wal_status: string | null; safe: string | null }>(
      `SELECT pg_wal_lsn_diff(pg_current_wal_lsn(), confirmed_flush_lsn) lag, active, wal_status, safe_wal_size safe
         FROM pg_replication_slots WHERE slot_name=$1`, [name]),
    dst.query(`SELECT 1 FROM pg_stat_subscription WHERE subname=$1 AND pid IS NOT NULL`, [name])]);
  const row = s.rows[0];
  return { bytes: row?.lag == null ? null : Number(row.lag), active: row?.active ?? false, workerRunning: (w.rowCount ?? 0) > 0,
    walStatus: row?.wal_status ?? null, safeWalBytes: row?.safe == null ? null : Number(row.safe) };
}

export interface LagSample { markerMs: number; slot: SlotLag }
export async function sampleLag(source: Endpoint, target: Endpoint, name: string, n = 3, gapMs = 200): Promise<LagSample[]> {
  return withClient(source, (s) => withClient(target, (d) => sampleLagOn(s, d, name, n, gapMs)));
}
/** Z80 06: 이미 연 두 연결로 재기. 표본 사이 간격(gapMs)은 그대로 — "연속 n번 안정" 판정의 뜻이라 줄이지 않았다 */
export async function sampleLagOn(s: pg.Client, d: pg.Client, name: string, n = 3, gapMs = 200): Promise<LagSample[]> {
  const out: LagSample[] = [];
  for (let i = 0; i < n; i++) {
    out.push({ markerMs: await markerLagMs(s, d), slot: await slotLag(s, d, name) });
    if (i < n - 1) await new Promise((r) => setTimeout(r, gapMs));
  }
  return out;
}
