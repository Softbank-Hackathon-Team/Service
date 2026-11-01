import fp from "fastify-plugin";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { DomainError } from "@svc/core";
import { RunnerUnavailable } from "@svc/adapters";

// 오류 응답 본문 한 모양 {status, code, message, requestId} (contracts ApiError). 직접 send 하는 곳도 이걸 쓴다
export const errorBody = (req: FastifyRequest, status: number, code: string, message: string) =>
  ({ status, code, message, requestId: req.id });
export const sendError = (req: FastifyRequest, reply: FastifyReply, status: number, code: string, message: string) =>
  reply.code(status).send(errorBody(req, status, code, message));

// 다른 계층 예외 → HTTP. 바꾸는 곳은 여기 한 곳 (Z44: 예전엔 경로마다 try/catch 로 DomainError 로 다시 던짐)
//   DomainError         → 그 상태·코드
//   RunnerUnavailable   → 409 + 실행기 코드 (예: AZURE_MOCK_DISABLED). 다른 AdapterError 는 예전처럼 500
//   Zod 검증 실패        → 400 BAD_REQUEST
//   pg 23503(외래 키)    → 404 (없는 번호나 다른 회사 번호를 가리킴, 0005). 남의 회사 자원은 404로 보인다
function toHttp(err: unknown): { status: number; code: string; message: string } | null {
  if (err instanceof DomainError) return { status: err.status, code: err.code, message: err.message };
  if (err instanceof RunnerUnavailable) return { status: 409, code: err.code, message: err.message };
  const e = err as { validation?: unknown; message?: string; code?: string };
  if (e.validation) return { status: 400, code: "BAD_REQUEST", message: e.message ?? "" };
  // Z52: 요청 횟수 제한(rate-limit 플러그인)이 던진 429. 모양은 플러그인 쪽에서 이미 맞춰 보낸다
  if ((err as { statusCode?: number }).statusCode === 429) return { status: 429, code: "RATE_LIMITED", message: e.message ?? "too many requests" };
  if (e.code === "23503") return { status: 404, code: "NOT_FOUND", message: "referenced resource not found" };
  return null;
}

async function errorsPluginImpl(app: FastifyInstance) {
  app.setErrorHandler((err, req, reply) => {
    // Z38-7: 교착(40P01)·직렬화 실패(40001)는 다시 하면 되는 실패다. 500 대신 409 RETRY 로 알려 화면·CLI 가 같은 멱등 키로 다시 보내게 한다
    const pgCode = (err as { code?: string }).code;
    if (pgCode === "40P01" || pgCode === "40001") {
      req.log.warn({ err, pg_code: pgCode }, "retryable db conflict");
      reply.header("retry-after", "1");
      return sendError(req, reply, 409, "RETRY", "concurrent update, retry with the same Idempotency-Key");
    }
    const h = toHttp(err);
    if (h) {
      // z32-9: 4xx 도 코드가 로그에 남아야 "승인 409" 같은 실패를 로그만 보고 가를 수 있다
      req.log.warn({ status: h.status, code: h.code, route: req.routeOptions?.url }, "request rejected");
      return sendError(req, reply, h.status, h.code, h.message);
    }
    req.log.error(err);
    return sendError(req, reply, 500, "INTERNAL", "internal error");
  });
  // Z81-06 (PROPOSALS P3): 등록 안 된 경로도 같은 오류 모양으로. 예전엔 Fastify 기본 404 {message, error, statusCode} 가 나갔다
  // 【사실, Fastify Server 문서 setNotFoundHandler】 404 처리기는 루트(fp 로 감싼 이 플러그인)에서 한 번 정하면 모든 접두어에 걸린다
  app.setNotFoundHandler((req, reply) => sendError(req, reply, 404, "NOT_FOUND", `route ${req.method} ${req.url.split("?")[0]} not found`));
}

// fp로 감싸야 훅·오류 처리가 모든 경로에 걸린다 (안 감싸면 이 플러그인 안에만 적용)
// Z81: name·dependencies 는 fastify-plugin 이 등록할 때 확인한다. 순서가 틀리면 서버가 뜨기 전에(app.ready) 멈춘다. 순서가 맞으면 동작은 같다
export const errorsPlugin = fp(errorsPluginImpl, { name: "svc-errors", fastify: "5.x" });
