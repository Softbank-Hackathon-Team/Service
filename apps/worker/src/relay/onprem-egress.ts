// 온프레 클러스터가 밖으로 나가는 공인 IP 읽기: Agent facts 보고의 egressIp 칸 (contracts agent.ts)
//   중계기 보안 그룹이 SSH(22)를 이 IP/32 에만 연다. 워커는 클러스터에 들어가지 않으므로 Agent 보고에서만 얻는다 (pull 방식)
// 보안: 폐기된 Agent 키로 온 보고는 쓰지 않는다 (latestSealingCert 와 같은 규칙). 키가 새면 공격자가 자기 IP 를 보고해 22 를 자기에게 열게 할 수 있다
import { AgentReport, envNumber } from "@svc/contracts";
import type { Tx } from "@svc/core";

export interface OnpremEgress { ip: string; receivedAt: string }

// DRAFT(ai): 최대 나이 = AGENT_FACTS_MAX_AGE_SEC (기본 900초 = Agent facts 주기 300초의 3배, precheck latestAgentFacts 와 같은 값).
//   나가는 IP 는 바뀔 수 있어(공유기 재시작·통신사) 오래된 값으로 22 를 열지 않는다
export async function latestOnpremEgressIp(tx: Tx, tenantId: string, envId: string, env: NodeJS.ProcessEnv = process.env): Promise<OnpremEgress | undefined> {
  const maxAge = envNumber(env.AGENT_FACTS_MAX_AGE_SEC, 900);
  if (!Number.isFinite(maxAge) || maxAge <= 0) return undefined;
  // tenant_id 는 RLS 가 이미 거르지만 같은 조건을 한 번 더 건다 (sealing-cert.ts 와 같음)
  const r = await tx.query(
    `SELECT r.body, r.received_at
       FROM agent_reports r JOIN agent_keys k ON k.id = r.key_id AND k.revoked_at IS NULL
      WHERE r.tenant_id = $1 AND r.env_id = $2 AND r.kind = 'facts' AND r.body ? 'egressIp'
        AND r.received_at > now() - make_interval(secs => $3)
      ORDER BY r.received_at DESC LIMIT 1`, [tenantId, envId, maxAge]);
  const row = r.rows[0];
  if (!row) return undefined;
  const p = AgentReport.safeParse(row.body);
  if (!p.success || p.data.kind !== "facts" || !p.data.egressIp) return undefined;
  return { ip: p.data.egressIp, receivedAt: new Date(row.received_at).toISOString() };
}
