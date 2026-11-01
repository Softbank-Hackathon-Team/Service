// 계획서·승인·"도착 자원 준비됨" 읽기·쓰기는 packages/core/src/plans.ts 하나로 합쳤다 (plans·plan_approvals 표, 0004)
export {
  savePlan, loadPlanById, loadLatestPlan, saveApproval, loadLatestApproval,
  saveInfraReady, loadInfraReady, type ApprovalRecord,
} from "@svc/core";
