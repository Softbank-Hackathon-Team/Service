import fp from "fastify-plugin";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { withIdempotency, requestHash, BadRequest, type Tx } from "@svc/core";

// 같은 요청 두 번 막기. 상태를 바꾸는 POST 경로가 이렇게 쓴다:
//   return req.idempotent(reply, async (tx) => { ...advance()...; return { status: 202, body: { id } }; });
// Idempotency-Key 헤더가 있으면 첫 응답을 저장하고, 같은 키가 다시 오면 그 응답을 그대로 돌려준다
// (헤더 Idempotent-Replayed: true). 같은 키를 다른 경로·본문에 쓰면 409 IDEMPOTENCY_KEY_REUSED.
// DRAFT(ai): 지금은 헤더가 없으면 키 없이 그냥 처리한다. 화면·CLI가 키를 늘 붙이게 되면 필수로 바꾼다

declare module "fastify" {
  interface FastifyRequest {
    idempotent<T>(reply: FastifyReply,
      fn: (tx: Tx) => Promise<{ status: number; body: T }>): Promise<FastifyReply>;
  }
}

const KEY_SHAPE = /^[A-Za-z0-9_.:-]{8,200}$/;

async function idempotent<T>(
  this: FastifyRequest, reply: FastifyReply,
  fn: (tx: Tx) => Promise<{ status: number; body: T }>,
): Promise<FastifyReply> {
  const raw = this.headers["idempotency-key"];
  let idem = null;
  if (raw !== undefined) {
    if (typeof raw !== "string" || !KEY_SHAPE.test(raw))
      throw new BadRequest("BAD_IDEMPOTENCY_KEY", "Idempotency-Key: 8-200 chars of [A-Za-z0-9_.:-]");
    idem = { key: raw, reqHash: requestHash(this.method, this.url, this.body) };
  }
  const r = await withIdempotency(this.tenantId, idem, fn);
  if (r.replayed) reply.header("idempotent-replayed", "true");
  return reply.code(r.status).send(r.body);
}

async function idempotencyPluginImpl(app: FastifyInstance) {
  app.decorateRequest("idempotent", idempotent);
}

// fp로 감싸야 모든 경로의 요청에 붙는다 (안 감싸면 이 플러그인 안에만 적용)
// Z81: name·dependencies 는 fastify-plugin 이 등록할 때 확인한다. 순서가 틀리면 서버가 뜨기 전에(app.ready) 멈춘다. 순서가 맞으면 동작은 같다
export const idempotencyPlugin = fp(idempotencyPluginImpl, { name: "svc-idempotency", fastify: "5.x" });
