// LLM에 넘기기 전에 비밀·고객 식별 값을 가린다. 원본(discover 결과)에는 원래 비밀값이 없어야 하지만,
// 환경변수·인자에 평문 비밀번호를 넣은 고객도 있으니 한 번 더 거른다.
// LLM-1: 규칙은 contracts/src/redact.ts 한 곳. 감사 기록보다 덜 가리면 안 되므로 감사 규칙(redactText: 계정 ID·ARN·
//   관리형 DB 주소·IPv4·password= 꼴 글·토큰)을 모든 글에 같이 건다. 그 위에 이 파일만의 "통째로 가리기"를 더한다:
//   비밀 모양 값, 비밀 이름 키(넓은 SECRET_NAME)의 값, {name: DB_PASSWORD, value: ...} 꼴의 value.
// DRAFT(ai): 이름·모양 규칙. 진짜 비밀 탐지기(엔트로피 검사 등)로 바꿀 자리
import { SECRET_NAME, looksSecretValue, redactText } from "@svc/contracts";

const MAX_STR = 2000;
export const REDACTED = "[REDACTED]";

export function redact(v: unknown, keyHint = ""): unknown {
  if (typeof v === "string") {
    if (looksSecretValue(v)) return REDACTED;
    if (keyHint && SECRET_NAME.test(keyHint) && !/^(arn:|projects\/)/.test(v)) return REDACTED;
    const s = redactText(v);
    return s.length > MAX_STR ? s.slice(0, MAX_STR) + "…(잘림)" : s;
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

// LLM-1: 바깥 LLM 으로 나가기 직전 마지막 관문. 사용자 차례 메시지(첫 지시·도구 결과)의 글에 공통 규칙(redactText)을 건다.
//   도구마다 redact 를 부르지만, 새 도구가 빠뜨려도 여기서 막힌다. assistant 차례(모델이 쓴 글·서명된 thinking)는 안 건드린다.
//   원본은 안 바꾼다
type Block = Record<string, unknown>;
const scrubBlock = (b: unknown): unknown => {
  if (typeof b === "string") return redactText(b);
  if (!b || typeof b !== "object") return b;
  const x = b as Block;
  if (x.type === "text" && typeof x.text === "string") return { ...x, text: redactText(x.text) };
  if (x.type === "tool_result") {
    const c = x.content;
    return { ...x, content: typeof c === "string" ? redactText(c) : Array.isArray(c) ? c.map(scrubBlock) : c };
  }
  return b;
};
export function redactOutboundMessages<M extends { role: string; content: unknown }>(messages: readonly M[]): M[] {
  return messages.map((m) => (m.role !== "user" ? m
    : { ...m, content: typeof m.content === "string" ? redactText(m.content) : Array.isArray(m.content) ? m.content.map(scrubBlock) : m.content }));
}
