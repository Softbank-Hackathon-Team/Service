// 실패 사유(failure_code) 한 곳 목록 (Z43). migrations.failure_code 칸과 감사 detail.failureCode에 들어가는 값.
// 예전엔 처리기·리퍼·컨트롤러에 문자열로 흩어져 있어 화면·보고서가 어떤 값이 올지 몰랐다.
// 새 사유는 여기 한 줄 + 그 사유를 내는 곳. 시험 failure-codes.test.ts가 워커·코어 소스의 리터럴이 이 목록에 있는지 본다.
// NOTE(Z43): 공유 파일이라 contracts로 옮기는 건 proposals/로 (화면·API 응답 스키마에서 z.enum으로 쓰려면 contracts에 있어야 한다)
export const FAILURE_CODES = [
  // 공통 (advance·리퍼)
  "UNSPECIFIED",                 // → failed 인데 사유를 안 넘김 (advance 기본값)
  "WORKER_LOST",                 // 리퍼: 워커가 쥔 잠금 기한이 지남
  "JOB_NOT_PICKED",              // 리퍼: 예약 잠금 기한이 지나도록 작업을 아무도 안 집음
  "STEP_FAILED",                 // 리퍼: 집혔다가 실패하고 반납한 뒤 기한 지남 (Z36 Z12-6)
  // 단계별 (워커 처리기)
  "IMPORT_FAILED",               // import 재시도 소진 (Z38-4)
  "IMPORT_SPEC_INVALID",         // import 명세 모양 오류 (다시 해도 같음)
  "IMPORT_SOURCE_UNAVAILABLE",   // Z88: 출발 환경을 못 읽음 (자격·CLI·연결). 재시도 안 함
  "IMPORT_SOURCE_INCOMPLETE",    // Z88: 출발 환경에 앱 재료 없음 (Deployment·Pod·포트). 재시도 안 함
  "APPLY_FAILED",                // apply 예외
  "TF_APPLY_FAILED", "TF_PLAN_DRIFT", "TF_FACTS_MISSING",  // 진짜 Terraform 실행기 (int5-3 infra)
  "UNSUPPORTED_V2", "NEEDS_HUMAN", // TA3: PLAN_IR=v2 — 도착이 명세를 못 그림(capability 밖) / 사람이 정해야 함(v2 리소스 빠짐 등). 재시도 안 함
  "TF_BIN_MISSING",              // Z89: 진짜 Terraform 이 기본인데 실행 파일이 없음 (MOCK_IAC=1 이 아닌데 terraform 미설치)
  "CRED_RENEW_FAILED",           // 임시 자격 재발급 실패 (Z61)
  "APP_LINK_UPSTREAM_FAILED",    // 앱 연결 상류 실패 (int5-3)
  "APPLY_RECHECK_FAILED",        // apply 실행 직전 재확인 실패 (Z38-3: 지문 다름·만료·도착 환경 없음)
  "AZURE_MOCK_APPLY_FAILED",     // Azure Mock 실행기 결과 실패
  "AZURE_MOCK_DISABLED",         // @svc/adapters RunnerUnavailable (AZURE_MOCK=0)
  "ARGO_SYNC_FAILED",            // deploy: Argo가 failed
  "ARGO_DEGRADED", "ARGO_TIMEOUT", "ARGO_APP_MISSING",      // deploy 반영 확인 (Z94 argo-watch): Degraded / 시간 초과 / Application 끝까지 없음
  "ARGO_AUTH_FAILED", "ARGO_UNREACHABLE", "ARGO_NOT_CONFIGURED", //   토큰·RBAC 거부 / 연속 일시 오류 / .env 에 Argo 설정 없음
  "SYNC_FAILED",                 // sync 재시도 소진 또는 영구 실패
  "CUTOVER_CATCHUP_EXHAUSTED",   // 컷오버 C6' 되돌림 횟수 소진
  "CUTOVER_ERROR",               // 컷오버 도중 예외 (Z19 H2)
  "CUTOVER_HALFWAY",             //   C5 뒤 예외
  "CUTOVER_ERROR_UNFENCED",      //   C5 전 예외, 출발 울타리 걷음
  "CUTOVER_UNFENCE_FAILED",      //   C5 전 예외, 울타리 걷기도 실패 (긴급)
  "ROLLBACK_FAILED",             // 롤백 재시도 소진
  // gitops 배포 (apps/worker/src/gitops GitopsError.code) → deploy가 paused로
  "GITOPS_NOT_CONFIGURED",       // Z89: GitOps 레포 설정 없음인데 MOCK_ARGO=1 도 아님 (예전엔 조용히 STUB 성공)
  "GITOPS_ERROR", "GITOPS_GIT_FAILED", "GITOPS_NO_CHECKOUT", "GITOPS_PLACEHOLDER_MISSING", "GITOPS_PUSH_FAILED", "GITOPS_PUSH_CONFLICT",
  "GITOPS_VALUES_DRIFT", "GITOPS_VALIDATE_FAILED", "GITOPS_RENDER_FAILED", "GITOPS_WEIGHT_NOT_APPROVED", "GITOPS_FENCE_MANUAL",
  // 트래픽 전환 (@svc/traffic controller·state) → shift가 paused / rolling_back으로
  "TRAFFIC_PAUSED", "TRAFFIC_SWITCH_FAILED", "TRAFFIC_INSUFFICIENT_SAMPLES", "TRAFFIC_METRICS_UNAVAILABLE",
  "TRAFFIC_LATENCY", "TRAFFIC_ERROR_RATE",
  "TRAFFIC_SHARE_NOT_REACHED",   // z75-38: 실측 도착 몫이 재관찰 2번 뒤에도 목표 ±10%p 밖 → paused
] as const;

// 마지막 재시도까지 실패한 작업 (Z19 H4 죽은 작업 처리): JOB_FAILED_<단계 이름 대문자>
export type JobFailedCode = `JOB_FAILED_${Uppercase<string>}`;
export type FailureCode = (typeof FAILURE_CODES)[number] | JobFailedCode;
// 처리기 결과(StepOutcome)가 받는 타입. 목록 값은 자동 완성되지만 다른 문자열도 받는다 (`string & {}` 기법).
// DRAFT(ai) Z43: 엄격한 FailureCode로 좁히면 시험 파일들(Z12·Z36 등)이 임의 사유를 넘기다 컴파일이 깨진다.
//   대신 소스 리터럴은 failure-codes.test.ts가 목록과 대조한다. TODO(human): contracts로 옮길 때 엄격하게 바꿀지
export type FailureCodeLike = FailureCode | (string & {});

export const jobFailedCode = (step: string): JobFailedCode => `JOB_FAILED_${step.toUpperCase()}` as JobFailedCode;

// 다른 패키지가 string으로 주는 코드(GitopsError.code, RunnerUnavailable.code, traffic failureCode)를 받는 곳.
// 값은 그대로 돌려준다(동작 그대로). 목록에 없는 값이 오는지는 시험이 소스에서 본다
export const asFailureCode = (code: string): FailureCode => code as FailureCode;
export const isKnownFailureCode = (code: string): boolean =>
  (FAILURE_CODES as readonly string[]).includes(code) || /^JOB_FAILED_[A-Z_]+$/.test(code);
