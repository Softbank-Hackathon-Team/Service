import { boss, startBoss, startMetricsServerNear, workOptions, stepWorkOptions, LISTEN_NOTIFY } from "@svc/core";
import { HANDLERS } from "./jobs/index.js";
import { jobAttempt } from "./jobs/_step.js";
import { registerLeaseJobs } from "./lease/index.js";
import { registerVerifySweep } from "./jobs/verify-sweep.js";
import { instrument, log, workerRegistry } from "./instrument.js";
import { startTempRoleSweeper } from "./platform.js";
import { gitopsPreflight } from "./gitops/index.js";
import { onShutdown } from "@svc/core";
import { assertConfig, logEffectiveConfig } from "@svc/core";
import { envNumber } from "@svc/contracts";
import { createRealTerraformRunner, iacMockEnabled } from "@svc/adapters";

// Z81-09: 설정을 먼저 본다. 틀리면 목록을 내고 끝 코드 2 (지표 포트·큐를 열기 전)
assertConfig("worker");
// Z81-10: 실제로 쓰는 설정 값 5개를 한 줄로 (rehearse 가 이 줄을 본다)
logEffectiveConfig("worker");

// 워커 지표(작업 수·작업 시간). DB 집계 지표는 api 쪽 /metrics 에서 한 번만 낸다 (두 군데서 내면 합칠 때 두 배)
// DRAFT(ai): 기본 9465. 0 이면 열지 않는다
// Z36 (Z12-2): 작업 등록(boss.work)보다 먼저 연다. 예전엔 작업을 집은 뒤 listen이 EADDRINUSE로 죽어 그 작업이 "일하다 죽은 것"이 됐다.
//   포트가 차 있으면 다음 포트(최대 10개), 다 차면 지표만 끄고 계속 돈다
const WANT_PORT = envNumber(process.env.WORKER_METRICS_PORT, 9465);
let METRICS_PORT = 0;
if (WANT_PORT > 0) {
  const m = await startMetricsServerNear(workerRegistry, WANT_PORT,
    { onBusy: (p) => log.warn({ port: p }, "metrics port in use, trying next") });
  if (m) METRICS_PORT = m.port;
  else log.warn({ port: WANT_PORT }, "metrics server not started (ports busy): worker runs without /metrics");
}

// Z38 REVIEW-6 R6-2: GitOps 를 켰는데 git 이 없으면(WITH_GIT=0 이미지) 작업을 집기 전에 멈춘다. 작업마다 실패·롤백 불가보다 낫다
{
  const p = await gitopsPreflight();
  if (p) { log.error({ reason: p }, "worker not started: gitops preflight failed"); process.exit(1); }
}

// Z89: 도착 자원은 기본이 진짜 terraform. 실행 파일이 없으면 기동은 하되 크게 알린다 (apply 가 TF_BIN_MISSING 으로 failed 된다).
//   대안 "기동 거부": 버림. prod 이미지에는 terraform 이 없고, Azure Mock·롤백·복제 작업은 terraform 없이 돈다
if (!iacMockEnabled()) {
  const v = await createRealTerraformRunner().version();
  if (v.ok) log.info({ terraform: v.version }, "iac: real terraform (MOCK_IAC=1 이 아님)");
  else log.error({ reason: v.error }, "iac: real terraform 인데 실행 불가 → aws/gcp/onprem apply 는 TF_BIN_MISSING 으로 실패한다. 시험이면 MOCK_IAC=1");
} else log.warn("iac: MOCK_IAC=1 → 도착 자원 흉내 (시험 전용)");

await startBoss();
// 큐 이름 → 처리 함수. 새 작업은 jobs/ 에 파일 하나 + jobs/index.ts에 한 줄
// DRAFT(ai): 큐 확인 간격 0.5초 (pg-boss 기본 2초면 단계 9개가 smoke에서 너무 느리다). Z49: WORKER_POLL_SEC 로 바꿀 수 있다(최소 0.5)
// Z49: BOSS_LISTEN_NOTIFY=1 이면 새 작업이 들어오는 즉시 깨어난다 (단계마다 평균 0.3초 대기가 사라짐, docs/PERF.md)
for (const [queue, handle] of Object.entries(HANDLERS)) {
  const run = instrument(queue, handle);
  // Z19 H4: 몇 번째 시도인지(retryCount/retryLimit)를 처리기에 알린다. 마지막 시도가 실패하면 runStep이 이전을 failed/paused로 옮긴다
  // Z32 (Z62 #38): shift 만 localConcurrency 5 (boss.ts WORK_CONCURRENCY). 처리기는 그대로 한 번에 1건을 받는다
  await boss.work(queue, { ...stepWorkOptions(queue), includeMetadata: true }, async ([job]) => {
    await jobAttempt.run({ queue, retryCount: job!.retryCount, retryLimit: job!.retryLimit }, () => run(job!));
  });
}
await registerLeaseJobs(); // 생존 신호·청소 작업
await registerVerifySweep(); // L4b: 연결 주기 재확인 (VERIFY_CRON, 기본 1시간)
startTempRoleSweeper();    // 임시 자격 만료·회수 요청 처리 (보안)

log.info({ queues: Object.keys(HANDLERS), metrics_port: METRICS_PORT, poll_sec: workOptions().pollingIntervalSeconds, listen_notify: LISTEN_NOTIFY }, "worker ready");

// 종료 신호: 쥔 작업을 끝까지 기다린 뒤 큐를 닫는다 (pg-boss stop graceful, 기본 대기 30초).
// Z81: SIGINT(Ctrl+C)도 같은 길. 두 번째 신호는 바로 끝낸다. 처리는 core shutdown.ts 한 곳
onShutdown([["boss", () => boss.stop({ graceful: true })]], { log });
