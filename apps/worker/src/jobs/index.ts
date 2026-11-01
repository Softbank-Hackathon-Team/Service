import { QUEUES, type QueueName } from "@svc/contracts";
import { handleImport } from "./import.js";
import { handlePrecheck } from "./precheck.js";
import { handlePlan } from "./plan.js";
import { handleApply } from "./apply.js";
import { handleDeploy } from "./deploy.js";
import { handleSync } from "./sync.js";
import { handleShift } from "./shift.js";
import { handleCutover } from "./cutover.js";
import { handleCleanup } from "./cleanup.js";
import { handleRollback } from "./rollback.js";

// 큐 이름 → 처리 함수. 이전 상태기계 순서(계약 문서 "상태가 바뀌면 어떤 작업이 생기나" 표)대로 적는다.
// verify-connection, security-scan, agent-run, lease-reaper, idempotency-cleanup은 다른 작업 범위라 여기 없다
export const HANDLERS: Partial<Record<QueueName, (data: unknown) => Promise<unknown>>> = {
  [QUEUES.import]: handleImport,       // importing → spec_review
  [QUEUES.precheck]: handlePrecheck,   // prechecking → planning
  [QUEUES.plan]: handlePlan,           // planning → awaiting_approval   (사람 승인)
  [QUEUES.apply]: handleApply,         // provisioning → deploying
  [QUEUES.deploy]: handleDeploy,       // deploying → syncing
  [QUEUES.sync]: handleSync,           // syncing → shifting
  [QUEUES.shift]: handleShift,         // shifting → cutover
  [QUEUES.cutover]: handleCutover,     // cutover → rollback_window
  [QUEUES.cleanup]: handleCleanup,     // rollback_window → cleanup → completed
  [QUEUES.rollback]: handleRollback,   // rolling_back → rolled_back
};
