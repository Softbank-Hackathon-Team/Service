import { MIGRATION_STATUSES, QUEUES } from "@svc/contracts";
import { pool } from "../db.js";
import { LEASE } from "../envlock.js";
import { Registry, STATE_BUCKETS_SEC, PAUSE_BUCKETS_MS } from "./metrics.js";
import { createLogger } from "./log.js";

// DB 에서 읽어 오는 지표. 어느 프로세스(api)에서 수집해도 같은 값이 나온다
//  - 이전 상태별 개수, 상태에 머문 시간, 상태 이동 횟수, 컷오버 멈춤: 감사 표 → metrics_snapshot() (0006)
//  - 큐 대기·실행·실패 수, 가장 오래 기다린 작업: pgboss.job (app_user 소유 스키마라 직접 읽는다)
//  - 환경 잠금 생존 신호 지연: env_locks.lease_expires_at
// 감사 표는 넣기만 되는 표(고치기·지우기 권한 없음)라, 감사에서 센 누적 값은 줄지 않는다 → 카운터·히스토그램으로 내보내도 된다

type Q = (text: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

interface Snapshot {
  migrations: Record<string, number>;
  transitions: { from: string; to: string; n: number }[];
  stateDurations: { state: string; bucket: number; n: number; sum: number }[];
  cutoverPause: { buckets: { bucket: number; n: number }[]; count: number; sum: number; last: number | null };
  leases: { reserved: number; held: number; expired: number; maxHeartbeatLagSec: number | null };
}

// width_bucket 결과(값보다 작거나 같은 경계 개수)를 Prometheus 누적 칸으로 바꾼다
// 칸 i(경계 le_i) = width_bucket 값이 i 이하인 줄 수
export function toCumulative(rows: { bucket: number; n: number }[], nBuckets: number): number[] {
  return Array.from({ length: nBuckets }, (_, i) =>
    rows.filter((r) => r.bucket <= i).reduce((a, r) => a + Number(r.n), 0));
}

export function registerDbMetrics(reg: Registry, q: Q = (t, v) => pool.query(t, v as unknown[])) {
  const log = createLogger("metrics");
  const migrations = reg.gauge("svc_migrations", "Migrations by current status (all tenants)");
  const transitions = reg.counter("svc_migration_transitions_total", "State transitions recorded in audit_events");
  const stateDur = reg.histogram("svc_migration_state_duration_seconds",
    "Time a migration stayed in a state before moving on (from audit_events)", STATE_BUCKETS_SEC);
  const pauseMs = reg.histogram("svc_cutover_pause_ms", "DB write pause during cutover, ms (C1..C6)", PAUSE_BUCKETS_MS);
  const pauseLast = reg.gauge("svc_cutover_pause_last_ms", "Last successful cutover write pause, ms");
  const locks = reg.gauge("svc_env_locks", "Environment locks by holder kind");
  const hbLag = reg.gauge("svc_lease_heartbeat_lag_seconds",
    "Max seconds since a worker-held env lock was last renewed (healthy < heartbeat interval 30s)");
  const qJobs = reg.gauge("svc_queue_jobs", "pg-boss jobs by queue and state (failed = still retained)");
  const qOldest = reg.gauge("svc_queue_oldest_waiting_seconds", "Age of the oldest job ready but not started");
  const errors = reg.counter("svc_metrics_collect_errors_total", "Errors while collecting DB metrics");
  const took = reg.gauge("svc_metrics_collect_duration_seconds", "Time spent collecting DB metrics");

  reg.onCollect(async () => {
    const t0 = performance.now();
    try {
      const r = await q("SELECT metrics_snapshot($1::float8[], $2::float8[], $3) AS s",
        [STATE_BUCKETS_SEC, PAUSE_BUCKETS_MS, LEASE.workerSec]);
      const s = r.rows[0]!.s as Snapshot;
      migrations.reset();
      for (const st of MIGRATION_STATUSES) migrations.set({ status: st }, Number(s.migrations[st] ?? 0));
      transitionsSet(transitions, s.transitions);
      stateDur.reset();
      const byState = new Map<string, Snapshot["stateDurations"]>();
      for (const d of s.stateDurations) byState.set(d.state, [...(byState.get(d.state) ?? []), d]);
      for (const [state, rows] of byState) {
        stateDur.setRaw({ state }, toCumulative(rows, STATE_BUCKETS_SEC.length),
          rows.reduce((a, x) => a + Number(x.sum), 0), rows.reduce((a, x) => a + Number(x.n), 0));
      }
      pauseMs.reset();
      if (s.cutoverPause.count > 0) {
        pauseMs.setRaw({}, toCumulative(s.cutoverPause.buckets, PAUSE_BUCKETS_MS.length),
          Number(s.cutoverPause.sum), Number(s.cutoverPause.count));
      }
      pauseLast.reset();
      if (s.cutoverPause.last !== null) pauseLast.set({}, Number(s.cutoverPause.last));
      locks.set({ holder: "reserved" }, Number(s.leases.reserved));
      locks.set({ holder: "worker" }, Number(s.leases.held));
      locks.set({ holder: "expired" }, Number(s.leases.expired));
      hbLag.reset();
      if (s.leases.maxHeartbeatLagSec !== null) hbLag.set({}, Number(s.leases.maxHeartbeatLagSec));
    } catch (e) {
      errors.inc({ source: "audit" });
      log.warn({ err: e }, "metrics_snapshot failed");
    }
    try {
      const r = await q(
        `SELECT name, state::text AS state, count(*)::int AS n,
                COALESCE(extract(epoch FROM now() - min(created_on)
                  FILTER (WHERE state IN ('created','retry') AND start_after <= now())), 0)::float8 AS oldest
           FROM pgboss.job GROUP BY name, state`);
      qJobs.reset(); qOldest.reset();
      for (const name of Object.values(QUEUES)) {
        for (const st of ["created", "retry", "active", "failed"]) qJobs.set({ queue: name, state: st }, 0);
        qOldest.set({ queue: name }, 0);
      }
      for (const row of r.rows) {
        const queue = String(row.name), state = String(row.state);
        qJobs.set({ queue, state }, Number(row.n));
        if (Number(row.oldest) > qOldest.value({ queue })) qOldest.set({ queue }, Number(row.oldest));
      }
    } catch (e) {
      errors.inc({ source: "queue" });
      log.warn({ err: e }, "queue stats failed");
    }
    took.set({}, (performance.now() - t0) / 1000);
  });
}

// 카운터 값을 DB 누적 값으로 맞춘다 (프로세스가 다시 떠도 감사 표 기준으로 이어진다)
function transitionsSet(c: ReturnType<Registry["counter"]>, rows: Snapshot["transitions"]) {
  for (const t of rows) {
    const l = { from: t.from, to: t.to };
    c.inc(l, Number(t.n) - c.value(l));
  }
}
