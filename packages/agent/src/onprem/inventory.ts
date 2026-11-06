import { AGENT_INVENTORY_MAX_BYTES, type AgentInventorySnapshot } from "@svc/contracts";
import { collectInventorySnapshot, snapshotBytes, spawnExec, type Exec } from "@svc/adapters";

// 온프레 출발 가져오기 재료 (kind "inventory"). pull 모드에서 플랫폼은 클러스터에 들어올 길이 없다 → Agent 가 안에서 읽어 밖으로 보낸다
//   DECISION(team): 플랫폼은 고객 VM 안으로 들어가지 않는다. 가져오기는 Agent 인벤토리 스냅숏을 재생한다 (온프레 영역 결정, 2026-11-07)
//   무엇을 읽는지는 adapters discover/inventory-snapshot.ts 한 곳 (워커 discover 와 같은 자원 목록). 읽기만 (get·api-resources), Secret 은 안 읽는다
//   kubectl 은 이 파드의 ServiceAccount 토큰으로 붙는다 (권한: deploy/helm/onprem-agent/templates/rbac.yaml grants.inventory)

export class InventoryTooLarge extends Error {
  constructor(public readonly bytes: number) {
    super(`인벤토리 스냅숏이 ${bytes} 바이트로 상한 ${AGENT_INVENTORY_MAX_BYTES} 를 넘어 보내지 않음 (가져오기는 "스냅숏 없음/오래됨"으로 멈춘다)`);
  }
}

export interface InventoryCollectOpts {
  agentVersion: string;
  /** 시험에서 바꿔 끼운다. 기본 = kubectl 자식 프로세스 (셸 없음) */
  exec?: Exec;
  /** 맥에서 k3d 를 볼 때만 (AGENT_KUBE_CONTEXT). 클러스터 안에서는 비운다 */
  context?: string;
  now?: () => Date;
}

/** 스냅숏 모으기. 상한을 넘으면 InventoryTooLarge (보내지 않는다) */
export async function collectInventory(o: InventoryCollectOpts): Promise<AgentInventorySnapshot> {
  const snap = await collectInventorySnapshot({ exec: o.exec ?? spawnExec },
    { agentVersion: o.agentVersion, kube: o.context ? ["--context", o.context] : [], ...(o.now ? { now: o.now } : {}) });
  const bytes = snapshotBytes(snap);
  if (bytes > AGENT_INVENTORY_MAX_BYTES) throw new InventoryTooLarge(bytes);
  return snap;
}
