import { z } from "zod";

// 큐 이름. pg-boss 큐 선언과 작업 등록이 이 목록 하나를 본다
export const QUEUES = {
  verifyConnection: "verify-connection",
  import: "import",
  precheck: "precheck",
  plan: "plan",
  apply: "apply",
  deploy: "deploy",
  sync: "sync",
  shift: "shift",
  cutover: "cutover",
  cleanup: "cleanup",
  rollback: "rollback",
  securityScan: "security-scan",
  agentRun: "agent-run",
  leaseReaper: "lease-reaper",
  idempotencyCleanup: "idempotency-cleanup",
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

export const AgentRunJob = JobBase.extend({
  agentRunId: z.uuid(),
}).strict();

// 큐 이름 → 작업 내용 모양
export const JOB_SCHEMAS = {
  "verify-connection": VerifyConnectionJob,
  "import": MigrationJob,
  "precheck": MigrationJob,
  "plan": PlanJob,
  "apply": ApplyJob,
  "deploy": MigrationJob,
  "sync": MigrationJob,
  "shift": MigrationJob,
  "cutover": MigrationJob,
  "cleanup": MigrationJob,
  "rollback": MigrationJob,
  "security-scan": EnvJob,
  "agent-run": AgentRunJob,
} as const;
