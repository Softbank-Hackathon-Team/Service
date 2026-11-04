// 비밀·주소 가리기 규칙 한 곳 (LLM-1). 감사(core/audit.ts)·LLM 입력(agent)·가져오기(adapters env-rewrite)가 전부 여기서 가져다 쓴다.
// 예전엔 규칙이 4벌(core/redact, agent/draft/redact, agent/ai/guard, adapters/import/env-rewrite)로 따로 놀아
//   LLM 으로 가는 쪽이 감사 기록보다 덜 가렸다(계정 ID·ARN·RDS 주소·IP·인자 속 password= 가 그대로).
// 아래 SECRET_NAME·SECRET_VALUE_PATTERNS 는 agent 쪽 "통째로 가리기" 판단용, RULES(redactText)는 글 안 부분 가리기용.
// 원래 core/redact.ts(SECAUDIT) 내용을 그대로 옮겼다. core 는 이 파일을 다시 내보낸다.

// DRAFT(ai): 비밀로 보이는 이름(키 이름·env 이름). 넓게 잡는다 (LLM 입력·매니페스트 가리기용)
export const SECRET_NAME = /pass(word)?|secret|token|api[_-]?key|private[_-]?key|credential|auth/i;
// DRAFT(ai): 값 모양만 봐도 비밀인 것 (g 플래그 없음 → test 에 안전)
export const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /AKIA[0-9A-Z]{16}/,                    // AWS 액세스 키
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,  // 개인 키
  /sk-ant-[A-Za-z0-9_-]{10,}/,           // Anthropic 키
  /gh[pousr]_[A-Za-z0-9]{20,}/,          // GitHub 토큰
  /:\/\/[^/\s:@]+:[^/\s@]+@/,            // 접속 주소 안의 비밀번호
];
export const looksSecretValue = (v: string) => SECRET_VALUE_PATTERNS.some((r) => r.test(v));

// SECAUDIT: 감사 detail 에 들어가는 값에서 주소·비밀을 가린다 (writeAudit 가 해시 전에 부른다)
// 감사는 지울 수 없고(해시 체인) 화면·보고서·AI 에이전트 입력으로 퍼진다. 그래서 "쓰는 쪽이 조심" 대신 마지막 관문에서 한 번 더 막는다
// 가리는 것: ARN·SQS·ECR 주소 안 계정 ID, GCP 서비스 계정·Artifact Registry 주소 안 프로젝트(AUD-1), DB/캐시 주소(관리형 엔드포인트, URL 안 비밀번호), 토큰(Bearer·JWT·AWS 키·Anthropic·GitHub), 비밀 이름 키의 값
// 안 가리는 것: id·코드·숫자·불리언, CIDR(사전 점검 문구), 출력 "이름"
// DRAFT(ai): 사설·공인 IPv4 단독 주소도 가린다(GCP DB·Memorystore 주소가 IP). CIDR(a.b.c.d/nn)은 남긴다
export const AUDIT_REDACTED = "<hidden>";
// LLM-1: 가리기 규칙이 넣는 자리 표시 전부 (이 파일의 <hidden>·<ip>·<account>·<project>, agent 의 [REDACTED]).
//   LLM 은 가린 글을 보므로, LLM 이 쓴 값에 이게 있으면 원래 값을 모르고 베낀 것 → 쓰지 않는다
export const hasRedactionPlaceholder = (s: string) => /\[REDACTED\]|<hidden>|<ip>|<account>|<project>/.test(s);
export const countRedactionPlaceholders = (s: string) => (s.match(/\[REDACTED\]|<hidden>|<ip>|<account>|<project>/g) ?? []).length;

// DRAFT(ai): 비밀로 보는 키 이름. 대소문자 무시, 정확히 같은 이름만 (tokenId·passwordSet 같은 건 값이 비밀이 아니라 안 가림)
const SECRET_KEYS_EXACT = /^(password|passwd|pwd|secret|client_?secret|secret_?access_?key|access_?key_?id|session_?token|access_?token|refresh_?token|id_?token|token|api_?key|private_?key|connection_?string|database_?url|dsn|authorization|cookie|master_?password|db_?password|external_?id)$/i;
// RV-13 DRAFT(ai): 정확히 같은 이름만 보면 AWS_SESSION_TOKEN·CLOUDFLARE_API_TOKEN·cloudflareApiToken·TF_VAR_db_password 같은 실제 이름이 빠진다.
//   로그 쪽(core obs/log.ts VLOGLEAK)과 같은 규칙으로: _ - 를 빼고 소문자로 바꾼 이름이 비밀 낱말로 끝나면 비밀. input_tokens·max_tokens·token_count 는 끝이 달라 그대로
const SECRET_KEY_SUFFIX = /(password|passwd|secret|token|apikey|accesskey|secretkey|privatekey|externalid)$/;
const SECRET_KEYS = { test: (k: string): boolean => SECRET_KEYS_EXACT.test(k) || SECRET_KEY_SUFFIX.test(k.toLowerCase().replace(/[_-]/g, "")) };

// PF FM-ORC-18: terraform·gcloud·aws 오류 꼬리에 실리는 비밀 모양 (감사·로그 둘 다 이 목록을 쓴다: core obs/log scrubString)
//   예전 규칙은 "password=" 처럼 낱말 경계가 앞에 있어야 해서 aws_secret_access_key = …, TF_VAR_db_password=…, db_password = "…" 를 놓쳤다
export const SECRET_SHAPE_RULES: Array<[RegExp, string | ((...m: string[]) => string)]> = [
  // PEM 개인 키 (JSON 안에서 \n 으로 이스케이프된 것도). 끝 줄이 잘렸으면 글 끝까지
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, AUDIT_REDACTED],
  // 사용자 이름 없는 URL 비밀번호 (redis://:pw@host)
  [/\b([a-z][a-z0-9+.-]*:\/\/):([^\s@/]+)@/gi, (_m, sc) => `${sc}:${AUDIT_REDACTED}@`],
  // 이름 안에 비밀 낱말이 든 키 = 값 (aws_secret_access_key = …, TF_VAR_db_password=…, db_password = "…", "client_secret": "…")
  [/(["']?\b[A-Za-z0-9_.-]*(?:password|passwd|secret|token(?!s)|api[_-]?key|private[_-]?key|access[_-]?key)[A-Za-z0-9_.-]*["']?)(\s*=\s*|\s*:\s+|["']?\s*:\s*(?=["']))("[^"]*"|'[^']*'|[^\s,;&"'}]+)/gi,
    (_m, k, sep) => `${k}${sep}${AUDIT_REDACTED}`],
  // "token" 뒤 가까이(20자 안) 오는 긴 토큰 (Cloudflare API 토큰 40자 등). git 커밋 번호처럼 맥락 없는 40자, "token:<uuid>" 같은 감사 대상 이름은 남긴다
  [/(\btoken\b[^A-Za-z0-9\n]{1,20}(?:[A-Za-z]+[^A-Za-z0-9\n]{1,5}){0,2})(?![0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b)[A-Za-z0-9_-]{32,}/gi, (_m, pre) => `${pre}${AUDIT_REDACTED}`],
];
export function redactSecretShapes(s: string): string {
  let out = s;
  for (const [re, rep] of SECRET_SHAPE_RULES) out = out.replace(re, rep as never);
  return out;
}

const RULES: Array<[RegExp, string | ((...m: string[]) => string)]> = [
  ...SECRET_SHAPE_RULES,
  // URL 안 사용자:비밀번호@ (postgres://, redis://, https:// 다)
  [/\b([a-z][a-z0-9+.-]*:\/\/)([^\s:/@]+):([^\s@/]+)@/gi, (_m, s, u) => `${s}${u}:${AUDIT_REDACTED}@`],
  // ARN 안 12자리 계정 (arn:aws:iam::123456789012:role/x, arn:aws-cn:sqs:ap-1:123456789012:q)
  [/\b(arn:aws[a-z-]*:[a-z0-9-]*:[a-z0-9-]*:)\d{12}(?=:|\/)/g, (_m, p) => `${p}<account>`],
  // SQS 큐 URL 안 계정 (https://sqs.<region>.amazonaws.com/123456789012/q)
  [/(\.amazonaws\.com(?:\.cn)?\/)\d{12}(?=\/)/g, (_m, p) => `${p}<account>`],
  // AUD-1: ECR 이미지 주소 안 계정 (123456789012.dkr.ecr.<리전>.amazonaws.com/repo) — 저장소 이름·태그·digest 는 남김
  [/\b\d{12}(?=\.dkr\.ecr(?:-fips)?\.[a-z0-9-]+\.amazonaws\.com)/g, "<account>"],
  // AUD-1: GCP 서비스 계정 이메일 안 프로젝트 (name@<프로젝트>.iam.gserviceaccount.com) — 계정 이름은 남김
  [/(@)[a-z][a-z0-9-]{4,28}[a-z0-9](?=\.iam\.gserviceaccount\.com\b)/g, (_m, at) => `${at}<project>`],
  // AUD-1: Artifact Registry 이미지 주소 안 프로젝트 (<리전>-docker.pkg.dev/<프로젝트>/repo/img)
  [/(\b[a-z0-9-]+-docker\.pkg\.dev\/)[a-z][a-z0-9-]{4,28}[a-z0-9](?=\/)/g, (_m, p) => `${p}<project>`],
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

// PF FM-ORC-11: Postgres text·jsonb 가 못 받는 글자(NUL, 짝 없는 서로게이트)를 U+FFFD 로. 감사 detail 에 terraform·외부 오류 원문이
//   그대로 들어가면 INSERT 가 던져 같은 트랜잭션의 상태 전이·실패 기록까지 취소됐다 (죽은 작업 처리도 같은 글로 또 실패 → 리퍼 WORKER_LOST)
const PG_UNSAFE = /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
export const pgSafeText = (s: string): string => s.replace(PG_UNSAFE, "\uFFFD");

export function redactText(s: string): string {
  let out = pgSafeText(s);
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
    for (const [k0, x] of Object.entries(v as Record<string, unknown>)) {
      const k = pgSafeText(k0);
      o[k] = SECRET_KEYS.test(k) && x !== null && x !== undefined && typeof x !== "boolean" ? AUDIT_REDACTED : redactAuditValue(x, depth + 1);
    }
    return o as T;
  }
  return v;
}
