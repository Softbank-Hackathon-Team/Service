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
  "UNSUPPORTED_V2", "NEEDS_HUMAN", // TA3: 도착이 명세를 못 그림(capability 밖) / 사람이 정해야 함(v2 리소스 빠짐 등). 재시도 안 함
  "ENV_LAYER_APPLY_FAILED",      // 환경 층(gcp/env: VPC·GKE·ESO) apply 실패. 만들다 만 자원은 지우지 않는다 (environment_layers.status=failed)
  "ENV_LAYER_BUSY",              //   같은 환경의 환경 층을 다른 이전이 만드는 중 (status=creating)
  "ENV_LAYER_CRED_MISSING",      //   환경 층을 만들 빌린 GCP 실행 토큰이 없음 (워커 자기 자격으로는 만들지 않는다)
  "TARGET_FACTS_UNAVAILABLE",    // AWS 도착: TF_FACT_* 가 없고, 실자원 읽기가 둔 도착 EKS 사실(VPC·서브넷)도 못 씀 (아직 안 읽음·클러스터 다름·사설 서브넷 부족 등). 아무것도 안 만듦
  "TF_BIN_MISSING",              // Z89: 진짜 Terraform 이 기본인데 실행 파일이 없음 (MOCK_IAC=1 이 아닌데 terraform 미설치)
  "CRED_RENEW_FAILED",           // 임시 자격 재발급 실패 (Z61)
  "TEMP_ROLE_DENIED",            // 실환경(진짜 발급기)에서 고객 임시 역할 발급 거부 (최소 권한 파일 없음 등) → apply failed. 워커 자기 자격으로 넘어가지 않는다
  "APP_LINK_UPSTREAM_FAILED",    // 앱 연결 상류 실패 (int5-3)
  "PLAN_RECHECK_FAILED",         // E10-4: 계획 작업 재확인 실패 (받아들인 명세 없음·도착 환경 없음·연결 안 됨이 계속됨)
  "APPLY_RECHECK_FAILED",        // apply 실행 직전 재확인 실패 (Z38-3: 지문 다름·만료·도착 환경 없음)
  "AZURE_MOCK_APPLY_FAILED",     // Azure Mock 실행기 결과 실패
  "AZURE_MOCK_DISABLED",         // @svc/adapters RunnerUnavailable (AZURE_MOCK=0)
  "ARGO_SYNC_FAILED",            // deploy: Argo가 failed
  "ARGO_DEGRADED", "ARGO_TIMEOUT", "ARGO_APP_MISSING",      // deploy 반영 확인 (Z94 argo-watch): Degraded / 시간 초과 / Application 끝까지 없음
  "ARGO_AUTH_FAILED", "ARGO_UNREACHABLE", "ARGO_NOT_CONFIGURED", //   토큰·RBAC 거부 / 연속 일시 오류 / .env 에 Argo 설정 없음
  "SYNC_FAILED",                 // sync 재시도 소진 또는 영구 실패
  "REPL_ENDPOINT_INCOMPLETE",    // db 0050: 이전의 복제 끝점 줄이 한쪽만 있음 (줄과 env 를 섞지 않는다) → sync paused
  "REPL_SECRET_UNRESOLVED",      // db 0050: password_ref 를 못 풂 (REPL_SECRET_MASTER_KEY 없음·짧음, env:REPL_SECRET_* 없음) → sync paused
  "REPL_TARGET_UNREACHABLE",     // db 0050: 도착 끝점 host:port 에 TCP 로 못 붙음 (재시도 소진 뒤) → sync paused
  "REPL_DB_OWNER_MISMATCH",      // ADR-029: 관리자가 DB 주인(역할 멤버)이 아님 = CNPG initdb.owner 와 실제 DB 주인이 다름 (sync 첫 점검 DB-09) → paused
  "REPL_APP_ROLE_UNFENCEABLE",   // 앱 계정이 superuser·pg_write_all_data·rds_superuser 등을 물려받아 컷오버 울타리(REVOKE)로 쓰기를 못 막음 (sync 첫 점검 DB-08) → paused
  "REPL_SOURCE_UNREACHABLE",     // 출발 끝점 host:port(중계기 출발 입구 포함)에 TCP 로 못 붙음 (재시도 소진 뒤) → sync paused
  "CUTOVER_CATCHUP_EXHAUSTED",   // 컷오버 C6' 되돌림 횟수 소진
  "CUTOVER_ERROR",               // 컷오버 도중 예외 (Z19 H2)
  "CUTOVER_HALFWAY",             //   C5 뒤 예외
  "CUTOVER_ERROR_UNFENCED",      //   C5 전 예외, 출발 울타리 걷음
  "CUTOVER_UNFENCE_FAILED",      //   C5 전 예외, 울타리 걷기도 실패 (긴급)
  "APP_LINK_UNAVAILABLE",        // APP-22 (가): 컷오버 때 도착 앱 DB 주소를 바꿀 길(GitOps 묶음·붙잡기 프록시)이 없음 → 울타리 전에 멈춤 (출발이 그대로 주인)
  "APP_LINK_SOURCE_MISSING", "APP_LINK_SECRET_FAILED", "APP_LINK_STATE_MISSING", "APP_LINK_REAPPLY_FAILED",   // APP-22 (가) Terraform 실행 방식: 출발 경로 없음 / 도착 그릇에 비밀번호 못 넣음 / apply 가 남긴 경로 상태 없음
  "ROLLBACK_FAILED",             // 롤백 재시도 소진
  // gitops 배포 (apps/worker/src/gitops GitopsError.code) → deploy가 paused로
  "RUNTIME_OUTPUT_MISSING", "RUNTIME_UNHEALTHY", "RUNTIME_CHECK_FAILED",   // DEPLOYNONK8S: ECS·Cloud Run·VM 도착 배포 확인 (출력 빠짐 / 시간 안에 안 뜸 / 읽기 CLI 실패)
  "SEALING_CERT_MISSING",        // 온프레 CNPG 이전: 도착 Agent 보고에 sealed-secrets 봉인 인증서가 없음 → deploy 커밋 전 paused
  // 온프레 CNPG 이전 중계기 (worker relay/relay-step.ts): apply 가 출발 AWS 계정에 만들고 정리가 지운다
  "ONPREM_EGRESS_UNKNOWN",       //   Agent facts 에 온프레 나가는 IP 가 없음 → SSH(22)를 세상에 열지 않으려고 apply 가 failed
  "RELAY_CONFIG_MISSING",        //   워커 env PLATFORM_EGRESS_CIDRS 없음·틀림 → apply failed
  "RELAY_SOURCE_DB_UNKNOWN",     //   명세에서 출발 RDS 를 못 찾음·postgres 둘 이상·RDS 포트 5432 아님 → apply failed
  "RELAY_ROLE_DENIED",           //   출발 실행 역할(중계기 세션 정책) 발급 거부 → apply failed
  "RELAY_PROVISION_FAILED",      //   중계기 만들기 실패 (aws CLI). 만든 것은 태그를 단 채 남는다 → apply failed
  "RELAY_DB_EGRESS_DENIED",      //   출발 RDS 보안 그룹에 중계기로 나가는 5432 가 없고 열 권한도 없음 (연결 스택 SourceDbSecurityGroupId 비움) → apply failed
  "RELAY_DB_INGRESS_DENIED",     //   출발 RDS 보안 그룹이 중계기에서 들어오는 5432 를 안 받고 열 권한도 없음 (연결 스택이 옛 템플릿) → apply failed
  "RELAY_TEARDOWN_FAILED",       //   중계기 지우기 실패 → cleanup paused (롤백은 rolled_back + 경고)
  "RELAY_TARGET_DB_UNKNOWN",     //   AWS→GCP 중계기: terraform 출력에 Cloud SQL 공개·나가는 IP·관리자 계정이 없음 → apply failed
  "TARGET_APP_LOGIN_FAILED",     //   AWS→GCP: 워커가 Cloud SQL 에 관리자로 붙어 앱 로그인 역할(일반 역할)을 못 만듦 → apply failed
  "REPL_ENDPOINT_MISSING",       // 진짜 판(MOCK_IAC≠1)·명세에 postgres 가 있는데 복제 끝점(줄·REPL_* env)이 없음 → sync·cleanup paused, cutover failed (예전엔 가짜 성공으로 통과)
  "REPL_TF_FACTS_MISSING",       // 복제 끝점 주소의 {tf:키} 를 못 채움·빈 값 (PF-E22) → sync·cleanup paused, cutover failed
  "REPL_DELIVERY_FAILED",        // 온프레 CNPG 이전: 서버 인증서·봉인 비밀·터널 값을 못 만듦 (중계기 칸 없음, 출발 포트 5432 아님, openssl 실패 등) → paused
  "SECRET_VALUES_MISSING", "SECRET_VALUES_UNKNOWN",   // APP-20: deploy 커밋 전 도착 비밀 그릇에 값(버전)이 없음 / 못 읽음 → paused
  "IMAGE_COPY_FAILED",           // deploy 커밋 전 사설 이미지를 도착 레지스트리로 복사·다이제스트 확인 못 함 (worker jobs/image-copy.ts, detail.deploy.step = 이유) → paused
  "GITOPS_NOT_CONFIGURED",       // Z89: GitOps 레포 설정 없음인데 MOCK_ARGO=1 도 아님 (예전엔 조용히 STUB 성공)
  "GITOPS_ERROR", "GITOPS_GIT_FAILED", "GITOPS_NO_CHECKOUT", "GITOPS_PLACEHOLDER_MISSING", "GITOPS_PUSH_FAILED", "GITOPS_PUSH_CONFLICT", "GITOPS_TENANT_REPO_FAILED",
  "GITOPS_VALUES_DRIFT", "GITOPS_VALIDATE_FAILED", "GITOPS_RENDER_FAILED", "GITOPS_WEIGHT_NOT_APPROVED", "GITOPS_FENCE_MANUAL",
  // 트래픽 전환 (@svc/traffic controller·state) → shift가 paused / rolling_back으로
  "TRAFFIC_PAUSED", "TRAFFIC_SWITCH_FAILED", "TRAFFIC_INSUFFICIENT_SAMPLES", "TRAFFIC_METRICS_UNAVAILABLE",
  "TRAFFIC_LATENCY", "TRAFFIC_ERROR_RATE",
  "TRAFFIC_SHARE_NOT_REACHED",   // z75-38: 실측 도착 몫이 재관찰 2번 뒤에도 목표 ±10%p 밖 → paused
  "TRAFFIC_OBSERVE_TOO_LONG",    // pf-d hunt-traffic-ops-02: 관찰 초 × 단계 × 재관찰 최악이 shift 작업 만료를 넘음 → 가중치 안 건드리고 paused
  "TRAFFIC_LB_BUSY",             // PF RV-20: 같은 LB 를 다른 이전이 상한 넘게 쥠 → 가중치 안 건드리고 paused (npm run ops:lb-release)
  "TRAFFIC_RESTORE_FAILED",      // Jeong 01:53Z: 실패 진입 때 트래픽 출발 100% 되돌리기가 재시도 뒤에도 실패
  "TRAFFIC_PLATFORM_ERROR",      // pf-d RV-11: 전환 도중 플랫폼 DB 오류가 이어짐 → 출발 100% 로 되돌린 뒤 paused
  "TRAFFIC_PREFLIGHT_FAILED", "TRAFFIC_LB_MISCONFIGURED",   // Z14-06: LB 점검 실패 / 전환 조건 안 맞음 → paused
  "TRAFFIC_NOT_CONFIGURED",      // 진짜 판(MOCK_IAC·MOCK_TRAFFIC 꺼짐)에 PROM_URL·LB 전환기가 없음 → 가중치·LB 주인 자리 안 건드리고 paused
  // vCluster 리허설 (deploying, 커밋 전) → paused. contracts RehearsalFailureCode 와 같은 글자 (시험이 두 목록을 맞춘다)
  "REHEARSAL_DRY_RUN_REJECTED", "REHEARSAL_TARGET_POLICY_DENIED", "REHEARSAL_QUOTA_EXCEEDED",
  "REHEARSAL_ROLLOUT_FAILED", "REHEARSAL_CRASHLOOP", "REHEARSAL_NOT_READY", "REHEARSAL_JOB_FAILED", "REHEARSAL_CONNECTIVITY_FAILED",
  "REHEARSAL_POLICY_DENIED", "REHEARSAL_UNSUPPORTED_KIND",
  "REHEARSAL_IMAGE_MIRROR_FAILED", "REHEARSAL_SANDBOX_UNAVAILABLE", "REHEARSAL_TIMEOUT", "REHEARSAL_BUNDLE_MISMATCH",
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
