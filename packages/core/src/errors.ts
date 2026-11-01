export class DomainError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}
export class NotFound extends DomainError {
  constructor(what: string, id: string) { super(404, "NOT_FOUND", `${what} ${id}`); }
}
export class InvalidTransition extends DomainError {
  constructor(from: string, to: string) {
    super(409, "INVALID_TRANSITION", `${from} -> ${to}`);
  }
}
export class LeaseLost extends DomainError {
  constructor(id: string) { super(409, "LEASE_LOST", id); }
}
export class JobNotCreated extends DomainError {
  constructor(q: string) { super(409, "JOB_NOT_CREATED", q); }
}
// VALID에는 있는 이동이지만 조건(guard)이 안 맞을 때. 어떤 조건인지 message에 적는다
export class GuardFailed extends DomainError {
  constructor(from: string, to: string, reason: string) {
    super(409, "GUARD_FAILED", `${from} -> ${to}: ${reason}`);
  }
}
// 승인할 때 다른 이전이 그 환경을 쥐고 있음
export class EnvBusy extends DomainError {
  constructor(envId: string) { super(409, "ENV_BUSY", envId); }
}
// 같은 멱등 키를 다른 요청(경로·본문)에 다시 씀
export class IdempotencyKeyReused extends DomainError {
  constructor() { super(409, "IDEMPOTENCY_KEY_REUSED", "same Idempotency-Key, different request"); }
}
export class BadRequest extends DomainError {
  constructor(code: string, message: string) { super(400, code, message); }
}
