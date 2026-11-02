import { canonical, sha256 } from "./hash.js";
import type { Tx } from "./db.js";
import { redactAuditValue, redactText } from "./redact.js";

export interface AuditInput {
  actor: string;     // user:<id> | worker | guardrail | ai_agent
  action: string;    // 예: migration.importing
  target: string;
  result: "ok" | "denied" | "error";
  detail?: Record<string, unknown>;
}

// 항상 트랜잭션의 마지막 잠금이다
export async function writeAudit(tx: Tx, tenantId: string, raw: AuditInput) {
  // SECAUDIT: 주소·계정 ID·토큰·비밀번호는 해시·저장 전에 가린다 (redact.ts). 가린 값이 해시 대상 = 체인 검증은 그대로
  const a: AuditInput = { ...raw, target: redactText(raw.target),
    ...(raw.detail !== undefined ? { detail: redactAuditValue(raw.detail) } : {}) };
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
