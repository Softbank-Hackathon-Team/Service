import fp from "fastify-plugin";
import rateLimit from "@fastify/rate-limit";
import type { FastifyInstance, FastifyRequest } from "fastify";

// Z52 (모의 심사 Q31): API 요청 횟수 제한.
// - 세는 단위(열쇠) = 회사 번호 + 읽기/쓰기. 회사 번호가 없는 요청(Agent 보고 등)은 접속 IP로 센다.
//   그래서 authPlugin 뒤에 등록해야 한다(훅은 등록 순서대로 돈다 → req.tenantId가 채워진 뒤 센다).
// - 읽기(GET·HEAD)와 쓰기(그 밖)는 따로 센다. 화면이 0.7초마다 상태를 다시 읽어도 쓰기 한도를 먹지 않게.
// - 넘으면 429 + retry-after 헤더 + 우리 오류 모양 {status, code, message, requestId}.
// - 카운터는 프로세스 메모리. API를 여러 대 띄우면 대마다 따로 센다(→ 운영이면 redis 저장소 옵션).
// DRAFT(ai) Z52: 기본 한도 = 회사당 분당 읽기 3000, 쓰기 120. RATE_LIMIT=0 이면 끈다(부하 측정 tools/load 쓸 때).
//   근거: 웹 화면 한 탭이 0.7초마다 2~3개 경로를 읽는다 → 분당 약 260. e2e가 여러 탭을 같은 회사로 돌려도 남게 잡았다.
//   쓰기는 사람이 버튼으로 누르는 양(분당 수 회)의 수십 배. 멱등 키가 중복 실행은 이미 막으니 이건 "폭주" 방지용이다.

export interface RateLimitOpts { readMax?: number; writeMax?: number; timeWindowMs?: number; enabled?: boolean }

const num = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);

export function rateLimitOptsFromEnv(env: NodeJS.ProcessEnv = process.env): Required<RateLimitOpts> {
  return {
    enabled: env.RATE_LIMIT !== "0",
    readMax: num(env.RATE_LIMIT_READ_PER_MIN, 3000),
    writeMax: num(env.RATE_LIMIT_WRITE_PER_MIN, 120),
    timeWindowMs: 60_000,
  };
}

const isWrite = (req: FastifyRequest) => req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS";

// 세지 않는 경로: 쿠버네티스 프로브, 공개 API 문서
export const exempt = (url: string) => url === "/healthz" || url === "/readyz" || /^\/api\/v1\/docs(\/|\?|$)/.test(url);

export function keyOf(req: FastifyRequest) {
  const who = req.tenantId ? `t:${req.tenantId}` : `ip:${req.ip}`;
  return `${who}:${isWrite(req) ? "w" : "r"}`;
}

async function rateLimitPluginImpl(app: FastifyInstance, o: RateLimitOpts = {}) {
  const env = rateLimitOptsFromEnv();
  const opts = { ...env, ...Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) } as Required<RateLimitOpts>;
  if (!opts.enabled) return;
  await app.register(rateLimit, {
    global: true,
    hook: "preHandler", // onRequest(authPlugin) 다음. req.tenantId가 이미 있다
    timeWindow: opts.timeWindowMs,
    max: async (req) => (isWrite(req) ? opts.writeMax : opts.readMax),
    keyGenerator: keyOf,
    allowList: (req) => exempt(req.url),
    errorResponseBuilder: (req, ctx) => ({
      statusCode: 429, status: 429, code: "RATE_LIMITED",
      message: `too many requests: ${ctx.max} per ${ctx.after}`, requestId: req.id,
    }),
  });
}

// fp로 감싸야 모든 경로(/api/v1 아래 플러그인들)에 걸린다
// 회사 번호(req.tenantId)로 세므로 svc-auth 가 먼저 등록돼 있어야 한다
// Z81: name·dependencies 는 fastify-plugin 이 등록할 때 확인한다. 순서가 틀리면 서버가 뜨기 전에(app.ready) 멈춘다. 순서가 맞으면 동작은 같다
export const rateLimitPlugin = fp(rateLimitPluginImpl, { name: "svc-rate-limit", fastify: "5.x", dependencies: ["svc-auth"] });
