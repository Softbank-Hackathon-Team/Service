import { AgentInventorySnapshot, envNumber } from "@svc/contracts";
import { withTenant } from "@svc/core";
import { AdapterError, mockSeed, snapshotExec, type CliDeps } from "@svc/adapters";

// 온프레 출발 가져오기 (pull 모드). DECISION(team): 플랫폼은 고객 VM 안으로 들어가지 않는다. Agent 가 보낸 인벤토리 스냅숏으로 discover 를 다시 돌린다 (온프레 영역 결정, 2026-11-07)
//   pull 모드 판단은 apply·사전 점검·인벤토리 화면과 같은 기준 (ONPREM_FLOOR_VIA_GIT≠0). 0 이면 예전처럼 워커가 kubectl --context 로 직접 읽는다 (로컬·개발)
//   MOCK_SEED=1 (시험·e2e) 이면 discover 가 데모 원본을 돌려주므로 스냅숏을 찾지 않는다
export const onpremPullSource = (provider: string, env: NodeJS.ProcessEnv = process.env) =>
  provider === "onprem" && env.ONPREM_FLOOR_VIA_GIT !== "0" && !mockSeed(env);

// DRAFT(ai): 스냅숏 최대 나이 600초. Agent 는 5분(30초 × 10번)마다 보낸다 → 한 번 빠져도 통과, 두 번 빠지면 멈춘다
export const inventoryMaxAgeSec = (env: NodeJS.ProcessEnv = process.env) => Math.max(1, envNumber(env.IMPORT_INVENTORY_MAX_AGE_SEC, 600) || 600);

/** 마지막 스냅숏 줄 → discover 의 CliDeps. 없음·오래됨·모양 틀림이면 이유를 들고 멈춘다 (가짜 값으로 가져오지 않는다) */
export function snapshotDeps(row: { age: number; body: unknown } | undefined, maxAgeSec: number): CliDeps {
  if (!row) throw new AdapterError("SOURCE_UNAVAILABLE",
    "출발 환경을 읽을 수 없음: 온프레 Agent 인벤토리 스냅숏이 아직 없음 — Agent 가 인벤토리를 보내는 판인지(이미지 판, 설치 차트 grants.inventory) 확인하고 다음 보고(약 5분 주기)를 기다린 뒤 다시 가져온다");
  if (row.age > maxAgeSec) throw new AdapterError("SOURCE_UNAVAILABLE",
    `출발 환경을 읽을 수 없음: 마지막 온프레 Agent 인벤토리 스냅숏이 ${row.age}초 전 것 (상한 ${maxAgeSec}초) — Agent 가 살아 있는지(하트비트) 확인하고 다음 보고를 기다리거나 Agent 를 재시작한 뒤 다시 가져온다`);
  const snap = AgentInventorySnapshot.safeParse(row.body);
  if (!snap.success) throw new AdapterError("SOURCE_UNAVAILABLE", "출발 환경을 읽을 수 없음: 온프레 Agent 인벤토리 스냅숏 모양이 계약과 안 맞음 — Agent 이미지를 플랫폼과 같은 판으로 바꾼다");
  return { exec: snapshotExec(snap.data) };
}

/** 출발 환경의 마지막 스냅숏 (회사 벽 안). 폐기된 키로 온 보고는 쓰지 않는다 (하트비트·facts 와 같은 기준). 나이는 받은 시각(DB 시계) 기준 */
export async function onpremSnapshotDeps(tenantId: string, envId: string, env: NodeJS.ProcessEnv = process.env): Promise<CliDeps> {
  const row = await withTenant(tenantId, async (tx) => (await tx.query<{ age: number; body: unknown }>(
    `SELECT GREATEST(0, floor(extract(epoch FROM now() - r.received_at)))::int AS age, r.body
       FROM agent_reports r JOIN agent_keys k ON k.id = r.key_id AND k.revoked_at IS NULL
      WHERE r.env_id = $1 AND r.kind = 'inventory' ORDER BY r.received_at DESC LIMIT 1`, [envId])).rows[0]);
  return snapshotDeps(row, inventoryMaxAgeSec(env));
}
