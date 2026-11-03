import type { FastifyInstance, FastifyRequest } from "fastify";
import { PassThrough } from "node:stream";
import type { SseEvent } from "@svc/contracts";
import { EventHub } from "../events-hub.js";

// GET /api/v1/events — 화면 신호 (SSE, 설계 문서 4.6). 로그인한 회사의 신호만 text/event-stream 으로 계속 보낸다.
//   인증은 다른 경로와 같다 (authPlugin onRequest, Bearer). 브라우저 EventSource 는 Authorization 을 못 붙여서 화면은 fetch 로 읽는다
//   신호 한 건 = `data: <SseEvent JSON>` 줄 + 빈 줄. `:` 로 시작하는 줄은 연결을 살려 두는 주석이다
//   처음에 retry 줄로 끊기면 몇 ms 뒤에 다시 붙을지 알린다. 신호는 "다시 읽어"라는 뜻이라 놓쳐도 다음 읽기로 맞춰진다
//   L8: 인증은 붙을 때 한 번뿐이라, 연결을 연 토큰이 만료되면 서버가 끊는다(수명 상한). 그 회사·사용자의 세션 끊김 알림이 와도 끊는다(events-hub).
//   화면은 새 토큰으로 다시 붙고(인증 훅의 사용자 재확인·차단 목록을 다시 지남) 전부 다시 읽는다 (web lib/events.ts)
// DRAFT(ai): 주석 줄 간격. nginx proxy_read_timeout 60s (deploy/docker/web-nginx.conf.template)보다 짧게
export const HEARTBEAT_MS = 15_000;
// DRAFT(ai): 끊긴 뒤 다시 붙기까지 권하는 시간
export const RETRY_MS = 3_000;
// DRAFT(ai): 연결 수명 상한. 만료 시각을 모르는 연결(CLI 개인 토큰·개발용 헤더)은 이 시간에 끊는다. 접근 토큰 기본 수명(15분)과 같게.
//   JWT 연결도 exp 와 이 값 중 이른 쪽 (접근 토큰 수명을 길게 바꿔도 연결이 오래 남지 않고, setTimeout 한도도 안 넘게)
export const MAX_STREAM_MS = 15 * 60_000;

export const sseLine = (e: SseEvent) => `data: ${JSON.stringify(e)}\n\n`;

/** 연결 수명(ms). JWT 면 exp 까지(이미 지났으면 0 = 바로 끊음, 시계 오차 30초 안이라 인증은 통과한 경우), 없으면 상한 */
export function streamLifetimeMs(auth: { exp: number } | null, maxMs = MAX_STREAM_MS, nowMs = Date.now()): number {
  return auth ? Math.max(0, Math.min(auth.exp * 1000 - nowMs, maxMs)) : maxMs;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** 연결을 연 사용자 번호. JWT 는 sub, CLI 개인 토큰은 actor "user:<번호>" (auth 플러그인이 채움). 개발용 헤더("user:dev")는 null */
export function streamUserId(req: Pick<FastifyRequest, "auth" | "actor">): string | null {
  if (req.auth) return req.auth.sub;
  const id = req.actor.startsWith("user:") ? req.actor.slice(5) : "";
  return UUID.test(id) ? id : null;
}

export async function eventRoutes(app: FastifyInstance, opts: { hub?: EventHub; heartbeatMs?: number; maxStreamMs?: number } = {}) {
  const hub = opts.hub ?? new EventHub();
  const heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS;
  const maxStreamMs = opts.maxStreamMs ?? MAX_STREAM_MS;
  const open = new Set<() => void>();
  // 신호 연결은 끝나지 않는 요청이라, 먼저 닫지 않으면 app.close() 가 그 연결을 기다리며 멈춘다 (Fastify preClose 훅)
  app.addHook("preClose", async () => { for (const end of [...open]) end(); });
  app.addHook("onClose", async () => { await hub.close(); });

  app.get("/events", async (req, reply) => {
    const stream = new PassThrough();
    const write = (chunk: string) => { if (!stream.writableEnded && !stream.destroyed) stream.write(chunk); };
    // end 는 open 에 들어간 뒤에만 아래 값들을 쓴다 (들어가기 전 호출은 첫 줄에서 돌아감)
    const end = () => {
      if (!open.delete(end)) return;
      clearInterval(beat);
      clearTimeout(life);
      off();
      stream.end();
    };
    const off = hub.subscribe(req.tenantId, (e) => write(sseLine(e)), { userId: streamUserId(req), close: end });
    const beat = setInterval(() => write(": ping\n\n"), heartbeatMs);
    // 토큰 만료(또는 상한)에 끊는다. 화면은 retry 뒤 새 토큰으로 다시 붙는다
    const life = setTimeout(end, streamLifetimeMs(req.auth, maxStreamMs));
    open.add(end);
    // 브라우저가 끊거나(탭 닫기·로그아웃) 응답이 끝나면 구독을 푼다
    reply.raw.on("close", end);
    stream.on("error", end);
    write(`retry: ${RETRY_MS}\n\n`);
    return reply
      .header("content-type", "text/event-stream; charset=utf-8")
      .header("cache-control", "no-cache, no-transform")
      // 앞단 nginx 가 신호를 모아 두지 않게 (web-nginx 는 proxy_buffering off 지만 다른 프록시도 있다)
      .header("x-accel-buffering", "no")
      .send(stream);
  });
}
