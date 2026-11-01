// LLM에 넘기기 전에 비밀처럼 보이는 값을 가린다. 원본(discover 결과)에는 원래 비밀값이 없어야 하지만,
// 환경변수에 평문 비밀번호를 넣은 고객도 있으니 한 번 더 거른다.
// DRAFT(ai): 이름·모양 규칙. 진짜 비밀 탐지기(엔트로피 검사 등)로 바꿀 자리
const SECRET_NAME = /pass(word)?|secret|token|api[_-]?key|private[_-]?key|credential|auth/i;
const SECRET_VALUE = [
  /AKIA[0-9A-Z]{16}/,                    // AWS 액세스 키
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,  // 개인 키
  /sk-ant-[A-Za-z0-9_-]{10,}/,           // Anthropic 키
  /gh[pousr]_[A-Za-z0-9]{20,}/,          // GitHub 토큰
  /:\/\/[^/\s:@]+:[^/\s@]+@/,            // 접속 주소 안의 비밀번호
];
const MAX_STR = 2000;
export const REDACTED = "[REDACTED]";

export function redact(v: unknown, keyHint = ""): unknown {
  if (typeof v === "string") {
    if (SECRET_VALUE.some((r) => r.test(v))) return REDACTED;
    if (keyHint && SECRET_NAME.test(keyHint) && !/^(arn:|projects\/)/.test(v)) return REDACTED;
    return v.length > MAX_STR ? v.slice(0, MAX_STR) + "…(잘림)" : v;
  }
  if (Array.isArray(v)) return v.map((x) => redact(x, keyHint));
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    // {name: "DB_PASSWORD", value: "..."} 모양 (ECS environment, k8s env)
    const nameHint = typeof o.name === "string" && "value" in o ? o.name : "";
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(o)) {
      out[k] = k === "value" && nameHint ? redact(x, nameHint) : redact(x, SECRET_NAME.test(k) ? k : "");
    }
    return out;
  }
  return v;
}
