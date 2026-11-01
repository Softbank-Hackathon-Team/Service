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
