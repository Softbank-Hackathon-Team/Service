import { z } from "zod";

// Z81-09: 시작할 때 설정(환경 변수) 검사 표 한 곳. api·worker·agent-worker 가 main 첫 줄에서 부른다 (core assertConfig).
// 왜: 예전엔 잘못된 값이 늦게, 하나씩 터졌다 (VM 실측, CHANGES z81-09)
//   - DATABASE_URL 없음 → 큐 시작 때 pg 오류 스택으로 죽음 (무엇이 빠졌는지 안 나옴)
//   - API_PORT=abc → 큐까지 다 띄운 뒤 listen 에서 죽음
//   - METRICS_PORT=abc → NaN > 0 이 거짓이라 지표 서버가 조용히 안 뜸
//   - AGENT_LLM_PROVIDER·AGENT_LLM·SANDBOX_MODE 는 첫 틀린 값 하나에서만 멈춤
// 지금: 틀린 것을 한 번에 모두 목록으로 내고 끝 코드 2. 값은 메시지에 넣지 않는다 (이름과 이유만. 비밀값이 로그에 안 남게)
// 규칙은 지금 코드가 받아들이는 값을 옮겼다. 새로 막는 것은 "숫자가 아님"과 뜻 없는 값(시도 횟수 0, 포트 범위 밖)뿐
//   → 지금 돌던 설정은 그대로 통과해야 한다 (시험 z81-config.test.ts 가 .env.example·compose 값으로 본다)
//   읽는 쪽 코드(envNumber 등)는 그대로 둔다. 이 표는 "미리 보기"만 한다

const blank = (v: string | undefined) => v === undefined || v.trim() === "";
type Check = (v: string) => string | null;   // null = 통과, 글자 = 이유

const num = (o: { min?: number; int?: boolean; max?: number } = {}): Check => (v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return "숫자가 아님";
  if (o.int && !Number.isInteger(n)) return "정수여야 함";
  if (o.min !== undefined && n < o.min) return `${o.min} 이상이어야 함`;
  if (o.max !== undefined && n > o.max) return `${o.max} 이하여야 함`;
  return null;
};
const port: Check = num({ int: true, min: 0, max: 65535 });
const oneOf = (...xs: string[]): Check => (v) => (xs.includes(v.trim()) ? null : `다음 중 하나: ${xs.join(" | ")}`);
const pgUrl: Check = (v) => {
  try { const u = new URL(v); return u.protocol === "postgres:" || u.protocol === "postgresql:" ? null : "postgres:// 주소가 아님"; }
  catch { return "주소 모양이 아님"; }
};

// 입력층 L2: CloudFormation 빠른 생성 링크의 templateURL 은 https 주소여야 한다 (S3 주소만 되는 건 AWS 쪽 규칙)
const httpsUrl: Check = (v) => {
  try { return new URL(v.trim()).protocol === "https:" ? null : "https:// 주소가 아님"; }
  catch { return "주소 모양이 아님"; }
};

// 이름 → 검사. required 가 아니면 비어 있어도 된다 (비면 코드 기본값)
interface Rule { check?: Check; required?: true }
const COMMON: Record<string, Rule> = {
  DATABASE_URL: { required: true, check: pgUrl },
  LOG_LEVEL: { check: oneOf("trace", "debug", "info", "warn", "error", "fatal", "silent") },
  DB_POOL_MAX: { check: num({ int: true, min: 1 }) },
  WORKER_POLL_SEC: { check: num({ min: 0.5 }) },
  BOSS_SUPERVISE_SEC: { check: num({ min: 1 }) },
  ROLLBACK_WINDOW_SEC: { check: num({ min: 0 }) },
  REPL_MAX_MARKER_RTT_MS: { check: num({ min: 0 }) },
  SPEC_MIN_CONFIDENCE: { check: num({ min: 0, max: 1 }) },   // DRAFT(ai): 0 = 꺼짐(기본)
  SHUTDOWN_HARD_TIMEOUT_MS: { check: num({ min: 0 }) },
  FAILURE_ANALYSIS: { check: oneOf("0", "1") },               // PA5a: 실패 원인 분석 넣기. 기본 꺼짐(A5b 머지 전)
  RETRY_BUDGET: { check: num({ int: true, min: 0 }) },        // PA5a DRAFT(ai): 이전당 사람 재시도 한도 (기본 3, 0 = 끔)
  TENANT_MAX_ACTIVE: { check: num({ int: true, min: 0 }) },   // DRAFT(ai): 회사당 동시 진행 이전 상한. 0 = 꺼짐(기본)
};
export const CONFIG_RULES = {
  api: {
    ...COMMON,
    API_PORT: { check: port },
    METRICS_PORT: { check: port },
    RATE_LIMIT_READ_PER_MIN: { check: num({ min: 0 }) },
    RATE_LIMIT_WRITE_PER_MIN: { check: num({ min: 0 }) },
    COST_CACHE_TTL_MS: { check: num({ min: 0 }) },
    REPORT_CHAIN_LIMIT: { check: num({ int: true, min: 1 }) },
    // 입력층 L2: AWS 연결 링크. 비면 링크 발급이 503 CONNECT_NOT_CONFIGURED (서버는 뜬다)
    CONNECT_TEMPLATE_URL: { check: httpsUrl },
    PLATFORM_PRINCIPAL_ARN: { check: (v) => (/^arn:aws:iam::\d{12}:role\/[\w+=,.@\/-]+$/.test(v.trim()) ? null : "IAM 역할 ARN 모양이 아님") },
  },
  worker: {
    ...COMMON,
    WORKER_METRICS_PORT: { check: port },
    STEP_ROLE_TTL_SEC: { check: num({ min: 1 }) },
    CRED_RENEW_SEC: { check: num({ min: 0 }) },
    STUB_DELAY_MS: { check: num({ min: 0 }) },
    IMPORT_MAX_ATTEMPTS: { check: num({ int: true, min: 1 }) },
    IMPORT_IR: { check: oneOf("v1", "v2") },                    // I3b: 가져오기 공통 명세 판. v2 = spec_v2 도 저장(v1 은 그대로). 기본 v1
    MAX_CUTOVER_ATTEMPTS: { check: num({ int: true, min: 1 }) },
    ROLLBACK_MAX_ATTEMPTS: { check: num({ int: true, min: 1 }) },
    REPL_MAX_CATCHUP_MS: { check: num({ min: 0 }) },
    TRAFFIC_TICK_MS: { check: num({ min: 0 }) },
    TRAFFIC_OBSERVE_SEC: { check: num({ min: 0 }) },
    TEMP_ROLE_SWEEP_MS: { check: num({ min: 1 }) },
    // L4b: 주기 재확인 일정. cron 5칸 또는 off (모양만 본다. 값은 pg-boss 가 다시 검사)
    VERIFY_CRON: { check: (v) => v.trim() === "off" || v.trim().split(/\s+/).length === 5 ? null : "cron 5칸 또는 off" },
    REAL_STS: { check: oneOf("0", "1") },   // L4: 1 = 진짜 AWS STS(CLI), external_id 있는 환경만. 운영 스위치 (시험 전용 아님)
    GCP_PLATFORM_PROJECT: { check: (v) => (/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(v.trim()) ? null : "GCP 프로젝트 ID 모양이 아님") },   // L7i: REAL_STS=1 일 때 GCP 발급기가 쓰는 플랫폼 프로젝트 ID
  },
  "agent-worker": {
    ...COMMON,
    AGENT_LLM_PROVIDER: { check: oneOf("anthropic", "mock") },
    AGENT_LLM: { check: oneOf("scripted", "real") },
    AGENT_LLM_EFFORT: { check: oneOf("low", "medium", "high", "xhigh", "max") },
    SANDBOX_MODE: { check: oneOf("memory", "k3d") },
  },
} satisfies Record<string, Record<string, Rule>>;
export type ConfigService = keyof typeof CONFIG_RULES;

// 여러 값이 같이 맞아야 하는 것 (값은 안 봄, 있는지만)
const CROSS: Partial<Record<ConfigService, (env: NodeJS.ProcessEnv) => string[]>> = {
  "agent-worker": (env) => {
    const out: string[] = [];
    const key = !blank(env.ANTHROPIC_API_KEY);
    if (env.AGENT_LLM_PROVIDER?.trim() === "anthropic" && !key) out.push("ANTHROPIC_API_KEY: AGENT_LLM_PROVIDER=anthropic 이면 있어야 함");
    if (env.AGENT_LLM?.trim() === "real" && !key) out.push("ANTHROPIC_API_KEY: AGENT_LLM=real 이면 있어야 함");
    return out;
  },
};

// z75-68 (Z62): 시험 전용 스위치. 켜져 있으면 진짜 대신 흉내(데모 원본·IaC·Argo·사전 점검·가짜 LLM·개발 헤더 인증)로 돈다.
//   MOCK_CREDS 는 Z105-01, MOCK_REPL·MOCK_TRAFFIC 은 Z100 (Z38 R8-50 로 추가)
//   데모(DEMO_MODE=1)에서 하나라도 켜져 있으면 서비스가 뜨지 않는다 (끝 코드 2, 이름만 찍음). 빈 값·"0" 은 꺼짐
//   NODE_ENV=production 은 조건에 넣지 않았다: 운영 이미지(Dockerfile)가 늘 production 이고 운영 e2e(verify-round prod-e2e)가 이 스위치로 돈다
export const TEST_ONLY_SWITCHES = ["MOCK_SEED", "MOCK_IAC", "MOCK_ARGO", "MOCK_PRECHECK", "FAKE_LLM", "DEV_AUTH", "MOCK_CREDS", "MOCK_REPL", "MOCK_TRAFFIC"] as const;
export function testSwitchesOn(env: NodeJS.ProcessEnv = process.env): string[] {
  return TEST_ONLY_SWITCHES.filter((k) => { const v = env[k]?.trim(); return !!v && v !== "0"; });
}
export function demoSwitchProblems(env: NodeJS.ProcessEnv = process.env): string[] {
  if (env.DEMO_MODE?.trim() !== "1") return [];
  return testSwitchesOn(env).map((k) => `${k}: 시험 전용이라 DEMO_MODE=1 에서는 켤 수 없음 (.env 에서 지우거나 0)`);
}

// Zod 로 감싼 이유: 다른 계약과 같은 방식(safeParse → issues)으로 모든 문제를 한 번에 모은다
function schemaFor(service: ConfigService) {
  const rules = CONFIG_RULES[service] as Record<string, Rule>;
  return z.looseObject({}).superRefine((env, ctx) => {
    for (const [name, r] of Object.entries(rules)) {
      const v = env[name] as string | undefined;
      if (blank(v)) { if (r.required) ctx.addIssue({ code: "custom", path: [name], message: "없음 (꼭 필요)" }); continue; }
      const why = r.check?.(v!);
      if (why) ctx.addIssue({ code: "custom", path: [name], message: why });
    }
  });
}

// 문제 목록. 빈 배열이면 통과. 각 줄 = "이름: 이유" (값은 넣지 않는다)
export function configProblems(service: ConfigService, env: NodeJS.ProcessEnv = process.env): string[] {
  const r = schemaFor(service).safeParse(env);
  const out = r.success ? [] : r.error.issues.map((i) => `${String(i.path[0])}: ${i.message}`);
  return [...out, ...(CROSS[service]?.(env) ?? []), ...demoSwitchProblems(env)];
}
