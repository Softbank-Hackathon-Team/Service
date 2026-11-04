// SECAUDIT: 감사 detail 에 들어가는 값에서 주소·비밀을 가린다 (writeAudit 가 해시 전에 부른다)
// 감사는 지울 수 없고(해시 체인) 화면·보고서·AI 에이전트 입력으로 퍼진다. 그래서 "쓰는 쪽이 조심" 대신 마지막 관문에서 한 번 더 막는다
// 가리는 것: ARN·SQS 주소 안 계정 ID, DB/캐시 주소(관리형 엔드포인트, URL 안 비밀번호), 토큰(Bearer·JWT·AWS 키·Anthropic·GitHub), 비밀 이름 키의 값
// 안 가리는 것: id·코드·숫자·불리언, CIDR(사전 점검 문구), 출력 "이름"
// DRAFT(ai): 사설·공인 IPv4 단독 주소도 가린다(GCP DB·Memorystore 주소가 IP). CIDR(a.b.c.d/nn)은 남긴다
export const AUDIT_REDACTED = "<hidden>";

// DRAFT(ai): 비밀로 보는 키 이름. 대소문자 무시, 정확히 같은 이름만 (tokenId·passwordSet 같은 건 값이 비밀이 아니라 안 가림)
const SECRET_KEYS = /^(password|passwd|pwd|secret|client_?secret|secret_?access_?key|access_?key_?id|session_?token|access_?token|refresh_?token|id_?token|token|api_?key|private_?key|connection_?string|database_?url|dsn|authorization|cookie|master_?password|db_?password)$/i;

const RULES: Array<[RegExp, string | ((...m: string[]) => string)]> = [
  // URL 안 사용자:비밀번호@ (postgres://, redis://, https:// 다)
  [/\b([a-z][a-z0-9+.-]*:\/\/)([^\s:/@]+):([^\s@/]+)@/gi, (_m, s, u) => `${s}${u}:${AUDIT_REDACTED}@`],
  // ARN 안 12자리 계정 (arn:aws:iam::123456789012:role/x, arn:aws-cn:sqs:ap-1:123456789012:q)
  [/\b(arn:aws[a-z-]*:[a-z0-9-]*:[a-z0-9-]*:)\d{12}(?=:|\/)/g, (_m, p) => `${p}<account>`],
  // SQS 큐 URL 안 계정 (https://sqs.<region>.amazonaws.com/123456789012/q)
  [/(\.amazonaws\.com(?:\.cn)?\/)\d{12}(?=\/)/g, (_m, p) => `${p}<account>`],
  // 관리형 DB·캐시·검색 엔드포인트 (주소 전체)
  [/\b[a-z0-9][a-z0-9.-]*\.(?:rds|cache|docdb|redshift|es|aoss|memorydb)\.amazonaws\.com(?:\.cn)?\b/gi, AUDIT_REDACTED],
  [/\b[a-z0-9][a-z0-9.-]*\.(?:postgres\.database\.azure\.com|redis\.cache\.windows\.net)\b/gi, AUDIT_REDACTED],
  // 토큰
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g, `Bearer ${AUDIT_REDACTED}`],
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, AUDIT_REDACTED],
  [/\bsk-ant-[A-Za-z0-9_-]{8,}/g, AUDIT_REDACTED],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, AUDIT_REDACTED],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, AUDIT_REDACTED],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, AUDIT_REDACTED],
  [/\bya29\.[A-Za-z0-9._-]{10,}/g, AUDIT_REDACTED],
  // 키=값 꼴 문구 안 비밀 ("password=abc", "PGPASSWORD: abc"). "secret:db" 처럼 콜론 뒤 빈칸 없음은 ARN 자원 이름이라 안 가림
  [/\b((?:pg)?password|passwd|secret|token|api[_-]?key)(\s*=\s*|\s*:\s+)("[^"]*"|'[^']*'|[^\s,;&"'}]+)/gi, (_m, k, sep) => `${k}${sep}${AUDIT_REDACTED}`],
  // IA-1: 명령 꼴 비밀 (프로브·시작 명령). adapters import/env-rewrite.ts 의 CMD_SECRET_RULES 와 같은 꼴
  [/(\bredis-cli\b[^;&|\n]*?\s)(-a|--pass)(\s+)("[^"]*"|'[^']*'|[^\s;&|"]+)/g, (_m, pre, f, sp) => `${pre}${f}${sp}${AUDIT_REDACTED}`],
  [/(\bmysql(?:admin|dump|sh)?\b[^;&|\n]*?\s)-p(?=[^\s])("[^"]*"|'[^']*'|[^\s;&|"]+)/g, (_m, pre) => `${pre}-p${AUDIT_REDACTED}`],
  [/(--(?:password|pass)(?:=|\s+))("[^"]*"|'[^']*'|[^\s;&|"]+)/gi, (_m, pre) => `${pre}${AUDIT_REDACTED}`],
  // IPv4 단독 주소 (뒤에 /nn 이 붙은 CIDR 은 남김)
  [/\b(?<![\d.])(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b(?![\d.]|\/\d)/g, "<ip>"],
];

export function redactText(s: string): string {
  let out = s;
  for (const [re, rep] of RULES) out = out.replace(re, rep as never);
  return out;
}

/** 감사 detail 같은 JSON 값을 걸으며 문자열만 가린다. 키 이름이 비밀이면 값 통째로. 원본은 안 바꾼다 */
export function redactAuditValue<T>(v: T, depth = 0): T {
  if (depth > 20) return v;
  if (typeof v === "string") return redactText(v) as T;
  if (Array.isArray(v)) return v.map((x) => redactAuditValue(x, depth + 1)) as T;
  if (v && typeof v === "object" && !(v instanceof Date)) {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>))
      o[k] = SECRET_KEYS.test(k) && x !== null && x !== undefined && typeof x !== "boolean" ? AUDIT_REDACTED : redactAuditValue(x, depth + 1);
    return o as T;
  }
  return v;
}
