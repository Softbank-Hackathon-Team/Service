import { canonical, sha256 } from "@svc/core";
import type { AuditRow, ChainCheck } from "./schema.js";

// 감사 한 줄의 지문을 writeAudit(core/audit.ts)과 같은 방식으로 다시 계산한다.
// writeAudit은 detail이 없으면 지문에는 detail을 빼고, 표에는 {}를 넣는다.
// 그래서 detail이 {}면 "뺀 지문"과 "{} 넣은 지문" 둘 다 맞는 것으로 본다
export function rowHash(r: AuditRow, withEmptyDetail = true): string {
  const body: Record<string, unknown> = {
    actor: r.actor, action: r.action, target: r.target, result: r.result,
    tenantId: r.tenantId, prevHash: r.prevHash,
  };
  if (withEmptyDetail || Object.keys(r.detail).length > 0) body.detail = r.detail;
  return sha256(canonical(body));
}

function hashOk(r: AuditRow): boolean {
  if (rowHash(r) === r.hash) return true;
  return Object.keys(r.detail).length === 0 && rowHash(r, false) === r.hash;
}

// 회사 하나의 감사 줄(seq 오름차순)을 처음부터 따라가며 확인한다.
// fromGenesis=false면 앞부분을 못 읽은 것이라 첫 줄의 prevHash는 믿고 넘어간다 (partial=true)
export function verifyAuditChain(rows: AuditRow[], fromGenesis = true): ChainCheck {
  const base = {
    checked: 0,
    firstSeq: rows[0]?.seq ?? null,
    lastSeq: rows.at(-1)?.seq ?? null,
    partial: !fromGenesis,
  };
  let prev: string | null = fromGenesis ? "genesis" : null;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    if (prev !== null && r.prevHash !== prev) {
      const reason = i === 0 ? "not_from_genesis" : "prev_link_broken";
      return { ...base, ok: false, checked: i, brokenAtSeq: r.seq, reason };
    }
    if (!hashOk(r))
      return { ...base, ok: false, checked: i, brokenAtSeq: r.seq, reason: "hash_mismatch" };
    prev = r.hash;
  }
  return { ...base, ok: true, checked: rows.length, brokenAtSeq: null, reason: null };
}
