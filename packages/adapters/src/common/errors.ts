// 어댑터가 던지는 오류는 전부 이 한 종류 (Z44). 코드로 구분하고, 메시지는 사람이 읽는 한 줄.
// 어댑터는 @svc/core 에 기대지 않는다 → HTTP 상태로 바꾸는 일은 부르는 쪽(api errors 플러그인, worker onError)이 한다.
// message 는 예전 throw new Error(...) 와 같은 글자다 (감사 기록·failure detail 에 그대로 들어가므로 바꾸지 않는다)
export type AdapterErrorCode =
  | "PERM_TABLE_MISSING"        // 권한표에 없는 자원 종류 (common/actions.ts)
  | "SESSION_POLICY_TOO_LONG"   // AWS 세션 정책 2,048자 초과 (aws)
  | "NAME_SPACE_EXHAUSTED"      // 자원 이름 길이 한도 안에 앱 이름이 안 들어감 (common/names.ts)
  | "IMAGE_DIGEST_MISSING"      // @sha256: 없는 이미지 (common/target.ts)
  | "PG_VERSION_UNSUPPORTED"    // Postgres 15·16·17 밖 (common/normalize.ts)
  | "DB_ENGINE_UNSUPPORTED"     // RDS 엔진이 postgres 가 아님 (common/normalize.ts)
  | "AZURE_MOCK_DISABLED"       // AZURE_MOCK=0 인데 Azure 실행기를 찾음 (runners.ts, RunnerUnavailable)
  | "SOURCE_UNAVAILABLE"        // Z88: 출발 환경을 못 읽음 (CLI 없음·자격 없음·클러스터 안 닿음). 가짜 값 대신 멈춤
  | "SOURCE_TRANSIENT"         // L5fix: 읽다가 일시 오류(연결 거부·타임아웃·TLS handshake 등). 영구 실패가 아니라 재시도
  | "SOURCE_INCOMPLETE";        // Z88: 읽었지만 명세 재료 없음 (앱 Deployment·실행 중 Pod·포트 없음)

export class AdapterError extends Error {
  constructor(public readonly code: AdapterErrorCode | (string & {}), message: string) { super(message); }
}

// 실행기를 쓸 수 없음 (설정으로 막힘). api 는 409, worker 는 failed(failureCode=code) 로 바꾼다
export class RunnerUnavailable extends AdapterError {}

export const isAdapterError = (e: unknown): e is AdapterError => e instanceof AdapterError;
