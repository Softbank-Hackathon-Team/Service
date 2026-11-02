// smoke 가 쓸 출발·도착 환경. SMOKE_TARGET_ENV_ID(예: Azure Mock 4444…, onprem 5555…)·SMOKE_SOURCE_ENV_ID 로 바꾼다
export const DEFAULT_SOURCE_ENV_ID = "22222222-2222-4222-8222-222222222222";
export const DEFAULT_TARGET_ENV_ID = "33333333-3333-4333-8333-333333333333";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function smokeEnvs(env: NodeJS.ProcessEnv = process.env): { sourceEnvId: string; targetEnvId: string } {
  const sourceEnvId = env.SMOKE_SOURCE_ENV_ID?.trim() || DEFAULT_SOURCE_ENV_ID;
  const targetEnvId = env.SMOKE_TARGET_ENV_ID?.trim() || DEFAULT_TARGET_ENV_ID;
  for (const [k, v] of [["SMOKE_SOURCE_ENV_ID", sourceEnvId], ["SMOKE_TARGET_ENV_ID", targetEnvId]] as const)
    if (!UUID.test(v)) throw new Error(`${k} 가 UUID 가 아니다: ${v}`);
  if (sourceEnvId === targetEnvId) throw new Error("출발과 도착 환경이 같다");
  return { sourceEnvId, targetEnvId };
}

// PLAN_ACKS=1 서버용 본문. 확인 항목이 있으면 승인에 acks, 시작에 planHash 를 보낸다. 깃발 꺼짐이면 예전 본문 그대로
export function smokePlanBodies(plan: { planHash: string; acknowledgements?: { id: string }[] }, env: NodeJS.ProcessEnv = process.env): { approve: Record<string, unknown>; start: Record<string, unknown> } {
  const on = env.PLAN_ACKS?.trim() === "1";
  const acks = (plan.acknowledgements ?? []).map((a) => a.id);
  return {
    approve: { decision: "approve", planHash: plan.planHash, ...(on && acks.length ? { acks } : {}) },
    start: on ? { planHash: plan.planHash } : {},
  };
}
