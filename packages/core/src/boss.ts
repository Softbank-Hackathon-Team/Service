import { PgBoss } from "pg-boss";
import type { Tx } from "./db.js";
import { QUEUES, JOB_SCHEMAS, type QueueName } from "@svc/contracts";
import { envNumber, tfBudget } from "@svc/contracts";
import { createLogger } from "./obs/log.js";

export const LISTEN_NOTIFY = process.env.BOSS_LISTEN_NOTIFY === "1";
// Z49: 워커 큐 확인 간격(초). pg-boss 최소값이 0.5라 그보다 작게 줄 수 없다. 기본 0.5 = 예전 값
export const WORKER_POLL_SEC = Math.max(0.5, envNumber(process.env.WORKER_POLL_SEC, 0.5) || 0.5);
// NOTIFY 를 켜는 큐 = 이전 단계 큐(워커 main 이 workOptions()로 받는 큐)만.
// 주의: notify 큐를 workOptions() 없이 boss.work 하면 pg-boss 가 백업 폴링을 30초로 늘린다 →
//   시작 시각이 미래인 작업(cleanup 의 롤백 창, Z19 재시도 대기 retryDelay)이 30초 늦게 집힌다
//   (Z49 시험에서 재현: plans.it 롤백 창 → completed 시간 초과). 그래서 agent-run·lease-reaper·idempotency-cleanup 은 넣지 않았다
export const NOTIFY_QUEUES: ReadonlySet<string> = new Set([
  QUEUES.import, QUEUES.precheck, QUEUES.plan, QUEUES.apply, QUEUES.deploy,
  QUEUES.sync, QUEUES.shift, QUEUES.cutover, QUEUES.cleanup, QUEUES.rollback,
]);
// 워커 boss.work() 옵션. NOTIFY를 켜도 "느슨한 백업 폴링"(pg-boss 기본 30초)으로 바꾸지 않고 같은 간격을 쓴다.
// 이유: 시작 시각이 미래인 작업(cleanup·재시도)은 NOTIFY가 안 오므로 폴링으로만 집힌다
// Z32 7a (Z6-3): 워커는 작업 1건 끝낼 때마다 확인 간격(0.5초)을 쉬어서 큐마다 초당 2건이 상한이었다.
//   cleanup 고아 500건(시험 찌꺼기)이 쌓이면 새 이전의 cleanup 이 250초 줄을 서 rollback_window 에 머물렀다(VM 재현).
//   이제 대기 건수가 WORKER_BURST_READY(기본 1)를 넘으면 쉬지 않고 바로 다음 건을 집는다(pg-boss burstWhenReadyExceeds). 0 이면 끔
export const WORKER_BURST_READY = envNumber(process.env.WORKER_BURST_READY, 1);
export function workOptions() {
  return { pollingIntervalSeconds: WORKER_POLL_SEC, notifyPollingIntervalSeconds: WORKER_POLL_SEC,
           ...(WORKER_BURST_READY >= 1 ? { burstWhenReadyExceeds: Math.floor(WORKER_BURST_READY) } : {}) };
}

export const boss = new PgBoss({
  connectionString: process.env.DATABASE_URL,
  schema: "pgboss",
  // 스키마는 DB 초기화 SQL이 app_user 소유로 미리 만든다.
  // 앱 계정에 DB 전체 생성 권한을 주지 않기 위해서다
  createSchema: false,
  // Z32: 죽은 워커 찾기 주기. pg-boss 기본 60초 → 5초. 작업 생존 신호(heartbeatSeconds)가 끊긴 작업을 이 주기마다 재시도/실패로 돌린다
  // DRAFT(ai): 프로세스마다 5초에 작은 쿼리 몇 개. 비우면 5초
  superviseIntervalSeconds: Number(process.env.BOSS_SUPERVISE_SEC) || 5,
  monitorIntervalSeconds: Number(process.env.BOSS_SUPERVISE_SEC) || 5,
  // Z32 7a: 큐 대기 건수(readyCount) 캐시 주기. 아래 workOptions 의 burst 판단이 이 값을 본다. pg-boss 기본 60초 → 5초
  queueCacheIntervalSeconds: Number(process.env.BOSS_SUPERVISE_SEC) || 5,
  // Z49 DRAFT(ai): BOSS_LISTEN_NOTIFY=1 이면 작업이 들어오는 순간(트랜잭션 확정 때) 워커를 깨운다.
  // 끄면(기본) 예전처럼 폴링만. 켜도 폴링은 그대로 돌아서(workOptions) 늦어지는 경우는 없다.
  // 대가: 프로세스마다 LISTEN 전용 DB 연결 1개. PgBouncer transaction 모드 뒤에서는 안 된다(경고 후 폴링만)
  useListenNotify: LISTEN_NOTIFY,
});
// Z81-05 (PROPOSALS P6): pg-boss 오류도 다른 줄과 같은 JSON 한 줄로 (core obs/log.ts). 예전 console.error 는 여러 줄 글자라
//   로그 검색(level=error, component=pg-boss)으로 못 찾았다. 오류는 type·message·code 만 (stack 은 LOG_LEVEL=debug 일 때)
// 【사실, Node.js events 문서 "Error events"】 error 처리기가 없는 EventEmitter 가 error 를 내면 프로세스가 죽는다. pg-boss README 첫 예제도 on("error") 를 단다 → 처리기는 그대로, 찍는 모양만 바꿈
const bossLog = createLogger(process.env.SERVICE_NAME ?? "svc", { component: "pg-boss" });
boss.on("error", (err) => bossLog.error({ err }, "pg-boss error"));

// 큐 정책은 이 표 한 곳에서만 정한다
// Z19 H4: 예전엔 deploy·sync·shift·cutover·cleanup·rollback이 표에 없어 "1번 재시도, 대기 0초"(pg-boss 기본)였다.
// 이제 모든 이전 단계 큐를 적는다. 재시도를 다 쓰면 워커 runStep이 이전을 failed/paused로 옮긴다(죽은 작업 처리)
// expireInSeconds: 처리기가 이 시간 안에 안 끝나면 pg-boss가 작업을 만료(실패) 처리한다. 기본 900초(15분)
export interface QueuePolicy { policy: "stately" | "singleton"; retryLimit: number; retryDelay?: number; retryBackoff?: boolean; expireInSeconds?: number; heartbeatSeconds?: number; notify?: boolean }
export const POLICY: Record<string, QueuePolicy> = {
  // PF-A4 DRAFT(ai): 가져오기 일시 오류(SOURCE_TRANSIENT: API 연결 끊김·스로틀링)는 재시도. 예전엔 대기 0초라 첫 호출(sts)에서 끊기면 몇 초 안에 4번을 다 쓰고 failed.
  //   10초부터 늘려 기다린다(10·20·40초 언저리) → 1분 남짓의 끊김을 넘긴다. 영구 오류(SOURCE_UNAVAILABLE·INCOMPLETE)는 처리기가 바로 failed 라 안 기다림
  [QUEUES.import]: { policy: "stately", retryLimit: 3, retryDelay: 10, retryBackoff: true },
  [QUEUES.precheck]: { policy: "stately", retryLimit: 2 },
  [QUEUES.plan]: { policy: "stately", retryLimit: 2 },
  // G7-1: 계획 만료 깨우기. 작업 키 = plan-expiry:<계획 번호> (다시 계획하면 새 키). 실패해도 다음 승인 시도가 stale 로 옮긴다
  [QUEUES.planExpiry]: { policy: "stately", retryLimit: 2, retryDelay: 30 },
  // G5-1 DRAFT(ai): terraform destroy 는 여러 번 불러도 안전(state 에 있는 것만). 잠깐 실패(잠금·네트워크)를 넘기게 2번 더, 1분 뒤. 만료 1시간(RDS 삭제가 10분+)
  // PF RV-09: 기한 = terraform 지우기 예산 + 정지 유예 + 여유 (contracts tfBudget). 재시도는 처리기가 직접 늦춰 다시 넣는다 (PF FM-ORC-12·25)
  [QUEUES.targetDestroy]: { policy: "stately", retryLimit: 2, retryDelay: 60, expireInSeconds: tfBudget().destroyExpireSec },
  // F8-5 DRAFT(ai): 걷기는 여러 번 불러도 안전. 연결이 잠깐 안 될 때만 넘기는 정도
  [QUEUES.replCleanup]: { policy: "stately", retryLimit: 2, retryDelay: 30 },
  // M8 DRAFT(ai): 진짜 Terraform apply(EKS·RDS 생성)는 15분을 넘기 쉽다 → 1시간. 대안 "apply를 여러 작업으로 쪼개기"는 범위가 커서 버림.
  // TODO(human): 실행기(packages/adapters runner)에 대기 상한이 아직 없다. 넣는다면 이것보다 짧게. 값은 실측 apply 시간으로 확정
  // Z32: retryLimit 1 = "앞 시도가 일을 시작하기 전에 워커가 죽었을 때만" 한 번 더 (START_ONLY_RETRY). 처리기 예외는 예전처럼 재시도 없음
  // PF RV-09: 1시간 고정이면 init·plan·apply 단계 상한 합 + 실패 즉시 지우기가 기한을 넘었다 → tfBudget 합 (기본 7200초)
  [QUEUES.apply]: { policy: "stately", retryLimit: 1, expireInSeconds: tfBudget().applyExpireSec },
  // DRAFT(ai) Z19: 아래 대기는 초. 바깥 시스템(Argo·LB)이 잠깐 안 될 때를 넘기는 정도
  [QUEUES.deploy]: { policy: "stately", retryLimit: 2, retryDelay: 10 },
  // sync는 pg-boss 재시도를 안 쓴다: 처리기가 5·15·45초 간격으로 스스로 다시 넣는다(SYNC_RETRY_DELAYS_SEC). 0 = 예상 못 한 예외는 바로 죽은 작업 처리
  [QUEUES.sync]: { policy: "stately", retryLimit: 1 },     // Z32: 위 apply 와 같은 뜻 (START_ONLY_RETRY)
  // shift는 판정 도중 상태를 다시 읽고 시작하므로 한 번 더 해도 안전 (지표 오류는 컨트롤러 안에서 처리)
  // F8-6 DRAFT(ai): 만료 1시간. 기본 900초면 관찰 시간(TRAFFIC_OBSERVE_SEC)을 분 단위로 올린 shift 가 15분을 넘겨 만료·재시도 → 같은 워커가 둘을 돌렸다.
  //   단계 3개 × 관찰 + 재관찰·hold 여유. 같은 주인 다른 작업 번호의 잠금 인수 거부(envlock.ts)가 두 번째 방어
  [QUEUES.shift]: { policy: "stately", retryLimit: 1, retryDelay: 5, expireInSeconds: 3600 },
  // H2: 반쯤 한 컷오버는 재시도하지 않는다. 처리기 onError가 failed로 보낸다
  [QUEUES.cutover]: { policy: "stately", retryLimit: 1 },  // Z32: 위 apply 와 같은 뜻 (START_ONLY_RETRY)
  [QUEUES.cleanup]: { policy: "stately", retryLimit: 3, retryDelay: 10, retryBackoff: true },
  // Z1 ROLLBACK_MAX_ATTEMPTS(기본 2) = 첫 시도 + 이 1번. 바꾸면 같이 바꾼다
  [QUEUES.rollback]: { policy: "stately", retryLimit: 1, retryDelay: 5 },
  // DRAFT(ai): 빌드는 실패하면 같은 입력으로 다시 해도 같다 → pg-boss 재시도 없음(실패하면 apply 단계가 failed 로 보냄). 빌드 시간 상한 30분
  [QUEUES.imageBuild]: { policy: "stately", retryLimit: 0, expireInSeconds: 1800 },
  // PF03 FM-NET DRAFT(ai): 재시도 5·10·20초 (예전 대기 0 → 몇 초 끊김에 4번을 다 쓰고 PLATFORM_ERROR). 마지막 시도 예외는 처리기가 failed 로 닫음
  [QUEUES.verifyConnection]: { policy: "stately", retryLimit: 3, retryDelay: 5, retryBackoff: true },
  // 재시도하면 LLM 비용이 또 든다. 실패하면 사람이 다시 실행한다
  [QUEUES.agentRun]: { policy: "stately", retryLimit: 0 },
  [QUEUES.leaseReaper]: { policy: "singleton", retryLimit: 0 },
  [QUEUES.idempotencyCleanup]: { policy: "singleton", retryLimit: 0 },
  [QUEUES.verifySweep]: { policy: "singleton", retryLimit: 0 },   // L4b: 다음 일정이 다시 훑는다
  // 리허설 격리 = 전용 샌드박스 노드에 회사 하나씩. singleton + 모든 작업이 같은 키(KEY_BY)라 실행 중 1건이 pg-boss 고유 인덱스로 막힌다
  //   (agent-worker 를 몇 개 띄워도, localConcurrency 를 올려도 같다). 대기는 줄 수 제한 없음
  // DRAFT(ai): 동시 1건 (샌드박스 노드 1대). 재시도 없음(워커가 기한 뒤 REHEARSAL_TIMEOUT), 만료 30분, 생존 신호 10초(STEP_HEARTBEAT_SEC 와 같은 값)
  //   생존 신호가 없으면 죽은 agent-worker 의 작업이 만료(30분)까지 자리를 쥐어 뒤 리허설이 모두 기한을 넘긴다
  [QUEUES.sandboxRehearsal]: { policy: "singleton", retryLimit: 0, expireInSeconds: 1800, heartbeatSeconds: 10 },
  // #242 DRAFT(ai): 재시도 없음 (못 읽으면 그 이유를 결과로 저장하고, 다음 화면 요청이 다시 넣는다). 명령 시간 초과 합이 1분 안쪽이라 5분이면 충분
  [QUEUES.inventoryRefresh]: { policy: "stately", retryLimit: 0, expireInSeconds: 300 },
};

// Z32 (Z6-2): 워커가 kill -9 로 죽으면 쥐고 있던 작업이 expireInSeconds(기본 900초, apply 3600초) 동안 active로 남았다.
// Z36 청소 작업은 우리 잠금 기한(90초) 뒤에야 오고, 잠금 없는 단계(import·precheck·plan)는 아예 못 본다.
// 이제 이전 단계 큐는 pg-boss 작업 생존 신호를 쓴다: 처리기가 도는 동안 pg-boss가 5초마다 알리고, 10초 소식이 없으면
// 감시(위 5초 주기)가 작업을 재시도(retryLimit 남음) 또는 실패로 돌린다. 산 워커의 긴 작업(apply 1시간)은 계속 알리므로 안 끊긴다
// DRAFT(ai): 10초 (pg-boss 최소값). 재시도는 runStep이 죽은 앞 시도의 환경 잠금을 같은 작업 번호로 넘겨받는다(envlock.ts)
export const STEP_HEARTBEAT_SEC = 10;
export const STEP_QUEUES: readonly string[] = [
  QUEUES.import, QUEUES.precheck, QUEUES.plan, QUEUES.apply, QUEUES.deploy, QUEUES.sync,
  QUEUES.shift, QUEUES.cutover, QUEUES.cleanup, QUEUES.rollback,
];
// Z32: 처리기 예외는 재시도하지 않는 단계. retryLimit 1 은 "앞 시도가 잠금을 잡기 전(= 일을 시작하기 전)에 워커가 죽었을 때"만 쓴다.
// 앞 시도가 일을 시작했으면 재시도는 아무것도 안 하고(job.rejected) Z36 청소 작업에 맡긴다: 잠금 기한 뒤 WORKER_LOST + 컷오버 울타리 복구(Q17)
// 예전(retryLimit 0): 잠금 잡기 전에 죽으면 잠금이 reserved로 남아 apply는 계획 만료(2시간), 그 밖은 반납 기한(10분) 뒤 JOB_NOT_PICKED
export const START_ONLY_RETRY: ReadonlySet<string> = new Set([QUEUES.apply, QUEUES.sync, QUEUES.cutover]);
// Z32 (Z62 #38, 맥 int5-4 kill 실측): 워커 1개는 큐마다 한 번에 1건만 돈다. shift 1건 = 트래픽 관찰(기본 30초) × 단계 수라
//   50건이 몰리면 워커 2개로 50÷2×30초 = 12.5분 → 반납 기한(10분)을 넘겨 청소가 JOB_NOT_PICKED로 paused 시켰다.
// 이제 shift 큐만 워커 하나가 한 번에 5건까지 (pg-boss localConcurrency = 같은 큐를 집는 루프 5개, 작업마다 성공·실패·생존 신호가 따로).
//   batchSize 는 쓰지 않는다: 한 처리기가 여러 건을 받으면 한 건 실패를 따로 표시하기 어렵다
// DRAFT(ai): 5 (Cloudflare API 429 우려로 10 아닌 5부터). SHIFT_CONCURRENCY 로 바꿀 수 있다. 다른 큐는 1 그대로
// G9-5 DRAFT(ai): 나머지 이전 단계 큐도 워커 하나가 4건까지 (STEP_CONCURRENCY). 예전 1건이면 한 회사의 45분 apply 가
//   다른 회사 apply·deploy 를 전부 세워 1시간 넘게 밀리고 청소가 JOB_NOT_PICKED 로 멈췄다. 같은 이전은 stately 작업 키라 여전히 1건씩
const STEP_CONCURRENCY = Math.max(1, Number(process.env.STEP_CONCURRENCY) || 4);
export const WORK_CONCURRENCY: Readonly<Record<string, number>> = {
  [QUEUES.shift]: Math.max(1, Number(process.env.SHIFT_CONCURRENCY) || 5),
  // Z32 7a: cleanup 도 5. 같은 이전의 cleanup 은 stately 작업 키라 동시에 1건만 돈다. 쌓인 대기(고아 500건)를 5배 빨리 비운다
  [QUEUES.cleanup]: Math.max(1, Number(process.env.CLEANUP_CONCURRENCY) || 5),
  [QUEUES.import]: STEP_CONCURRENCY, [QUEUES.precheck]: STEP_CONCURRENCY, [QUEUES.plan]: STEP_CONCURRENCY,
  [QUEUES.apply]: STEP_CONCURRENCY, [QUEUES.deploy]: STEP_CONCURRENCY, [QUEUES.sync]: STEP_CONCURRENCY,
  [QUEUES.cutover]: STEP_CONCURRENCY, [QUEUES.rollback]: STEP_CONCURRENCY,
  // #242 DRAFT(ai): 조회 한 건이 최대 18초쯤 걸려(명령 시간 초과 8초 + 10초) 1건씩이면 환경이 많을 때 화면이 밀린다. 같은 환경은 작업 키로 1건씩
  [QUEUES.inventoryRefresh]: STEP_CONCURRENCY,
};
export const concurrencyOf = (name: string): number => WORK_CONCURRENCY[name] ?? 1;
// G9-5 DRAFT(ai): 회사 공평 배분. 이전 단계 작업은 group = 회사 번호로 넣고(advance enqueueNext), 큐마다 한 회사가 동시에
//   TENANT_QUEUE_SHARE(기본 2)건까지만 돈다 (pg-boss groupConcurrency = 모든 워커 합산, DB 로 셈). 0 이면 끔.
//   한 회사가 이전을 몰아넣어도 다른 회사 작업이 자리를 얻는다. 그룹이 없는 옛 작업은 제한 없음
export const TENANT_QUEUE_SHARE = Math.max(0, Math.floor(envNumber(process.env.TENANT_QUEUE_SHARE, 2)));
export const tenantGroup = (queue: string, tenantId: string | undefined) =>
  TENANT_QUEUE_SHARE > 0 && tenantId && STEP_QUEUES.includes(queue) ? { group: { id: tenantId } } : {};
/** 단계 큐 boss.work 옵션 (워커 main). 회사 몫이 켜져 있으면 groupConcurrency 를 얹는다 */
export function stepWorkOptions(queue: string) {
  return { ...workOptions(), localConcurrency: concurrencyOf(queue),
    ...(TENANT_QUEUE_SHARE > 0 && STEP_QUEUES.includes(queue) ? { groupConcurrency: TENANT_QUEUE_SHARE } : {}) };
}
export const policyOf = (name: string): QueuePolicy => {
  const p = POLICY[name] ?? { policy: "stately", retryLimit: 1 };
  return STEP_QUEUES.includes(name) ? { heartbeatSeconds: STEP_HEARTBEAT_SEC, ...p } : p;
};

export async function startBoss() {
  await boss.start();
  for (const name of Object.values(QUEUES)) {
    // Z49: notify 는 작업을 넣을 때 pg_notify 를 같이 보낼지. 끄면 false 로 덮어써 예전 DB에 남은 값도 지운다
    // Z32: policyOf 가 단계 큐에 heartbeatSeconds 를 얹는다
    const p = { ...policyOf(name), notify: LISTEN_NOTIFY && NOTIFY_QUEUES.has(name) };
    await boss.createQueue(name, p);
    // Z19 H4: 이미 만들어진 큐(맥의 기존 DB)는 createQueue가 설정을 안 바꾼다 → 재시도 설정만 맞춘다 (policy는 바꿀 수 없음)
    const { policy: _p, ...retry } = p;
    await boss.updateQueue(name, { retryDelay: 0, retryBackoff: false, ...retry });
  }
}

// 같은 트랜잭션 연결을 pg-boss에 넘긴다 (안 넘기면 트랜잭션 밖으로 들어간다)
export function asBossDb(tx: Tx) {
  return {
    executeSql: (text: string, values?: unknown[]) =>
      tx.query(text, values as unknown[]),
  };
}

// 큐 작업 멱등성 1: 같은 작업 키(singletonKey). stately 큐에서 키마다 "대기 1 + 실행 1"까지만 들어간다.
// 같은 키가 이미 대기 중이면 send()가 null → advance()가 JobNotCreated로 트랜잭션 전체를 취소한다.
// 근거: api-orchestrator-v1 6.3 큐 정책 표. 환경 단위 키는 같은 환경에 계획·실행이 겹치지 않게 한다
export interface JobKeyIds { migrationId?: string; targetEnvId?: string; envId?: string; agentRunId?: string }
const KEY_BY: Partial<Record<QueueName, (i: JobKeyIds) => string | undefined>> = {
  "import": (i) => i.migrationId,
  "precheck": (i) => i.migrationId,
  // Z43 F3: 예전엔 여기가 도착 환경(plan:<envId>)인데 실제로 plan 작업을 넣는 유일한 곳(precheck)이 plan:<이전>으로 덮어썼다.
  //   큐에 쌓인 작업이 다 plan:<이전>이라 그쪽으로 맞춘다. 같은 환경에 계획이 겹치는 건 승인 때 환경 잠금 예약(ENV_BUSY)이 막는다
  "plan": (i) => i.migrationId,
  // G7-1: 계획마다 하나 (넣는 쪽이 singletonKey 를 plan-expiry:<계획 번호>로 준다). 여기 값은 그게 없을 때만
  "plan-expiry": (i) => i.migrationId,
  "apply": (i) => i.targetEnvId,
  "verify-connection": (i) => i.envId,
  "inventory-refresh": (i) => i.envId,
  "security-scan": (i) => i.envId,
  "agent-run": (i) => i.agentRunId,
  // DRAFT(ai): 샌드박스 노드 하나 = 키 하나 (위 POLICY 의 동시 1건). 노드를 늘리면 노드마다 키를 나누고 vCluster 를 그 노드에 묶는다
  "sandbox-rehearsal": () => "sandbox-node",
};
export function jobKey(queue: QueueName, ids: JobKeyIds): string | undefined {
  const k = (KEY_BY[queue] ?? ((i: JobKeyIds) => i.migrationId))(ids);
  return k ? `${queue}:${k}` : undefined;
}

// 큐 작업 멱등성 2: 넣는 쪽에서도 작업 내용 모양을 본다 (받는 쪽은 다시 본다)
export function parseJobData(queue: QueueName, data: unknown): unknown {
  const s = (JOB_SCHEMAS as Record<string, { parse(x: unknown): unknown } | undefined>)[queue];
  return s ? s.parse(data) : data;
}
