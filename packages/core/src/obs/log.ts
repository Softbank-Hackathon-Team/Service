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
      level, time: new Date().toISOString(), service, ...base, ...currentLogContext(), ...normalize(fields), msg: text,
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
      formatters: { level: (label: string) => ({ level: label }) },
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
