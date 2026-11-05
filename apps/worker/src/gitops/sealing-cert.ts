// 온프레 환경의 sealed-secrets 공개 봉인 인증서 읽기: Agent facts 보고의 sealing 칸 (contracts agent.ts)
//   워커는 클러스터에 들어가지 않는다 → 인증서는 Agent 가 밖으로 보낸 보고에서만 얻는다 (pull 방식)
// 보안: 이 인증서로 봉인한 값은 그 개인 키를 가진 쪽만 푼다. 그래서 폐기된 Agent 키로 온 보고는 쓰지 않는다
//   (키가 새면 공격자가 자기 인증서를 보고해 비밀을 자기 쪽으로 봉인하게 만들 수 있다)
// TODO(human): 인증서가 바뀌었을 때(컨트롤러 키 갱신 = 30일 주기, 또는 바꿔치기) 알림·고정(pinning)을 할지
// 자리: 다른 facts 읽기(latestAgentFacts)는 jobs/precheck.ts 에 있다. 이 작업 범위가 gitops/ 새 파일이라 여기에 두었다 (합칠 때 옮긴다)
import { AgentReport } from "@svc/contracts";
import type { Tx } from "@svc/core";
import { sealingPublicKey } from "./migration-secrets.js";

export interface SealingCert { certPem: string; fetchedAt: string; receivedAt: string }

/**
 * 그 환경에서 sealing 칸이 있는 가장 최근 facts 보고의 인증서. 없거나 모양·인증서가 틀리면 undefined.
 * 나이 제한은 두지 않는다: 컨트롤러는 예전 키를 지우지 않아 예전 인증서로 봉인한 값도 푼다 (만료된 인증서만 거른다)
 */
export async function latestSealingCert(tx: Tx, tenantId: string, envId: string, now: Date = new Date()): Promise<SealingCert | undefined> {
  // tenant_id 는 RLS 가 이미 거르지만 같은 조건을 한 번 더 건다 (withTenant 밖에서 잘못 불려도 남의 회사 보고를 안 읽게)
  const r = await tx.query(
    `SELECT r.body, r.received_at
       FROM agent_reports r JOIN agent_keys k ON k.id = r.key_id AND k.revoked_at IS NULL
      WHERE r.tenant_id = $1 AND r.env_id = $2 AND r.kind = 'facts' AND r.body ? 'sealing'
      ORDER BY r.received_at DESC LIMIT 1`, [tenantId, envId]);
  const row = r.rows[0];
  if (!row) return undefined;
  const p = AgentReport.safeParse(row.body);
  if (!p.success || p.data.kind !== "facts" || !p.data.sealing) return undefined;
  try { sealingPublicKey(p.data.sealing.certPem, now); } catch { return undefined; }
  return { certPem: p.data.sealing.certPem, fetchedAt: p.data.sealing.fetchedAt, receivedAt: new Date(row.received_at).toISOString() };
}
