// Jeong 결정 11/4 01:53Z: 실패하면 사람에게 묻기 전에 트래픽부터 출발 100% 로 되돌린다 (답을 기다리는 동안 서비스가 멈춰 있으면 안 됨).
//   오케(실패 진입)가 부르는 하나뿐인 함수. 이 이전의 LB 자리(migration_traffic_targets, 없으면 .env)를 trafficFor 로 찾는다.
//   멱등: 이미 출발 100% 면 PATCH 없이 확인만 (restoreSource). Cloudflare 가 실패하면 대기를 늘려 다시, 다 실패하면 TrafficRestoreFailed(분명한 이유)
//   되돌리기 직전 도착 몫(fromPct)을 감사 traffic.restored 에 남긴다 → 재시도를 승인하면 shift 가 그 단계부터 다시 오른다 (shift.ts restoredFromPct)
import { restoreSource } from "@svc/traffic";
import { withTenant, writeAudit, scrubString } from "@svc/core";
import { setTrafficWeightMetric } from "./instrument.js";
import { trafficFor } from "./platform.js";

export const TRAFFIC_RESTORE_FAILED = "TRAFFIC_RESTORE_FAILED";
export class TrafficRestoreFailed extends Error {
  readonly code = TRAFFIC_RESTORE_FAILED;
  constructor(message: string, readonly lbId: string, readonly attempts: number) { super(message); }
}
export interface TrafficRestoreResult {
  ok: true; lbId: string; lbFrom: "db" | "env"; provider: string;
  fromPct: number | null;            // 되돌리기 직전 도착 몫 (못 읽었으면 null)
  alreadyRestored: boolean; attempts: number;
  fallback?: { to: "source"; ok: boolean; error?: string };
}

// DRAFT(ai): 3번, 대기 2초 → 4초 (한 번 시도 안에서도 setAndVerify 가 3번 PATCH+GET). 다 합쳐 최악 약 1분
export async function restoreTrafficToSource(tenantId: string, migrationId: string,
  o: { attempts?: number; sleep?: (ms: number) => Promise<void>; reason?: string } = {}): Promise<TrafficRestoreResult> {
  const attempts = o.attempts ?? 3;
  const sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const t = await trafficFor(tenantId, migrationId);
  const before = await t.switcher.get(t.lbId).catch(() => null);
  const fromPct = before ? Math.round(before.target * 100) : null;
  let last = "";
  for (let i = 1; i <= attempts; i++) {
    try {
      const r = await restoreSource({ switcher: t.switcher, lbId: t.lbId, migrationId, sleep });
      if (!r.evidence.sourceWeight100) throw new Error(`되돌린 뒤 읽은 값이 출발 100% 가 아님: ${JSON.stringify(r.detail.after)}`);
      setTrafficWeightMetric(migrationId, 0);
      const fallback = r.detail.fallback as TrafficRestoreResult["fallback"];
      const out: TrafficRestoreResult = { ok: true, lbId: t.lbId, lbFrom: t.from, provider: t.switcher.provider ?? "unknown", fromPct,
        alreadyRestored: r.detail.alreadyRestored === true, attempts: i, ...(fallback ? { fallback } : {}) };
      // 기록 실패로 되돌리기를 실패로 만들지 않는다 (트래픽은 이미 출발). 재개 단계만 못 이어 감 → 처음부터
      //   이미 출발 100% 였으면 새 줄을 안 쓴다 (두 번째 부름이 fromPct 0 으로 덮어 재개 단계를 잃지 않게)
      if (!out.alreadyRestored) await withTenant(tenantId, (tx) => writeAudit(tx, tenantId, { actor: "worker", action: "traffic.restored", target: migrationId, result: "ok",
        detail: { ...out, ...(o.reason ? { reason: o.reason.slice(0, 200) } : {}) } })).catch((e) => console.error("traffic.restored audit", scrubString((e as Error).message)));
      return out;
    } catch (e) {
      last = scrubString((e as Error).message).slice(0, 300);
      if (i < attempts) await sleep(2000 * 2 ** (i - 1));
    }
  }
  throw new TrafficRestoreFailed(`트래픽을 출발 100% 로 못 되돌림 (${attempts}번, LB ${t.lbId.slice(0, 4)}…, ${t.from}): ${last} → Cloudflare 대시보드에서 출발 pool 가중치를 1, 도착을 0 으로`, t.lbId, attempts);
}

/** shift 재개용: 마지막 되돌리기 직전 도착 몫. 없으면 null */
export async function restoredFromPct(tenantId: string, migrationId: string): Promise<number | null> {
  return withTenant(tenantId, async (tx) => {
    const q = await tx.query<{ pct: string | null }>(
      `SELECT detail->>'fromPct' AS pct FROM audit_events WHERE target = $1 AND action = 'traffic.restored' ORDER BY seq DESC LIMIT 1`, [migrationId]);
    const n = q.rows[0]?.pct == null ? NaN : Number(q.rows[0]!.pct);
    return Number.isFinite(n) && n > 0 ? n : null;
  });
}
