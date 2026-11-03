import { QUEUES, VerifyConnectionJob } from "@svc/contracts";
import { boss, jobKey, listVerifyDue } from "@svc/core";

// L4b: 연결 주기 재확인 (설계 IA 6.1 5단계). pg-boss schedule 은 cron·고정 내용이라 환경마다 못 낸다 (lease/reaper.ts 와 같은 방식)
//   → 일정 하나가 verify-sweep 을 내고, 훑기가 환경마다 verify-connection{reason:"periodic"} 을 넣는다.
//   상태는 여기서 안 바꾼다 (주기 재확인은 verifying 으로 안 옮김. 판정·기록은 verify-connection 처리기의 nextAfterPeriodic)
// 같은 환경 작업이 이미 대기 중이면 singletonKey 로 안 들어간다 (send → null, 오류 아님)

// DRAFT(ai): 1시간마다 정각 (설계 "1시간마다"). 데모는 VERIFY_CRON 으로 줄인다 (예: "* * * * *")
export const verifyCron = (env: NodeJS.ProcessEnv = process.env) => env.VERIFY_CRON?.trim() || "0 * * * *";
// DRAFT(ai): 한 번에 500개 (넘치면 다음 일정에 오래된 것부터)
export const VERIFY_SWEEP_MAX = 500;

export async function handleVerifySweep(o: { maxRows?: number; now?: Date } = {}): Promise<{ due: number; queued: number }> {
  const due = await listVerifyDue(o.maxRows ?? VERIFY_SWEEP_MAX);
  const requestId = `verify-sweep:${(o.now ?? new Date()).toISOString()}`;
  let queued = 0;
  for (const d of due) {
    const data = VerifyConnectionJob.parse({ tenantId: d.tenantId, envId: d.envId, requestId, reason: "periodic" });
    const key = jobKey(QUEUES.verifyConnection, { envId: d.envId });
    const id = await boss.send(QUEUES.verifyConnection, data, key ? { singletonKey: key } : {});
    if (id) queued++;
  }
  return { due: due.length, queued };
}

// 워커 main.ts 에서 한 줄로: await registerVerifySweep();
export async function registerVerifySweep(env: NodeJS.ProcessEnv = process.env) {
  // DRAFT(ai): VERIFY_CRON=off 면 일정을 지운다 (시험·로컬에서 끄기)
  if (env.VERIFY_CRON?.trim() === "off") { await boss.unschedule(QUEUES.verifySweep); return; }
  await boss.schedule(QUEUES.verifySweep, verifyCron(env));
  await boss.work(QUEUES.verifySweep, async () => {
    const r = await handleVerifySweep();
    if (r.due) console.log("[verify-sweep]", r);
  });
}
