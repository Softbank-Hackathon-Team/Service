import { z } from "zod";
import { BuildPlan } from "./build.js";

// 큐 이름. pg-boss 큐 선언과 작업 등록이 이 목록 하나를 본다
export const QUEUES = {
  verifyConnection: "verify-connection",
  import: "import",
  precheck: "precheck",
  plan: "plan",
  // G7-1: 승인 대기 계획의 만료 시각에 깨어나 awaiting_approval → stale(expired). 예전엔 이 전이(T11)를 부르는 곳이 없어 막다른 길이었다
  planExpiry: "plan-expiry",
  apply: "apply",
  deploy: "deploy",
  sync: "sync",
  shift: "shift",
  cutover: "cutover",
  cleanup: "cleanup",
  rollback: "rollback",
  targetDestroy: "target-destroy",      // G5-1: 실패한 이전이 도착에 만든 자원 지우기 (상태 안 바꿈, ADR-066 자동)
  replCleanup: "repl-cleanup",          // F8-5: 끝난 이전의 남은 복제 객체 다시 걷기 (사람 버튼, 상태 안 바꿈)
  imageBuild: "image-build",
  securityScan: "security-scan",
  agentRun: "agent-run",
  leaseReaper: "lease-reaper",
  idempotencyCleanup: "idempotency-cleanup",
  verifySweep: "verify-sweep",          // L4b: 연결 주기 재확인 훑기 (일정이 냄 → 환경마다 verify-connection periodic)
  sandboxRehearsal: "sandbox-rehearsal", // deploying 리허설 한 건 (워커가 냄 → agent-worker 가 vCluster 에서 돌림)
} as const;
export type QueueName = typeof QUEUES[keyof typeof QUEUES];

// 모든 작업 내용의 공통 앞부분. 큐 표는 회사 벽 밖이라
// 워커는 이 값을 믿지 않고 DB에서 다시 읽는다
export const JobBase = z.object({
  tenantId: z.uuid(),
  requestId: z.string(),
}).strict();

export const MigrationJob = JobBase.extend({
  migrationId: z.uuid(),
}).strict();
export type MigrationJob = z.infer<typeof MigrationJob>;

export const PlanJob = MigrationJob.extend({
  planId: z.uuid(),
}).strict();

export const ApplyJob = PlanJob.extend({
  planHash: z.string(),             // 실행 직전 재확인 6개 중 하나
}).strict();

export const EnvJob = JobBase.extend({
  envId: z.uuid(),
}).strict();

// 연결 확인 작업. user = 고객이 계정 번호를 넣고 누른 확인, periodic = 1시간마다 재확인
// EnvJob은 security-scan이 같이 쓰므로 그대로 두고 넓힌 모양을 따로 둔다
export const VerifyConnectionJob = EnvJob.extend({
  reason: z.enum(["user", "periodic"]),
}).strict();
export type VerifyConnectionJob = z.infer<typeof VerifyConnectionJob>;

// 이미지 빌드 작업 (설계 23번 3.3). 계획 승인 뒤 provisioning 에서 apply 앞에 서비스마다 하나.
// 빌드 계획(BuildPlan)은 승인된 명세에서 온 값이지만, 워커는 이 내용을 믿지 않고 명세를 DB에서 다시 읽는다 (STUB 단계에선 아직 읽지 않음)
export const ImageBuildJob = PlanJob.extend({
  serviceId: z.string().min(1),
  build: BuildPlan,
}).strict();
export type ImageBuildJob = z.infer<typeof ImageBuildJob>;

// 빌드 결과: 도착 레지스트리에 올린 이미지의 digest. 명세 새 판에 기록하는 값
export const ImageBuildResult = z.object({
  serviceId: z.string().min(1),
  digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  builtFrom: z.object({ repo: z.string(), commit: z.string(), method: z.enum(["dockerfile", "buildpacks"]) }).strict(),
}).strict();
export type ImageBuildResult = z.infer<typeof ImageBuildResult>;

export const AgentRunJob = JobBase.extend({
  agentRunId: z.uuid(),
}).strict();

// 리허설 작업은 sandbox_runs 줄 번호 하나뿐. 입력(RehearsalInput)은 그 줄에서 다시 읽는다
export const SandboxRunJob = JobBase.extend({
  sandboxRunId: z.uuid(),
}).strict();
export type SandboxRunJob = z.infer<typeof SandboxRunJob>;

// 큐 이름 → 작업 내용 모양
export const JOB_SCHEMAS = {
  "verify-connection": VerifyConnectionJob,
  "import": MigrationJob,
  "precheck": MigrationJob,
  "plan": PlanJob,
  "plan-expiry": PlanJob,
  "apply": ApplyJob,
  "deploy": MigrationJob,
  "sync": MigrationJob,
  "shift": MigrationJob,
  "cutover": MigrationJob,
  "cleanup": MigrationJob,
  "rollback": MigrationJob,
  "target-destroy": MigrationJob,
  "repl-cleanup": MigrationJob,
  "image-build": ImageBuildJob,
  "security-scan": EnvJob,
  "agent-run": AgentRunJob,
  "sandbox-rehearsal": SandboxRunJob,
} as const;
