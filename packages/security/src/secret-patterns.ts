// 비밀값처럼 생긴 문자열 패턴 (Z91: apps/api/src/security/scan.ts 에서 옮김 — 실제 점검의 Pod env·ConfigMap 검사와 같이 쓴다)
// DRAFT(ai): 패턴은 흔한 것만 (gitleaks 규칙 일부와 같은 모양). 놓치는 것이 있을 수 있다 → 0 은 "이 패턴으로는 0"
export const SECRET_PATTERNS: { kind: string; re: RegExp }[] = [
  { kind: "aws_access_key", re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { kind: "private_key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { kind: "github_token", re: /\b(ghp|gho|ghs|ghu)_[A-Za-z0-9]{36}\b|github_pat_[A-Za-z0-9_]{20,}/ },
  { kind: "anthropic_key", re: /sk-ant-[A-Za-z0-9_-]{20,}/ },
  { kind: "url_password", re: /[a-z][a-z0-9+.-]*:\/\/[^\s:@/"]+:(?!\[redacted\]|\*+@)[^\s@/"]+@/i },
];

// 값이 이 패턴 중 하나에 걸리면 그 종류 (값은 돌려주지 않는다)
export const secretKindOf = (v: string): string | null => SECRET_PATTERNS.find((p) => p.re.test(v))?.kind ?? null;

// 이름만 보고 비밀값 같은 env (DB_PASSWORD, API_KEY …)
export const SECRET_ENV_NAME = /(PASSWORD|PASSWD|SECRET|TOKEN|API_KEY|PRIVATE_KEY|ACCESS_KEY)/i;
