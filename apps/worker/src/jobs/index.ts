import { QUEUES, type QueueName } from "@svc/contracts";
import { handleImport } from "./import.js";
import { handlePrecheck } from "./precheck.js";
import { handlePlan } from "./plan.js";
import { handlePlanExpiry } from "./plan-expiry.js";
import { handleApply } from "./apply.js";
import { handleDeploy } from "./deploy.js";
import { handleSync } from "./sync.js";
import { handleShift } from "./shift.js";
import { handleCutover } from "./cutover.js";
import { handleCleanup } from "./cleanup.js";
import { handleRollback } from "./rollback.js";
import { handleVerifyConnection } from "./verify-connection.js";
import { handleImageBuild } from "./image-build.js";

// 큐 이름 → 처리 함수. 이전 상태기계 순서(계약 문서 "상태가 바뀌면 어떤 작업이 생기나" 표)대로 적는다.
// security-scan, agent-run, lease-reaper, idempotency-cleanup은 다른 작업 범위라 여기 없다
export const HANDLERS: Partial<Record<QueueName, (data: unknown) => Promise<unknown>>> = {
  [QUEUES.verifyConnection]: (d) => handleVerifyConnection(d),   // 환경 연결: verifying → connected | failed (주기 재확인은 connected ↔ unstable)
  [QUEUES.import]: handleImport,       // importing → spec_review
  [QUEUES.precheck]: handlePrecheck,   // prechecking → planning
  [QUEUES.plan]: handlePlan,           // planning → awaiting_approval   (사람 승인)
  [QUEUES.planExpiry]: handlePlanExpiry, // awaiting_approval → stale (계획 만료 시각에, G7-1)
  [QUEUES.apply]: handleApply,         // provisioning → deploying
  [QUEUES.deploy]: handleDeploy,       // deploying → syncing
  [QUEUES.sync]: handleSync,           // syncing → shifting
  [QUEUES.shift]: handleShift,         // shifting → cutover
  [QUEUES.cutover]: handleCutover,     // cutover → rollback_window
  [QUEUES.cleanup]: handleCleanup,     // rollback_window → cleanup → completed
  [QUEUES.rollback]: handleRollback,   // rolling_back → rolled_back
  [QUEUES.imageBuild]: handleImageBuild, // 상태를 안 옮김: provisioning 의 apply 가 앞에서 부르는 보조 작업 (STUB)
};
