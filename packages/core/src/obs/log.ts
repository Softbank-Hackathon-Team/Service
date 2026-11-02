import { AsyncLocalStorage } from "node:async_hooks";

// 구조화 로그: 한 줄 = JSON 하나. api(Fastify 내장 pino)와 worker·agent-worker(이 파일)가 같은 모양을 쓴다
//   {"level":"info","time":"2026-11-07T01:02:03.456Z","service":"worker","msg":"transition",
//    "tenant_id":"…","migration_id":"…","job_id":"…","queue":"sync","prev_state":"syncing","state":"shifting"}
// 필드 이름은 snake_case 로 통일한다 (로그 검색에서 tenant_id=… 한 번으로 api·worker 줄을 같이 찾게)
// DRAFT(ai): pino 를 직접 의존하지 않고 같은 모양을 손으로 찍는다. worker 에 새 의존성을 늘리지 않으려고

export const LOG_FIELDS = ["tenant_id", "migration_id", "state", "job_id", "queue", "request_id"] as const;
export type LogContext = Partial<Record<(typeof LOG_FIELDS)[number] | "prev_state" | "agent_run_id", string>>;

const LEVELS = { debug: 20, info: 30, warn: 40, error: 50 } as const;
export type LogLevel = keyof typeof LEVELS;

const ctxStore = new AsyncLocalStorage<LogContext>();

// 이 함수 안에서 찍는 모든 로그에 ctx 필드가 붙는다 (await 너머까지 따라간다)
export function withLogContext<T>(ctx: LogContext, fn: () => T): T {
  const merged = { ...(ctxStore.getStore() ?? {}), ...dropEmpty(ctx) };
  return ctxStore.run(merged, fn);
}
export function currentLogContext(): LogContext { return ctxStore.getStore() ?? {}; }

// 작업 내용(job data)에서 로그 필드를 뽑는다. 모르는 모양이면 있는 것만
export function contextFromJob(queue: string, jobId: string | undefined, data: unknown): LogContext {
  const d = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
  const s = (k: string) => (typeof d[k] === "string" ? (d[k] as string) : undefined);
  return dropEmpty({ queue, job_id: jobId, tenant_id: s("tenantId"), migration_id: s("migrationId"),
    request_id: s("requestId"), agent_run_id: s("agentRunId") });
}

// LOGLEAK DRAFT(ai): 로그에 비밀값이 안 남게 한다. 대안: pino redact 경로만(깊이 1단·문자열 속은 못 가림) → worker 로그는 pino 가 아니라 못 씀
//   (1) 비밀 이름의 칸은 깊이 상관없이 값을 가림  (2) 문자열 속 DB 접속 주소 비밀번호·Bearer·토큰 모양(JWT·svc_pat_·et_·세션 쿠키·sk-ant-·AKIA)을 가림
//   칸 이름은 정확히 맞는 것만 (input_tokens 같은 숫자 칸은 건드리지 않는다)
// VLOGLEAK: 칸 이름을 소문자로 바꾸고 _ - 를 뺀 뒤 판단한다 → AWS_SECRET_ACCESS_KEY, PGPASSWORD, newPassword, awsSessionToken, bearerToken 도 잡힌다
//   끝이 비밀 낱말이면 비밀(…password/…secret/…token/…apikey/…accesskey/…secretkey/…privatekey/…signature), 이름 전체가 같을 때만 비밀인 낱말은 따로(auth, cookie …)
//   input_tokens·max_tokens·token_count·primary_key·external_id 는 끝이 달라 그대로 남는다
const SECRET_SUFFIX = /(password|passwd|pwd|secret|token|apikey|accesskey|secretkey|privatekey|signature|credential|credentials)$/;
const SECRET_EXACT = new Set(["auth", "authorization", "cookie", "setcookie", "xagentkeyid", "databaseurl", "ownerdatabaseurl", "connectionstring", "dsn", "connectionurl"]);
const SECRET_KEY = { test: (k: string): boolean => { const n = k.toLowerCase().replace(/[_-]/g, ""); return SECRET_EXACT.has(n) || SECRET_SUFFIX.test(n); } };
export const REDACTED = "[redacted]";
const TOKEN_SHAPES: Array<[RegExp, string]> = [
  [/\b([a-z][a-z0-9+.-]*:\/\/[^\s:\/@"']*):([^\s@\/"']+)@/gi, `$1:${REDACTED}@`],       // scheme://user:pass@host
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/=-]{6,}/gi, `$1 ${REDACTED}`],
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]{2,}/g, REDACTED],             // JWT
  [/\bsvc_(pat|refresh)_[A-Za-z0-9_-]{8,}/g, REDACTED],
  [/\bet_[A-Za-z0-9_-]{43}\b/g, REDACTED],
  [/\bsk-ant-[A-Za-z0-9_-]{8,}/g, REDACTED],
  [/\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, REDACTED],
  [/(svc_refresh=)[^;\s"]+/g, `$1${REDACTED}`],
  [/([?&](?:access_?token|token|api_?key|key|secret|password|signature|sig)=)[^&\s"]+/gi, `$1${REDACTED}`],
];
export function scrubString(s: string): string {
  let out = s;
  for (const [re, to] of TOKEN_SHAPES) out = out.replace(re, to);
  return out;
}
export function scrubValue(v: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (typeof v === "string") return scrubString(v);
  if (typeof v === "bigint") return v.toString();          // JSON.stringify 가 BigInt 에서 던지지 않게
  if (v == null || typeof v !== "object") return v;
  if (ArrayBuffer.isView(v) || v instanceof ArrayBuffer) return `[binary ${(v as { byteLength: number }).byteLength} bytes]`;   // 바이트를 숫자 목록으로 찍지 않는다
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  if (v instanceof Map) return scrubValue(Object.fromEntries([...v].map(([k, x]) => [String(k), x])), depth, seen);
  if (v instanceof Set) return scrubValue([...v], depth, seen);
  if (depth > 8) return "[too deep]";
  if (seen.has(v)) return "[circular]";
  seen.add(v);
  if (v instanceof Error) return scrubValue(errorFields(v), depth + 1, seen);
  if (Array.isArray(v)) return v.map((x) => scrubValue(x, depth + 1, seen));
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) out[k] = SECRET_KEY.test(k) && x != null && x !== "" ? REDACTED : scrubValue(x, depth + 1, seen);
  return out;
}
function errorFields(v: Error) {
  return { type: v.name, message: v.message, ...(("code" in v) ? { code: (v as { code: unknown }).code } : {}),
    ...(process.env.LOG_LEVEL === "debug" ? { stack: v.stack } : {}) };
}

export interface Logger {
  debug(fields: Record<string, unknown> | string, msg?: string): void;
  info(fields: Record<string, unknown> | string, msg?: string): void;
  warn(fields: Record<string, unknown> | string, msg?: string): void;
  error(fields: Record<string, unknown> | string, msg?: string): void;
  child(fields: Record<string, unknown>): Logger;
}

export interface LoggerOpts {
  level?: LogLevel;
  write?: (line: string) => void;      // 시험용. 기본 stdout
}

export function createLogger(service: string, base: Record<string, unknown> = {}, o: LoggerOpts = {}): Logger {
  const min = LEVELS[o.level ?? ((process.env.LOG_LEVEL as LogLevel | undefined) ?? "info")] ?? LEVELS.info;
  const write = o.write ?? ((line: string) => process.stdout.write(line + "\n"));
  const emit = (level: LogLevel) => (a: Record<string, unknown> | string, msg?: string) => {
    if (LEVELS[level] < min) return;
    const fields = typeof a === "string" ? {} : a;
    const text = typeof a === "string" ? a : msg ?? "";
    const line: Record<string, unknown> = {
      level, time: new Date().toISOString(), service, ...base, ...currentLogContext(), ...(scrubValue(normalize(fields)) as Record<string, unknown>), msg: scrubString(text),
    };
    write(JSON.stringify(line));
  };
  return {
    debug: emit("debug"), info: emit("info"), warn: emit("warn"), error: emit("error"),
    child: (f) => createLogger(service, { ...base, ...f }, o),
  };
}

// Fastify 생성자에 그대로 넣는 옵션. api 로그도 위와 같은 모양(level 글자, time ISO, service, request_id)이 된다
export function fastifyObservabilityOptions(service = "api") {
  return {
    logger: {
      level: process.env.LOG_LEVEL ?? "info",
      base: { service },
      messageKey: "msg",
      timestamp: () => `,"time":"${new Date().toISOString()}"`,
      formatters: { level: (label: string) => ({ level: label }),
        // LOGLEAK: 찍는 객체 전체(깊이 무관)와 문자열 속 비밀 모양을 가린다
        //   req·res·err 는 아래 직렬화 함수가 따로 가린다 (요청 객체를 통째로 훑지 않으려고 건너뜀)
        log: (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).map(([k, v]) =>
          [k, k === "req" || k === "res" || k === "err" ? v : SECRET_KEY.test(k) && v != null && v !== "" ? REDACTED : scrubValue(v)])) },
      // msg 칸: req.log.error(err) 는 오류 메시지가 msg 로 나간다. 문자열 인자(msg)도 비밀 모양을 가린다
      hooks: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        logMethod(this: any, args: any[], method: any) {
          const [a0, a1, ...rest] = args;
          if (a0 instanceof Error) return method.call(this, { err: a0 }, scrubString(a0.message), ...(a1 === undefined ? [] : [a1]), ...rest);
          if (typeof a0 === "string") return method.call(this, scrubString(a0), ...(a1 === undefined ? [] : [a1]), ...rest);
          return method.call(this, a0, typeof a1 === "string" ? scrubString(a1) : a1, ...rest);
        },
      },
      // 오류·요청 줄: 메시지·스택·주소(쿼리)의 비밀 모양을 가린다. 요청은 헤더·본문 없이 메서드·주소·호스트·상대 주소만
      serializers: {
        err: (e: Error) => scrubValue({ ...errorFields(e), ...(e.stack ? { stack: e.stack } : {}) }) as { [key: string]: unknown; type: string; message: string; stack: string },
        req: (r: { method?: string; url?: string; host?: string; hostname?: string; ip?: string; remoteAddress?: string }) =>
          ({ method: r.method, url: r.url ? scrubString(r.url) : r.url, host: r.host ?? r.hostname, remoteAddress: r.ip ?? r.remoteAddress }),
      },
      // 로그에 비밀값이 안 남게 가린다 (위협 모델 U)
      redact: {
        paths: ["req.headers.authorization", "req.headers.cookie", "req.headers[\"x-agent-signature\"]",
                "req.headers[\"x-agent-key-id\"]", "*.password", "*.secret", "*.token", "*.apiKey"],
        censor: "[redacted]",
      },
    },
    requestIdLogLabel: "request_id",
  };
}

// Error 는 JSON.stringify 하면 {} 가 된다. 이름·메시지·코드만 남긴다 (스택은 debug 일 때만)
function normalize(f: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(f)) {
    if (v instanceof Error) {
      out[k] = { type: v.name, message: v.message, ...(("code" in v) ? { code: (v as { code: unknown }).code } : {}),
        ...(process.env.LOG_LEVEL === "debug" ? { stack: v.stack } : {}) };
    } else out[k] = v;
  }
  return out;
}

function dropEmpty<T extends Record<string, unknown>>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== "")) as T;
}
