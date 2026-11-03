import type { MigrationStatus } from "./types";

// 멈춘 이유 (서버 failure_code → 사람 말). 코드 목록은 packages/core/src/failure-codes.ts 한 곳에 있다.
// 화면은 코드를 큰 카드에 그대로 쓰지 않는다. 이 표의 문장으로 말하고, 코드는 "멈춘 이유" 카드 안에 둔다.
//   kind: guardrail = 지표·규칙이 멈춤(되돌릴지 정하는 근거가 지표다) / step = 단계 작업이 실패 / system = 설정·워커 문제
// 모르는 코드는 지어내지 않고 "알 수 없는 사유"로 두며, 코드는 그대로 보여 준다.

export type StopKind = "guardrail" | "step" | "system";
export interface StopReason {
  kind: StopKind;
  label: string;   // 카드 머리줄 오른쪽에 쓰는 짧은 말
  title: string;   // 큰 카드 헤드라인 (두 줄)
  hint: string;    // 무엇이 일어났는지 한 문장
}

type Rule = { match: RegExp } & StopReason;

// 위에서부터 먼저 맞는 줄을 쓴다. 넓은 접두어(TRAFFIC_, GITOPS_ …)는 좁은 것 뒤에 둔다
const RULES: Rule[] = [
  { match: /^TRAFFIC_ERROR_RATE$/, kind: "guardrail", label: "오류율 기준 넘음", title: "도착 쪽 오류가\n기준을 넘었습니다", hint: "도착 환경의 오류율이 계획서의 되돌림 기준을 넘었습니다." },
  { match: /^TRAFFIC_LATENCY$/, kind: "guardrail", label: "응답 시간 기준 넘음", title: "도착 쪽 응답이\n기준보다 느립니다", hint: "도착 환경의 p95 응답 시간이 계획서의 기준 배수를 넘었습니다." },
  { match: /^TRAFFIC_SHARE_NOT_REACHED$/, kind: "guardrail", label: "목표 비율 못 미침", title: "트래픽이 목표 비율까지\n퍼지지 않았습니다", hint: "도착으로 간 실제 요청 비율이 다시 봐도 목표 범위 밖이었습니다." },
  { match: /^TRAFFIC_INSUFFICIENT_SAMPLES$/, kind: "guardrail", label: "판단할 요청 부족", title: "판단할 요청이\n모자랍니다", hint: "오류율을 판단할 만큼 요청이 들어오지 않아 더 옮기지 않았습니다." },
  { match: /^TRAFFIC_METRICS_UNAVAILABLE$/, kind: "system", label: "지표 못 읽음", title: "지표를 읽지 못해\n멈췄습니다", hint: "오류율과 응답 시간 지표를 읽지 못해 더 옮기지 않았습니다." },
  { match: /^TRAFFIC_(SWITCH_FAILED|PROVIDER_ERROR|LB_MISCONFIGURED|PREFLIGHT_FAILED)$/, kind: "step", label: "비율 변경 실패", title: "트래픽 비율을\n바꾸지 못했습니다", hint: "로드 밸런서 가중치를 바꾸거나 바뀐 값을 확인하지 못했습니다." },
  { match: /^TRAFFIC_/, kind: "guardrail", label: "트래픽 이동 멈춤", title: "트래픽 이동이\n멈췄습니다", hint: "트래픽 판정이 다음 단계로 넘어가지 않았습니다." },
  { match: /^(GITOPS|ARGO)_NOT_CONFIGURED$/, kind: "system", label: "배포 설정 없음", title: "배포 설정이\n없습니다", hint: "서버에 GitOps 저장소나 Argo CD 설정이 없어 배포를 시작하지 못했습니다." },
  // 승인 뒤 바뀜 (워커 gitops approvedValues): 앱을 올리기 전에 멈춘다. 도착 자원(앞 단계)은 이미 만들어져 있다
  { match: /^GITOPS_VALUES_DRIFT$/, kind: "step", label: "승인 뒤 배포 값 바뀜", title: "승인한 뒤 계획이 바뀌어\n앱을 올리지 않았습니다", hint: "승인한 배포 값과 지금 만든 값이 달라 앱을 올리기 전에 멈췄습니다. 도착 자원은 앞 단계에서 이미 만들었습니다." },
  { match: /^GITOPS_/, kind: "step", label: "배포 저장소 반영 실패", title: "배포 저장소에\n반영하지 못했습니다", hint: "도착 환경 배포 내용을 GitOps 저장소에 쓰지 못했습니다." },
  { match: /^(ARGO|DEPLOY)_/, kind: "step", label: "배포 확인 실패", title: "도착 클러스터 배포가\n끝나지 않았습니다", hint: "앱이 도착 클러스터에 정상으로 올라왔는지 확인하지 못했습니다." },
  // ECS·Cloud Run·VM 도착 배포 확인 (adapters runtime-health). 셋 다 paused 로 멈추고 재개할 수 있다
  { match: /^RUNTIME_OUTPUT_MISSING$/, kind: "step", label: "배포 결과 빠짐", title: "도착 앱을 확인할\n출력이 없습니다", hint: "자원 생성 결과에 앱을 확인할 출력(서비스 이름·주소)이 빠져 정상으로 떴는지 보지 못했습니다." },
  { match: /^RUNTIME_UNHEALTHY$/, kind: "step", label: "앱이 정상으로 안 뜸", title: "도착 앱이\n정상으로 뜨지 않았습니다", hint: "ECS·Cloud Run·VM에 올린 앱이 정해진 시간 안에 정상 상태가 되지 않았습니다." },
  { match: /^RUNTIME_CHECK_FAILED$/, kind: "system", label: "앱 상태 못 읽음", title: "도착 앱 상태를\n읽지 못했습니다", hint: "도착 앱 상태를 읽는 명령이 실패해 정상으로 떴는지 확인하지 못했습니다." },
  // 계획 단계(PLAN_IR=v2)에서 바로 failed. 계획을 만들지 않았으므로 도착에는 아무것도 생기지 않았다
  { match: /^UNSUPPORTED_V2$/, kind: "step", label: "도착이 못 만드는 구성", title: "도착 환경이 이 구성을\n만들 수 없습니다", hint: "도착 환경이 지원하지 않는 자원이나 실행 방식이 명세에 있어 계획을 만들지 않았습니다. 아무것도 만들지 않았습니다." },
  { match: /^NEEDS_HUMAN$/, kind: "step", label: "사람이 정할 것 남음", title: "사람이 정해야 할 것이\n남아 있습니다", hint: "명세에 사람이 골라야 하는 값이 남아 있어 계획을 만들지 않았습니다. 아무것도 만들지 않았습니다." },
  { match: /^APPLY_RECHECK_FAILED$/, kind: "step", label: "실행 직전 확인 실패", title: "실행 직전에\n계획이 맞지 않았습니다", hint: "승인한 계획의 지문·유효 시간·도착 환경을 다시 보니 맞지 않아 만들지 않았습니다." },
  // 승인 뒤 바뀜 (워커 apply): Terraform 을 돌리기 전에 멈춘다. 아래 TF_ 줄("일부만 생겼을 수 있음")보다 먼저 와야 한다
  { match: /^TF_PLAN_DRIFT$/, kind: "step", label: "승인 뒤 계획 바뀜", title: "승인한 뒤 계획이 바뀌어\n만들기 전에 멈췄습니다", hint: "승인한 계획과 지금 만든 계획이 달라 자원을 만들기 전에 멈췄습니다. 이번 실행으로 생긴 자원은 없습니다." },
  { match: /^TF_BIN_MISSING$/, kind: "system", label: "Terraform 없음", title: "도착 자원을 만들\n도구가 없습니다", hint: "서버에 Terraform 실행 파일이 없습니다." },
  { match: /^(TF|APPLY|AZURE_MOCK)_/, kind: "step", label: "자원 생성 실패", title: "도착 자원을\n만들지 못했습니다", hint: "도착 클러스터와 DB를 만드는 중에 멈췄습니다. 일부만 생겼을 수 있습니다." },
  { match: /^CRED_RENEW_FAILED$/, kind: "step", label: "임시 권한 재발급 실패", title: "임시 권한을\n다시 받지 못했습니다", hint: "이 단계에 필요한 임시 역할을 다시 빌리지 못해 멈췄습니다." },
  { match: /^SYNC_FAILED$/, kind: "step", label: "DB 복제 실패", title: "DB 복제가\n이어지지 않습니다", hint: "출발 DB에서 도착 DB로 가는 논리 복제가 다시 시도해도 실패했습니다." },
  { match: /^CUTOVER_UNFENCE_FAILED$/, kind: "step", label: "출발 쓰기 막힘 남음", title: "출발 DB 쓰기 막힘을\n풀지 못했습니다", hint: "컷오버를 되돌리다 출발 DB의 쓰기 막힘을 풀지 못했습니다. 바로 확인해야 합니다." },
  { match: /^CUTOVER_/, kind: "step", label: "DB 전환 실패", title: "DB 전환 중에\n문제가 생겼습니다", hint: "DB 쓰기 담당을 도착으로 넘기는 중에 멈췄습니다." },
  { match: /^ROLLBACK_FAILED$/, kind: "step", label: "되돌리기 실패", title: "되돌리기가\n끝나지 않았습니다", hint: "출발로 되돌리는 작업이 다시 시도해도 끝나지 않았습니다." },
  { match: /^IMPORT_SOURCE_UNAVAILABLE$/, kind: "step", label: "출발 환경 못 읽음", title: "출발 환경에\n닿지 못했습니다", hint: "관찰 역할로 출발 환경을 읽지 못했습니다. 연결과 권한을 확인해 주세요." },
  { match: /^IMPORT_SOURCE_INCOMPLETE$/, kind: "step", label: "앱 재료 부족", title: "옮길 앱을\n다 찾지 못했습니다", hint: "출발 환경에서 배포·포트 같은 앱 재료를 다 찾지 못했습니다." },
  { match: /^IMPORT_/, kind: "step", label: "구성 읽기 실패", title: "구성을\n읽지 못했습니다", hint: "출발 환경의 구성을 공통 명세로 바꾸지 못했습니다." },
  { match: /^(WORKER_LOST|JOB_NOT_PICKED|STEP_FAILED|JOB_FAILED_.+)$/, kind: "system", label: "작업자 응답 없음", title: "작업자가\n응답하지 않았습니다", hint: "이 단계를 맡은 워커가 끝을 알리지 않았습니다." },
  { match: /^APP_LINK_UPSTREAM_FAILED$/, kind: "step", label: "앱 연결 실패", title: "앱 연결이\n끊겼습니다", hint: "도착 앱으로 가는 연결의 상류가 응답하지 않았습니다." },
];

// 실패 코드 없이 멈춘 이전 = 가드레일 규칙이 멈췄다 (apps/api control.ts: 이때만 재개에 ruleCleared 가 필요하다)
const BY_RULE: StopReason = {
  kind: "guardrail", label: "가드레일 규칙", title: "가드레일이\n이전을 멈췄습니다", hint: "가드레일 규칙이 이 이전을 멈췄습니다. 규칙이 다시 지켜졌는지 확인한 뒤 고릅니다.",
};
const UNKNOWN: Omit<StopReason, "kind"> = {
  label: "알 수 없는 사유", title: "작업이\n끝나지 못했습니다", hint: "화면이 모르는 사유 코드입니다. 코드는 감사 기록에도 남아 있습니다.",
};

/** 멈춘 이유. 사람이 직접 롤백·취소해서 코드가 없으면 null 이다. 일시 정지는 코드가 없어도 가드레일 규칙으로 본다. */
export function stopReasonOf(code: string | null | undefined, status: MigrationStatus): StopReason | null {
  if (!code) return status === "paused" ? BY_RULE : null;
  const rule = RULES.find((r) => r.match.test(code));
  if (!rule) return { kind: "system", ...UNKNOWN };
  const { match: _match, ...reason } = rule;
  return reason;
}

// ---- 환경 연결 실패 이유 (environments.failure_reason → 사람 말) ----
// 서버는 contracts ConnectionFailure 코드나 "PERMISSION_MISSING:<동작>"을 적는다 (워커 verify-connection, api environments).
// 뒤에 붙은 동작 이름은 고칠 곳이라 문장에 그대로 넣는다. 모르는 코드는 지어내지 않고 코드를 그대로 보인다.
// 코드 모양이 아닌 글(코드로 바뀌기 전의 옛 기록)은 그대로 둔다.
const CONNECTION: Record<string, string> = {
  ROLE_ASSUME_DENIED: "임시 역할을 빌리지 못했습니다. 역할의 신뢰 정책과 확인 문구(ExternalId)를 확인해 주세요.",
  ORG_POLICY_BLOCKED: "조직 정책이 이 역할의 동작을 막았습니다. 조직 관리자에게 확인해 주세요.",
  ROLE_NOT_FOUND: "고객 계정에서 역할을 찾지 못했습니다. 연결 스크립트를 다시 실행해 주세요.",
  LINK_EXPIRED: "연결 링크가 만료됐습니다. 새 링크로 다시 연결해 주세요.",
  K8S_ACCESS_MISSING: "클러스터를 읽을 권한이 없습니다. 클러스터 이름과 접근 설정을 확인해 주세요.",
  ACCOUNT_MISMATCH: "처음 확인한 계정과 다른 계정에 연결됐습니다. 연결한 계정을 확인해 주세요.",
};

/** 연결 실패 이유 한 문장. 이유가 없으면 null. */
export function connectionReasonText(reason: string | null | undefined): string | null {
  if (!reason) return null;
  const [code = "", ...rest] = reason.split(":");
  const detail = rest.join(":").trim();
  if (code === "PERMISSION_MISSING") return detail ? `관찰 역할에 권한이 빠졌습니다: ${detail}` : "관찰 역할에 필요한 권한이 빠졌습니다.";
  if (CONNECTION[code]) return CONNECTION[code];
  if (/^[A-Z][A-Z0-9_]*$/.test(code)) return `화면이 모르는 연결 실패 사유입니다 (${reason}).`;
  return reason;
}
