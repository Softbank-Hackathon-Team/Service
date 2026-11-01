import fp from "fastify-plugin";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { Registry, registerDbMetrics, HTTP_BUCKETS_SEC } from "@svc/core";

// api 관측 플러그인
//  1. 로그 필드: 인증 뒤(preHandler)에 요청 로거에 tenant_id·migration_id 를 붙인다
//     → 이 요청에서 req.log 로 찍는 모든 줄, Fastify 의 "request completed" 줄에 같이 나온다
//     ("incoming request" 줄은 인증 전이라 request_id 만 있다. request_id 로 이어 읽는다)
//  2. HTTP 지표: 경로 "모양"(/api/v1/migrations/:id)별 요청 수·응답 시간. 실제 id 를 라벨로 쓰면 줄 수가 끝없이 는다
// 인증 플러그인보다 뒤에 등록한다 (tenantId 가 채워진 다음이어야 한다)

export interface ObservabilityOpts { registry: Registry }

const MIGRATION_PARAM_ROUTES = /\/migrations\/:id/;

async function observabilityImpl(app: FastifyInstance, o: ObservabilityOpts) {
  const reqs = o.registry.counter("svc_http_requests_total", "HTTP requests by route pattern and status");
  const dur = o.registry.histogram("svc_http_request_duration_seconds", "HTTP request duration by route pattern",
    HTTP_BUCKETS_SEC);

  app.addHook("preHandler", async (req: FastifyRequest, reply) => {
    const fields: Record<string, string> = {};
    if (req.tenantId) fields.tenant_id = req.tenantId;
    const p = req.params as Record<string, unknown> | undefined;
    const route = req.routeOptions.url ?? "";
    if (typeof p?.id === "string" && MIGRATION_PARAM_ROUTES.test(route)) fields.migration_id = p.id;
    if (typeof p?.migrationId === "string") fields.migration_id = p.migrationId;
    if (Object.keys(fields).length) {
      // "request completed" 줄은 reply.log 로 찍힌다. 둘 다 바꿔야 끝 줄에도 필드가 붙는다
      req.log = req.log.child(fields);
      reply.log = req.log;
    }
  });

  app.addHook("onResponse", async (req, reply) => {
    const route = req.routeOptions.url ?? "unmatched";
    const labels = { method: req.method, route, status: String(reply.statusCode) };
    reqs.inc(labels);
    dur.observe({ method: req.method, route }, reply.elapsedTime / 1000);
  });
}

// 로그 필드에 회사 번호(req.tenantId)를 붙이므로 svc-auth 뒤에
// Z81: name·dependencies 는 fastify-plugin 이 등록할 때 확인한다. 순서가 틀리면 서버가 뜨기 전에(app.ready) 멈춘다. 순서가 맞으면 동작은 같다
export const observabilityPlugin = fp(observabilityImpl, { name: "observability", fastify: "5.x", dependencies: ["svc-auth"] });

// api 프로세스의 지표 묶음: HTTP 지표(플러그인이 채움) + DB 집계 지표(수집할 때 읽음)
export function createApiRegistry(): Registry {
  const reg = new Registry();
  registerDbMetrics(reg);
  return reg;
}
