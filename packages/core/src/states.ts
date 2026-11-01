import { VALID, TERMINAL, type MigrationStatus } from "@svc/contracts";

// 상태 묶음 한 곳 (Z43). 전이 표(VALID)·끝 상태(TERMINAL)는 contracts가 단일 소스이고,
// 여기서는 그 표에서 끌어낸 "어떤 상태들" 묶음만 둔다. 예전엔 core guards.ts·worker _step.ts·reaper.ts에 각자 있었다.

// 갈 수 있나 (VALID 그대로)
export const canMove = (from: MigrationStatus, to: MigrationStatus): boolean => VALID[from].includes(to);

// 실패 지점이 이 상태들이면 다시 계획(failed → planning)할 수 있다 (T37: provisioning 이하)
export const REPLANNABLE_FAILURES: readonly MigrationStatus[] =
  ["importing", "prechecking", "planning", "provisioning"];

// 환경 잠금을 쥐고 일하는 단계 = 승인(잠금 예약) 뒤, 끝 상태 전 (워커 runStep 기본값)
export const LOCKED_STAGES: readonly MigrationStatus[] = [
  "provisioning", "deploying", "syncing", "shifting", "cutover",
  "rollback_window", "cleanup", "rolling_back", "paused",
];

// 더 일할 게 없는 상태 = 끝 상태 + 낡음 + 거절. 리퍼가 이 상태의 남은 잠금은 그냥 지운다
export const INACTIVE_STATES: readonly MigrationStatus[] = [...TERMINAL, "stale", "rejected"];

// 사람이 봐야 할 때 보낼 곳: failed 길이 있으면 failed, 없으면 paused, 둘 다 없으면 null.
// 리퍼(잠금 기한 지남)와 워커 죽은 작업 처리(Z19 H4)가 같은 규칙을 쓴다
export function failureEdge(s: MigrationStatus): "failed" | "paused" | null {
  if (VALID[s]?.includes("failed")) return "failed";
  if (VALID[s]?.includes("paused")) return "paused";
  return null;
}
