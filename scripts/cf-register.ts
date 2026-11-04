// pf-d TRF-21: cf-check 가 만든(또는 확인한) LB·풀을 이전 하나에 등록한다 (db 0041 migration_traffic_targets, orch pf04 의 upsertTrafficTarget).
//   워커(shift·cutover·rollback)는 trafficFor 로 이 줄을 먼저 읽는다 → 이전마다 .env 4줄 고치고 워커 다시 띄우는 일이 없어진다.
//   토큰은 DB 에 안 넣는다 (워커 환경 그대로). LB·풀·zone id 는 비밀이 아니지만 화면엔 앞 4자리만
import type { TrafficTarget } from "@svc/contracts";

export interface RegisterInput { tenantId: string; migrationId: string; target: TrafficTarget; by?: string }
export type RegisterResult = { ok: true } | { ok: false; reason: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 이 회사의 이전이 보일 때만 쓴다 (FK 는 RLS 를 안 거쳐서, 남의 이전 번호로도 줄이 들어갈 수 있다 → 먼저 확인).
 *  끝난 이전(completed·rolled_back·cancelled)엔 안 쓴다 */
export async function registerTrafficTarget(i: RegisterInput): Promise<RegisterResult> {
  if (!UUID.test(i.tenantId) || !UUID.test(i.migrationId)) return { ok: false, reason: "--tenant 와 --register 는 UUID 여야 한다" };
  const core = await import("@svc/core");   // DB 가 필요할 때만 (보통 cf-check 는 DB 없이 돈다)
  return core.withTenant(i.tenantId, async (tx) => {
    const m = await tx.query<{ status: string }>("SELECT status FROM migrations WHERE id = $1", [i.migrationId]);
    const st = m.rows[0]?.status;
    if (!st) return { ok: false as const, reason: "이 회사에 그 이전이 없다 (번호·회사 확인)" };
    if (["completed", "rolled_back", "cancelled"].includes(st)) return { ok: false as const, reason: `끝난 이전 (${st}) 에는 등록하지 않는다` };
    await core.upsertTrafficTarget(tx, i.tenantId, i.migrationId, i.target, i.by ?? "cf-check");
    return { ok: true as const };
  });
}

// pf-d TRF-10: cf-check --probe 분배 실측 요약을 그 이전의 감사 한 줄(traffic.probe)로 남긴다. PROM_URL 이 없어 shift 지표가 가짜일 때
//   shift 결과가 이 줄을 붙인다 → "실제 분배는 이렇게 쟀다"는 증거가 화면·감사에 같이 남는다. 오리진 이름(x-served-by)만, 주소는 안 남김
export interface ProbeStep { step: string; gotPct: number; wantPct: number; tolPct: number; errors: number; total: number; ok: boolean }
export async function recordProbe(i: { tenantId: string; migrationId: string; probeTarget: string; steps: ProbeStep[] }): Promise<RegisterResult> {
  if (!UUID.test(i.tenantId) || !UUID.test(i.migrationId)) return { ok: false, reason: "--tenant 와 --register 는 UUID 여야 한다" };
  const core = await import("@svc/core");
  return core.withTenant(i.tenantId, async (tx) => {
    const m = await tx.query("SELECT 1 FROM migrations WHERE id = $1", [i.migrationId]);
    if (!m.rowCount) return { ok: false as const, reason: "이 회사에 그 이전이 없다 (번호·회사 확인)" };
    await core.writeAudit(tx, i.tenantId, { actor: "cf-check", action: "traffic.probe", target: i.migrationId,
      result: i.steps.every((s) => s.ok) ? "ok" : "error",
      detail: { probeTarget: i.probeTarget, steps: i.steps, at: new Date().toISOString() } });
    return { ok: true as const };
  });
}

export async function closeDb(): Promise<void> {
  const { pool } = await import("@svc/core"); await pool.end().catch(() => undefined);
}
