import type { MigrationStatus, MigrationView } from "./types";
import { TERMINAL, VALID } from "./types";
import { LABEL } from "./status";

// 문장 속 상태 이름도 LABEL 에서 꺼낸다 (용어표 한 곳만 고치면 문장도 같이 바뀐다)
const L = LABEL;

// 비상 버튼 둘(롤백·취소)을 지금 켤지 판단한다. 화면 없이 시험할 수 있게 순수 함수로 둔다.
// 기준: 상태 머신 표(VALID). 서버(apps/api/src/routes/control.ts)도 같은 표로 409를 낸다.
//   롤백 = 지금 상태 → rolling_back  (deploying, syncing, shifting, rollback_window, paused)
//   취소 = 지금 상태 → cancelled     (draft ~ approved 사이 사람 칸, rejected, stale, failed)

export interface ButtonState {
  allowed: boolean;
  why: string | null; // 꺼져 있을 때 이유 (한국어 한 줄)
}

export interface EmergencyState {
  show: boolean; // 끝난 상태면 버튼 자체를 숨긴다
  rollback: ButtonState;
  cancel: ButtonState & { needsCleanupConfirm: boolean };
}

const CANCEL_INSTEAD: readonly MigrationStatus[] = [
  "draft", "importing", "spec_review", "prechecking", "planning",
  "awaiting_approval", "approved", "rejected", "stale",
];
const ROLLBACK_INSTEAD: readonly MigrationStatus[] = ["deploying", "syncing", "shifting", "rollback_window", "paused"];

function rollbackWhy(s: MigrationStatus): string {
  if (CANCEL_INSTEAD.includes(s)) return "아직 바꾼 게 없어. 되돌릴 필요 없이 '취소'를 쓰면 돼.";
  switch (s) {
    case "provisioning": return `자원을 만드는 중엔 롤백할 수 없어. 끝나서 ${L.deploying}가 시작되면 눌러.`;
    case "cutover": return `${L.cutover} 중엔 누를 수 없어. 끝나서 '${L.rollback_window}'이 되면 눌러.`;
    case "cleanup": return `${L.cleanup} 단계라 되돌릴 수 없어. ${L.rollback_window}이 이미 끝났어.`;
    case "rolling_back": return "이미 되돌리는 중이야.";
    case "failed": return "실패 상태야. 남은 자원을 정리한 뒤 '취소'를 써.";
    default: return "지금 상태에서는 롤백할 수 없어.";
  }
}

function cancelWhy(s: MigrationStatus): string {
  if (ROLLBACK_INSTEAD.includes(s)) return "이미 앱·DB·트래픽을 바꾸기 시작해서 취소 대신 '롤백'을 써야 해.";
  switch (s) {
    case "provisioning": return "자원을 만드는 중엔 취소할 수 없어. 끝나거나 실패한 뒤에 다시 봐.";
    case "rolling_back": return "되돌리는 중이야. 끝나면 이전이 자동으로 끝나.";
    default: return "지금 상태에서는 취소할 수 없어.";
  }
}

// now: 시험에서 시계를 넣으려고 받는다
export function emergencyState(
  m: Pick<MigrationView, "status" | "rollbackWindowEndsAt"> & Partial<Pick<MigrationView, "pausedFrom">>,
  now: number = Date.now(),
): EmergencyState {
  const s = m.status;
  const can = (to: MigrationStatus) => VALID[s].includes(to);

  let rollback: ButtonState = can("rolling_back") ? { allowed: true, why: null } : { allowed: false, why: rollbackWhy(s) };
  // 롤백 가능 창이 끝났으면 화면에서도 막는다. 서버도 409 GUARD_FAILED 로 거부한다(P-4, guards.ts, 10/31 보드 기본값 확정)
  if (rollback.allowed && s === "rollback_window" && m.rollbackWindowEndsAt && Date.parse(m.rollbackWindowEndsAt) <= now)
    rollback = { allowed: false, why: `${L.rollback_window}이 끝났어. 곧 ${L.cleanup} 단계로 넘어가.` };
  // Z38 REVIEW-4 W-1: 정리(cleanup) 중 멈춘 이전은 롤백 가능 창 뒤라 서버가 409 GUARD_FAILED 로 막는다 (Z38-1, guards.ts).
  //   예전엔 버튼이 켜져 있어 누르면 오류만 떴다. 재개(→ 정리 이어 가기)만 남긴다
  if (rollback.allowed && s === "paused" && m.pausedFrom === "cleanup")
    rollback = { allowed: false, why: `${L.cleanup} 중 멈춘 거라 되돌릴 수 없어. ${L.rollback_window}이 이미 끝났어. 원인을 고친 뒤 재개해.` };

  const cancel = can("cancelled")
    ? { allowed: true, why: null, needsCleanupConfirm: s === "failed" }
    : { allowed: false, why: cancelWhy(s), needsCleanupConfirm: false };

  return { show: !TERMINAL.includes(s), rollback, cancel };
}

// 확인 상자에 보여 줄 문장: 누르면 무슨 일이 생기는지
export function confirmText(kind: "rollback" | "cancel", s: MigrationStatus): string {
  if (kind === "rollback")
    return s === "rollback_window"
      ? "트래픽을 출발 쪽 100%로 되돌리고, DB는 역방향 복제로 도착에 쓴 데이터까지 출발로 돌려보내. 롤백할까?"
      : "트래픽을 출발 쪽 100%로 되돌리고 도착 쪽 복제를 걷어. 롤백할까?";
  if (s === "failed")
    return "만들다 만 자원(클라우드 쪽)을 직접 정리했어? 확인하면 '정리했음'으로 기록하고 이 이전을 끝내. 되돌릴 수 없어.";
  return "이 이전을 끝내고 환경 잠금을 풀어. 되돌릴 수 없어(다시 하려면 새 이전을 만들어). 취소할까?";
}
