// API 프로세스에도 청소 담당(lease-reaper) 한 벌 (설명서 7장 "두 곳에서 돌아도 한 번").
// 워커가 전부 죽으면 워커 안의 청소 담당도 같이 죽는다. 청소 작업은 pg-boss 스케줄(DB에 저장)이라 계속 생기므로,
// api 도 같은 큐를 받으면 대신 처리한다. 작업 하나는 한 소비자에게만 가고, 이동은 ifStill 이라 겹쳐도 한 번만 적용된다.
// DRAFT(ai): 깃발 API_REAPER=1 일 때만 켠다 (기본 off = 지금 동작 그대로). 팀 합의 전
// DRAFT(ai): 청소 코드는 apps/worker 안에 있다. api 운영 이미지는 apps/worker 를 담지 않으므로 번들에 끌려 들어가지 않게
//   경로를 변수로 불러온다(개발·tsx 실행에서만 동작). TODO(human): 이미지에서도 켜려면 청소 코드를 공용 패키지로 옮길지 결정
export interface LeaseJobs { registerLeaseJobs: () => Promise<void> }
export type LeaseLoader = () => Promise<LeaseJobs>;

const WORKER_LEASE = "../../worker/src/lease/index.js";
const defaultLoader: LeaseLoader = async () => (await import(WORKER_LEASE)) as LeaseJobs;

/** 켰으면 true. 못 불러와도 api 는 계속 뜬다(로그만) */
export async function startApiReaper(
  o: { env?: NodeJS.ProcessEnv; load?: LeaseLoader; log?: { info: (m: string) => void; error: (m: string) => void } } = {},
): Promise<boolean> {
  const env = o.env ?? process.env;
  if (env.API_REAPER !== "1") return false;
  const log = o.log ?? { info: console.log, error: console.error };
  try {
    await (o.load ?? defaultLoader)().then((m) => m.registerLeaseJobs());
    log.info("[api] lease-reaper on (API_REAPER=1)");
    return true;
  } catch (e) {
    log.error(`[api] lease-reaper not started: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}
