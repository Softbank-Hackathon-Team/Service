import type { Tx } from "./db.js";
import { withTenant } from "./db.js";
import { IdempotencyKeyReused, DomainError } from "./errors.js";

// 같은 HTTP 요청이 두 번 와도 한 번만 처리한다.
// 순서: (1) 키 줄을 트랜잭션 맨 앞에서 넣어 본다 → (2) 이미 있으면 지문 비교 후 첫 응답 재생
//       → (3) 처리 → (4) 확정 직전에 응답을 키 줄에 적는다.
// 같은 키로 동시에 둘이 오면 두 번째의 INSERT가 첫 번째 확정까지 기다린다.
// 처리가 실패해 취소되면 키도 같이 사라진다 → 키는 성공한 요청에만 남는다

export interface IdemKey { key: string; reqHash: string }
export interface IdemResult<T> { status: number; body: T; replayed: boolean }

export async function withIdempotency<T>(
  tenantId: string,
  idem: IdemKey | null,
  fn: (tx: Tx) => Promise<{ status: number; body: T }>,
): Promise<IdemResult<T>> {
  return withTenant(tenantId, async (tx) => {
    if (!idem) return { ...(await fn(tx)), replayed: false };

    const ins = await tx.query(
      `INSERT INTO idempotency_keys (tenant_id, key, req_hash) VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING RETURNING 1`,
      [tenantId, idem.key, idem.reqHash]);
    if (ins.rowCount === 0) {
      const ex = await tx.query(
        "SELECT req_hash, status_code, response FROM idempotency_keys WHERE tenant_id = $1 AND key = $2",
        [tenantId, idem.key]);
      const row = ex.rows[0];
      if (!row) throw new DomainError(409, "IDEMPOTENCY_RETRY", "key vanished, retry");
      if (row.req_hash !== idem.reqHash) throw new IdempotencyKeyReused();
      return { status: row.status_code, body: row.response as T, replayed: true };
    }

    const out = await fn(tx);
    await tx.query(
      "UPDATE idempotency_keys SET status_code = $3, response = $4 WHERE tenant_id = $1 AND key = $2",
      [tenantId, idem.key, out.status, JSON.stringify(out.body ?? null)]);
    return { ...out, replayed: false };
  });
}
