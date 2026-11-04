import type { ConnectionStatus, MigrationStatus, MigrationView, PlanStep, Provider } from "./types";
import { TERMINAL } from "./types";
import { t } from './i18n';

// 화면에 쓰는 한국어 이름 (E의 state-machine.md 표 기준, 용어표 GLOSSARY.md 2절이 이 표를 따른다)
// 상태 이름은 화면 어디서든 이 표 하나에서 꺼낸다 (목록 칩·상세 칩·진행 막대·계획서 단계·오류 설명·버튼 안내)
export const LABEL: Record<MigrationStatus, string> = {
  draft: t('초안'), importing: t('가져오기'), spec_review: t('명세 검토'), prechecking: t('사전 점검'),
  planning: t('계획'), awaiting_approval: t('승인 대기'), approved: t('승인됨'),
  provisioning: t('자원 생성'), deploying: t('앱 배포'), syncing: t('DB 복제'), shifting: t('트래픽 이동'),
  cutover: t('DB 컷오버'), rollback_window: t('롤백 가능 창'), cleanup: t('정리'), completed: t('완료'),
  paused: t('일시 정지'), rolling_back: t('롤백 중'), rolled_back: t('롤백 완료'), failed: t('실패'),
  cancelled: t('취소'), rejected: t('거절'), stale: t('계획 낡음'),
};

// 상세 칩 글자: "명세 검토 · spec_review" (e2e helpers.ts 가 "· 영어" 부분을 읽는다)
export const statusText = (s: MigrationStatus) => `${LABEL[s]} · ${s}`;

// 정상 경로 15칸 (진행 막대에 그리는 순서)
export const MAIN_PATH: readonly MigrationStatus[] = [
  "draft", "importing", "spec_review", "prechecking", "planning", "awaiting_approval", "approved",
  "provisioning", "deploying", "syncing", "shifting", "cutover", "rollback_window", "cleanup", "completed",
];

// 사람이 해야 하는 칸
export const HUMAN_STEP: readonly MigrationStatus[] = ["spec_review", "awaiting_approval", "approved"];
// 워커가 명세·계획을 준비하는 칸 (사람 버튼 없음, "점검·계획 중" 안내)
export const WORKER_PREP: readonly MigrationStatus[] = ["prechecking", "planning", "importing", "draft"];
// 사람이 볼 것이 있어 천천히(1.5초) 다시 읽는 비정상 상태
export const HUMAN_WAIT: readonly MigrationStatus[] = ["rejected", "stale", "paused", "failed"];
// 계획서가 있을 수 있는 상태
export const HAS_PLAN: readonly MigrationStatus[] = [
  "awaiting_approval", "approved", "rejected", "stale", "provisioning", "deploying", "syncing",
  "shifting", "cutover", "rollback_window", "cleanup", "completed", "paused", "rolling_back", "rolled_back", "failed",
];

export const isTerminal = (s: MigrationStatus) => TERMINAL.includes(s);

// 계획서 단계 id → 상태 (단계 이름도 LABEL 에서 꺼낸다)
export const PLAN_STEP_STATUS: Record<PlanStep["id"], MigrationStatus> = {
  provision: "provisioning", deploy: "deploying", sync: "syncing", shift: "shifting", cutover: "cutover", cleanup: "cleanup",
};

export type Tone = "ok" | "run" | "wait" | "bad" | "done";
export function toneOf(s: MigrationStatus): Tone {
  if (s === "completed") return "done";
  if (["failed", "rolled_back", "rolling_back", "cancelled", "rejected"].includes(s)) return "bad";
  if (["paused", "stale"].includes(s)) return "wait";
  if (HUMAN_STEP.includes(s)) return "wait";
  return "run";
}

// 비정상 상태일 때 진행 막대의 어느 칸에서 멈췄는지
export function anchorOf(m: Pick<MigrationView, "status" | "pausedFrom" | "failedAtStatus">): MigrationStatus | null {
  const s = m.status;
  if (MAIN_PATH.includes(s)) return s;
  if (s === "paused") return m.pausedFrom ?? null;
  if (s === "failed") return m.failedAtStatus ?? null;
  if (s === "rejected" || s === "stale") return "awaiting_approval";
  return null; // rolling_back, rolled_back, cancelled: 위치 정보 없음
}

// 목록 막대 채움(%): 멈춘 칸까지
export function progressPct(m: Pick<MigrationView, "status" | "pausedFrom" | "failedAtStatus">): number {
  const a = anchorOf(m);
  const idx = a ? MAIN_PATH.indexOf(a) : -1;
  return idx < 0 ? 0 : Math.round(((idx + 1) / MAIN_PATH.length) * 100);
}

// ---- 상태 말고 다른 이름표도 여기 한 곳 ----
// 클라우드 이름. 환경 표는 짧게(Mock 배지를 따로 붙임), 비용 화면은 "(Mock)"까지
export const PROVIDER_SHORT: Record<Provider, string> = { aws: "AWS", gcp: "GCP", onprem: t('온프레'), azure_mock: "Azure" };
export const PROVIDER_LABEL: Record<Provider, string> = { aws: "AWS", gcp: "GCP", onprem: t('온프레'), azure_mock: "Azure (Mock)" };

// 환경 연결 상태
export const CONN_LABEL: Record<ConnectionStatus, string> = {
  draft: t('초안'), awaiting_customer: t('고객 작업 대기'), verifying: t('검증 중'), connected: t('연결됨'),
  unstable: t('불안정'), failed: t('실패'), expired: t('만료'), disconnected: t('끊김'),
};

// ---- Z83: 상태 이름 옆 한 줄 뜻 (상세 머리 28px 밑). 사람이 뭘 해야 하는지까지 ----
export const STATE_HINT: Record<MigrationStatus, string> = {
  draft: t('만든 직후. 워커가 곧 명세를 가져온다.'),
  importing: t('출발 환경에서 앱 명세를 가져오는 중.'),
  spec_review: t('사람 차례. 가져온 명세를 보고 \'명세 확정\'을 누른다.'),
  prechecking: t('워커가 도착 환경 조건을 점검하는 중.'),
  planning: t('워커가 계획서(단계·지문)를 만드는 중.'),
  awaiting_approval: t('사람 차례. 계획서를 읽고 승인 또는 거절.'),
  approved: t('사람 차례. \'실행 시작\'을 누르면 워커가 자원을 만든다.'),
  provisioning: t('Terraform 으로 도착 클러스터·DB 를 만드는 중.'),
  deploying: t('도착 클러스터에 앱을 배포하는 중.'),
  syncing: t('출발 DB → 도착 DB 논리 복제 중.'),
  shifting: t('트래픽을 도착 쪽으로 단계별로 옮기는 중.'),
  cutover: t('쓰기를 멈추고 DB 를 도착으로 바꾸는 순간.'),
  rollback_window: t('되돌릴 수 있는 창. 끝나면 정리로 넘어간다.'),
  cleanup: t('출발 자원 정리 중.'),
  completed: t('끝. 도착 환경이 운영 중.'),
  paused: t('멈춤. 사람이 이어 가기·롤백·취소 중 하나를 고른다.'),
  rolling_back: t('트래픽과 DB 를 출발 쪽으로 되돌리는 중.'),
  rolled_back: t('끝. 출발 환경으로 되돌아갔다.'),
  failed: t('실패로 멈춤. 실패 코드를 보고 남은 자원을 정리한 뒤 취소.'),
  cancelled: t('끝. 사람이 취소했다.'),
  rejected: t('계획을 거절했다. 새 계획을 만들거나 취소.'),
  stale: t('계획이 낡았다(만료·출발 변경). 새 계획을 만들거나 취소.'),
};
// 모양 글자: 색만으로 구분하지 않는다 (Carbon 상태 표시 패턴: 색 + 모양 + 글자)
export const TONE_MARK: Record<Tone, string> = { run: "●", wait: "◐", bad: "✕", done: "✓", ok: "✓" };
export const markOf = (s: MigrationStatus) => (TERMINAL.includes(s) && s !== "completed" ? "✕" : TONE_MARK[toneOf(s)]);
