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
};

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
