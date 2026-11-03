import { HttpError } from './http';

const BY_CODE: Record<string, string> = {
  INVALID_TRANSITION: '지금 상태에서는 할 수 없습니다. 그 사이 상태가 바뀌었을 수 있습니다.',
  NOT_FOUND: '찾을 수 없습니다. 지워졌거나 다른 회사의 항목입니다.',
  UNAUTHENTICATED: '다시 로그인해 주세요.',
  BAD_REQUEST: '보낸 값이 형식에 맞지 않습니다.',
  PLAN_HASH_MISMATCH: '그 사이 계획서가 바뀌었습니다. 새 계획서를 확인하고 다시 승인해 주세요.',
  PLAN_EXPIRED: '계획서 유효 시간이 지났습니다.',
  PLAN_SUPERSEDED: '더 새로운 계획서가 있습니다. 새 계획서로 다시 승인해 주세요.',
  PLAN_NOT_APPROVED: '계획서가 아직 승인되지 않았습니다.',
  ENV_BUSY: '이 환경은 다른 이전이 쓰고 있습니다. 그 이전이 끝난 뒤 다시 시도해 주세요.',
  GUARD_FAILED: '시작 조건을 맞추지 못했습니다. 환경이 연결되어 있는지 확인해 주세요.',
  IDEMPOTENCY_KEY_REUSED: '같은 요청이 이미 처리되었습니다. 버튼을 다시 눌러 주세요.',
  // 아래는 서버(apps/api, packages/core)가 내는 코드 중 사람이 다음 행동을 바꿔야 하는 것
  NOT_PAUSED: '이미 멈춘 상태가 아닙니다. 그 사이 재개되었거나 다른 상태로 바뀌었습니다.',
  ENV_LOCK_MISSING: '환경 잠금이 풀려 이어 갈 수 없습니다. 출발로 되돌리거나 이전을 끝내 주세요.',
  AGENT_RUN_IN_PROGRESS: '이미 점검이 돌고 있습니다. 끝난 뒤 다시 눌러 주세요.',
  LLM_KEY_MISSING: 'AI 키가 서버에 없어 점검을 돌릴 수 없습니다.',
  LLM_BUDGET_EXCEEDED: 'AI 지출 상한에 닿아 점검을 돌릴 수 없습니다.',
  SPEC_INVALID: '저장된 명세가 공통 명세 모양과 맞지 않습니다.',
  JOB_NOT_CREATED: '작업을 큐에 넣지 못했습니다. 잠시 뒤 다시 시도해 주세요.',
  AZURE_MOCK_DISABLED: '이 서버에서는 Azure 모의 환경이 꺼져 있습니다.',
  TUNNEL_READ_ONLY: '공개 터널로 들어온 개발용 접속은 읽기만 됩니다.',
  RATE_LIMITED: '요청이 너무 많습니다. 잠시 뒤 다시 시도해 주세요.',
  TOKEN_REVOKED: '로그아웃된 세션입니다. 다시 로그인해 주세요.',
  USER_DISABLED: '이 계정은 꺼졌거나 회사에서 빠졌습니다. 회사 관리자에게 확인해 주세요.',
  // 승인·시작 (apps/api plans.ts, core tenant-limit.ts)
  ACKS_MISSING: '확인하지 않은 항목이 있습니다. 계획서를 다시 읽었으니 확인 항목을 모두 체크해 주세요.',
  TENANT_BUSY: '회사에서 동시에 진행할 수 있는 이전 수를 넘었습니다. 승인은 그대로이니 다른 이전이 끝난 뒤 다시 시작해 주세요.',
  // 다시 시도 (apps/api plans.ts replan, control.ts resume, core retry-budget.ts)
  RETRY_BUDGET_EXHAUSTED: '플랫폼이 부담하는 재시도 횟수를 다 썼습니다. 다시 시도하려면 비용을 고객이 부담하는 데 동의해 주세요.',
  REPLAN_NOT_ALLOWED: '이 단계에서 실패한 이전은 계획을 다시 만들 수 없습니다. 이 이전을 끝내고 새로 시작해 주세요.',
  // 명세 고치기 (apps/api spec.ts PATCH)
  SPEC_VERSION_CONFLICT: '그 사이 명세가 바뀌었습니다. 새 명세를 다시 읽었으니 확인한 뒤 다시 확정해 주세요.',
  SPEC_PATH_IR_MISMATCH: '이 명세 판과 맞지 않는 칸을 보냈습니다. 화면을 새로 고친 뒤 다시 확정해 주세요.',
  SPEC_INCLUDE_UNAVAILABLE: '가져올 때 이 자원의 값을 읽어 두지 않아 이 앱으로 끌어올 수 없습니다.',
  SPEC_PATCH_INVALID: '바꾼 명세가 공통 명세 규칙에 맞지 않아 저장하지 않았습니다.',
  SPEC_DRAFT_NOT_ACCEPTED: 'AI 초안만 있는 명세입니다. 초안을 받아들인 뒤 확정해 주세요.',
  SPEC_DRAFT_STALE: '사람이 확정한 판보다 오래된 AI 초안이라 받아들이지 않았습니다.',
  // 환경 (apps/api environments.ts). 연결 마법사는 아직 화면에 없지만 같은 문장을 쓴다
  ENV_IN_USE: '이 환경을 쓰는 이전이 진행 중이라 지금은 바꿀 수 없습니다.',
  ENV_NAME_TAKEN: '같은 이름의 환경이 이미 있습니다. 다른 이름을 써 주세요.',
  BAD_ACCOUNT_ID: '계정 번호 모양이 맞지 않습니다. AWS는 12자리 숫자, GCP는 프로젝트 ID입니다.',
  LINK_EXPIRED: '연결 링크가 만료됐습니다. 새 링크를 받아 다시 연결해 주세요.',
  ENV_DISCONNECTED: '연결이 해제된 환경입니다. 환경을 다시 연결해 주세요.',
};

/** 서버가 준 오류 코드 (ApiError.code). 화면이 다음 행동을 고를 때 쓴다. 서버 오류가 아니면 null. */
export function errorCode(reason: unknown): string | null {
  return reason instanceof HttpError ? (reason.body?.code ?? null) : null;
}

/** 화면에 보여 줄 한 문장. 서버 원문은 개발자 도구의 응답에서 본다. */
export function errorText(reason: unknown): string {
  if (reason instanceof TypeError) return '서버에 연결하지 못했습니다. 잠시 뒤 다시 시도해 주세요.';
  if (reason instanceof HttpError) {
    const code = reason.body?.code;
    if (code && BY_CODE[code]) return BY_CODE[code];
    if (reason.status >= 500) return '서버에 문제가 생겼습니다. 잠시 뒤 다시 시도해 주세요.';
  }
  return '요청을 처리하지 못했습니다.';
}
