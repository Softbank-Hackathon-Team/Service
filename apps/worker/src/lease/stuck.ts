// PF FM-ORC-15: 도착 자원을 만든 뒤 멈춘 이전(paused·자원 만든 뒤 failed = "재시도할까?" 질문 대기)에 기한·알림이 없어 과금이 계속됐다.
//   리퍼(1분마다)가 부른다: 상한(STUCK_ALERT_SEC) 넘게 멈춘 이전마다 감사 migration.stuck_alert(result error) + 화면 신호 + 워커 경고 로그.
//   같은 이전은 STUCK_ALERT_EVERY_SEC 마다 한 번만. 자동으로 지우지는 않는다 (Jeong 11/4 01:53Z: 지우기는 사람이 거절 → 롤백을 고를 때만) → 제안만 남김
import { pool, withTenant, writeAudit, notifyMigration } from "@svc/core";
import { envNumber, type MigrationStatus } from "@svc/contracts";
import { log } from "../instrument.js";

export interface StuckRow { tenantId: string; migrationId: string; status: string; failedAtStatus: string | null;
  pausedFrom: string | null; failureCode: string | null; stuckSec: number }

// DRAFT(ai): 4시간 멈추면 첫 알림, 그 뒤 4시간마다 (데모 감시 창은 jeong-watch 가 더 짧게 본다). 0 이면 끔
export const stuckAlertSec = (env: NodeJS.ProcessEnv = process.env) => envNumber(env.STUCK_ALERT_SEC, 4 * 3600);
export const stuckAlertEverySec = (env: NodeJS.ProcessEnv = process.env) => envNumber(env.STUCK_ALERT_EVERY_SEC, 4 * 3600);

/** 사람이 할 일 한 줄 (화면·감사). 자원을 지우는 길은 롤백 끝(rolled_back → target-destroy) 하나 */
export function stuckSuggestion(r: Pick<StuckRow, "migrationId" | "status" | "pausedFrom">): string {
  if (r.status === "paused" && r.pausedFrom === "cleanup")
    return `정리 단계에서 멈춤: 원인을 고친 뒤 POST /migrations/${r.migrationId}/resume (창이 끝나 롤백 불가)`;
  if (r.status === "paused")
    return `POST /migrations/${r.migrationId}/resume (재개) 또는 /rollback (롤백 → 도착 자원 지우기)`;
  return `POST /migrations/${r.migrationId}/failure-decision {"choice":"retry"} 또는 {"choice":"rollback"} (롤백 → 도착 자원 지우기)`;
}

export async function listStuck(minAgeSec: number, max = 100): Promise<StuckRow[]> {
  const q = await pool.query("SELECT * FROM maint_stuck_migrations(make_interval(secs => $1), $2)", [minAgeSec, max]);
  return q.rows.map((x) => ({ tenantId: x.tenant_id, migrationId: x.migration_id, status: x.status, failedAtStatus: x.failed_at_status,
    pausedFrom: x.paused_from, failureCode: x.failure_code, stuckSec: x.stuck_sec }));
}

/** 알림을 쓴 이전 수. 함수가 없으면(0043 안 넣음) 0 — 리퍼 본업을 막지 않는다 */
export async function alertStuckOnce(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const min = stuckAlertSec(env);
  if (!(min > 0)) return 0;
  const every = stuckAlertEverySec(env);
  let rows: StuckRow[];
  try { rows = await listStuck(min); }
  catch (e) { if ((e as { code?: string }).code === "42883") return 0; throw e; }
  let n = 0;
  for (const r of rows) {
    const wrote = await withTenant(r.tenantId, async (tx) => {
      const recent = await tx.query(`SELECT 1 FROM audit_events WHERE target = $1 AND action = 'migration.stuck_alert'
          AND at > now() - make_interval(secs => $2) LIMIT 1`, [r.migrationId, Math.max(every, 60)]);
      if (recent.rowCount) return false;
      const suggestion = stuckSuggestion(r);
      await writeAudit(tx, r.tenantId, { actor: "worker", action: "migration.stuck_alert", target: r.migrationId, result: "error",
        detail: { status: r.status, failedAtStatus: r.failedAtStatus, pausedFrom: r.pausedFrom, failureCode: r.failureCode,
                  stuckSec: r.stuckSec, thresholdSec: min, cost: "도착 자원(클러스터·DB)이 남아 과금 중일 수 있음", suggestion } });
      await notifyMigration(tx, { t: r.tenantId, id: r.migrationId, s: r.status as MigrationStatus });
      return true;
    });
    if (wrote) { n++; log.warn({ migration_id: r.migrationId, status: r.status, stuck_sec: r.stuckSec, failure_code: r.failureCode }, "migration stuck: human decision needed (resources may be billing)"); }
  }
  return n;
}
