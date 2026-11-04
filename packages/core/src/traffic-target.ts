import { TrafficTarget } from "@svc/contracts";
import type { Tx } from "./db.js";

// PF TRF-21: 이전마다 트래픽 LB 자리 읽기·쓰기 (db 0041). withTenant 안에서만 (RLS)
export async function trafficTargetFor(tx: Tx, migrationId: string): Promise<TrafficTarget | null> {
  const r = await tx.query<{ provider: string; lb_id: string; source_pool_id: string | null; target_pool_id: string | null; zone_id: string | null }>(
    `SELECT provider, lb_id, source_pool_id, target_pool_id, zone_id FROM migration_traffic_targets WHERE migration_id = $1`, [migrationId]);
  const row = r.rows[0];
  if (!row) return null;
  return TrafficTarget.parse({ provider: row.provider, lbId: row.lb_id, sourcePoolId: row.source_pool_id,
    targetPoolId: row.target_pool_id, zoneId: row.zone_id });
}

/** 등록(트래픽 영역 cf-check 등). 같은 이전이면 덮어쓴다 */
export async function upsertTrafficTarget(tx: Tx, tenantId: string, migrationId: string, t: TrafficTarget, by: string): Promise<void> {
  const v = TrafficTarget.parse(t);
  await tx.query(
    `INSERT INTO migration_traffic_targets (migration_id, tenant_id, provider, lb_id, source_pool_id, target_pool_id, zone_id, registered_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (migration_id) DO UPDATE SET provider = EXCLUDED.provider, lb_id = EXCLUDED.lb_id, source_pool_id = EXCLUDED.source_pool_id,
       target_pool_id = EXCLUDED.target_pool_id, zone_id = EXCLUDED.zone_id, registered_by = EXCLUDED.registered_by, updated_at = now()`,
    [migrationId, tenantId, v.provider, v.lbId, v.sourcePoolId ?? null, v.targetPoolId ?? null, v.zoneId ?? null, by]);
}
