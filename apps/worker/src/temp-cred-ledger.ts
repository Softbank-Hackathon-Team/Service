import { withTenant } from "@svc/core";
import type { CredentialLedger } from "@svc/security";

// 임시 자격 증명 장부 = DB 표 temp_credentials (위협 모델 T-ROLE-8).
// 값은 안 들어간다. 여러 워커가 같은 표를 보므로 회수 증거(T27)를 여기서 센다
export function pgLedger(): CredentialLedger {
  return {
    durable: true,
    async record(e) {
      await withTenant(e.tenantId, (tx) => tx.query(
        `INSERT INTO temp_credentials (credential_ref, tenant_id, migration_id, env_id, provider, purpose, stage, role_ref, owner, issued_at, expires_at,
                                       step, actions_count, requested_ttl_sec, stub, renewed_from, renew_seq)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
        [e.ref, e.tenantId, e.migrationId, e.envId, e.provider, e.purpose, e.stage, e.roleRef, e.owner, e.issuedAt, e.expiresAt,
         e.step ?? null, e.actionsCount ?? null, e.requestedTtlSec ?? null, e.stub ?? null, e.renewedFrom ?? null, e.renewSeq ?? 0]));
    },
    async markRevoked(tenantId, ref, reason, now) {
      await withTenant(tenantId, (tx) => tx.query(
        `UPDATE temp_credentials SET status='revoked', revoke_reason=COALESCE(revoke_reason,$2), revoked_at=$3
          WHERE credential_ref=$1 AND status NOT IN ('revoked', 'expired')`, [ref, reason, now]));
    },
    async requestRevoke(tenantId, migrationId, reason, exceptOwner) {
      const r = await withTenant(tenantId, (tx) => tx.query(
        `UPDATE temp_credentials SET status='revoke_requested', revoke_reason=$3
          WHERE migration_id=$1 AND owner <> $2 AND status='active' AND expires_at > now()`, [migrationId, exceptOwner, reason]));
      return r.rowCount ?? 0;
    },
    async revokeRequested(tenantId, refs) {
      if (!refs.length) return [];
      const r = await withTenant(tenantId, (tx) => tx.query(
        `SELECT credential_ref AS ref, COALESCE(revoke_reason,'requested') AS reason FROM temp_credentials
          WHERE credential_ref = ANY($1::text[]) AND status='revoke_requested'`, [refs]));
      return r.rows as Array<{ ref: string; reason: string }>;
    },
    async activeOperate(tenantId, migrationId, now) {
      const r = await withTenant(tenantId, (tx) => tx.query(
        `SELECT count(*)::int AS n FROM temp_credentials
          WHERE migration_id=$1 AND purpose='operate' AND status NOT IN ('revoked', 'expired') AND expires_at > $2`, [migrationId, now]));
      return (r.rows[0] as { n: number }).n;
    },
    // 0013: 만료 시각이 지난 줄을 expired 로 닫는다. expired_at = 실제로 죽은 시각(expires_at)
    async expireDue(tenantId, now) {
      const r = await withTenant(tenantId, (tx) => tx.query(
        `UPDATE temp_credentials SET status='expired', expired_at=expires_at
          WHERE status IN ('active', 'revoke_requested') AND expires_at <= $1
          RETURNING credential_ref AS ref, migration_id AS "migrationId", env_id AS "envId"`, [now]));
      return r.rows as Array<{ ref: string; migrationId: string | null; envId: string }>;
    },
  };
}
