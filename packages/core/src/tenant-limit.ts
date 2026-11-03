import { envNumber } from "@svc/contracts";
import type { Tx } from "./db.js";
import { DomainError } from "./errors.js";
import { LOCKED_STAGES } from "./states.js";

// 회사당 동시 진행 이전 상한 (계획 26 A8, 설계 5.3·8장). POST /migrations/:id/start 가 부른다.
// 상한 = env TENANT_MAX_ACTIVE (기본 0 = 꺼짐 → 지금 동작 그대로). 넘으면 409 TENANT_BUSY
// DRAFT(ai): "진행 중" = 환경 잠금을 쥐고 일하는 단계(LOCKED_STAGES: provisioning … cleanup·rolling_back·paused).
//   failed 는 안 센다 (일하는 중이 아니라 사람이 볼 차례). 승인만 받고 아직 안 시작한 approved 도 안 센다
// DRAFT(ai): 동시에 두 start 가 들어와도 둘 다 통과하지 않게, 회사별 advisory 잠금(트랜잭션 끝에 풀림)으로 줄 세운다.
//   회사 행 FOR UPDATE 는 app_user 에 UPDATE 권한이 없어(0001: tenants SELECT 만) 못 쓴다. audit.ts 와 같은 방식

export class TenantBusy extends DomainError {
  constructor(tenantId: string, active: number, max: number) {
    super(409, "TENANT_BUSY", `tenant ${tenantId}: ${active} migrations in progress (limit ${max})`);
  }
}

// 0·빈 값 = 꺼짐. 음수·숫자 아님도 꺼짐으로 본다 (설정 검사 표가 먼저 막음)
export function tenantMaxActive(env: NodeJS.ProcessEnv = process.env): number {
  const n = envNumber(env.TENANT_MAX_ACTIVE, 0);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

// start 와 같은 트랜잭션에서 부른다. 꺼져 있으면 DB 를 안 건드린다
export async function assertTenantCapacity(
  tx: Tx, tenantId: string, migrationId: string, env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const max = tenantMaxActive(env);
  if (max === 0) return;
  await tx.query("SELECT pg_advisory_xact_lock(hashtext('tenant-limit:' || $1))", [tenantId]);
  const q = await tx.query(
    `SELECT count(*)::int AS n FROM migrations
      WHERE tenant_id=$1 AND id <> $2 AND status = ANY($3::text[])`,
    [tenantId, migrationId, [...LOCKED_STAGES]]);
  const active = q.rows[0].n as number;
  if (active >= max) throw new TenantBusy(tenantId, active, max);
}
