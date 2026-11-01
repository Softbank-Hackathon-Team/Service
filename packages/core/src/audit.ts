import { canonical, sha256 } from "./hash.js";
import type { Tx } from "./db.js";

export interface AuditInput {
  actor: string;     // user:<id> | worker | guardrail | ai_agent
  action: string;    // 예: migration.importing
  target: string;
  result: "ok" | "denied" | "error";
  detail?: Record<string, unknown>;
}

// 항상 트랜잭션의 마지막 잠금이다
export async function writeAudit(tx: Tx, tenantId: string, a: AuditInput) {
  await tx.query("SELECT pg_advisory_xact_lock(hashtext('audit:' || $1))", [tenantId]);
  const prev = await tx.query(
    "SELECT hash FROM audit_events ORDER BY seq DESC LIMIT 1");
  const prevHash: string = prev.rows[0]?.hash ?? "genesis";
  const body = { ...a, tenantId, prevHash };
  const hash = sha256(canonical(body));
  await tx.query(
    `INSERT INTO audit_events (tenant_id, actor, action, target, result, detail, prev_hash, hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [tenantId, a.actor, a.action, a.target, a.result, a.detail ?? {}, prevHash, hash]);
}
