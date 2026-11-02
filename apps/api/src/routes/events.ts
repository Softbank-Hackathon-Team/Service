import type { FastifyInstance } from "fastify";
import { PassThrough } from "node:stream";
import type { SseEvent } from "@svc/contracts";
import { EventHub } from "../events-hub.js";

// GET /api/v1/events — 화면 신호 (SSE, 설계 문서 4.6). 로그인한 회사의 신호만 text/event-stream 으로 계속 보낸다.
//   인증은 다른 경로와 같다 (authPlugin onRequest, Bearer). 브라우저 EventSource 는 Authorization 을 못 붙여서 화면은 fetch 로 읽는다
//   신호 한 건 = `data: <SseEvent JSON>` 줄 + 빈 줄. `:` 로 시작하는 줄은 연결을 살려 두는 주석이다
//   처음에 retry 줄로 끊기면 몇 ms 뒤에 다시 붙을지 알린다. 신호는 "다시 읽어"라는 뜻이라 놓쳐도 다음 읽기로 맞춰진다
// DRAFT(ai): 주석 줄 간격. nginx proxy_read_timeout 60s (deploy/docker/web-nginx.conf.template)보다 짧게
export const HEARTBEAT_MS = 15_000;
// DRAFT(ai): 끊긴 뒤 다시 붙기까지 권하는 시간
export const RETRY_MS = 3_000;

export const sseLine = (e: SseEvent) => `data: ${JSON.stringify(e)}\n\n`;

export async function eventRoutes(app: FastifyInstance, opts: { hub?: EventHub; heartbeatMs?: number } = {}) {
  const hub = opts.hub ?? new EventHub();
  const heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS;
  const open = new Set<() => void>();
  // 신호 연결은 끝나지 않는 요청이라, 먼저 닫지 않으면 app.close() 가 그 연결을 기다리며 멈춘다 (Fastify preClose 훅)
  app.addHook("preClose", async () => { for (const end of [...open]) end(); });
  app.addHook("onClose", async () => { await hub.close(); });

  app.get("/events", async (req, reply) => {
    const stream = new PassThrough();
    const write = (chunk: string) => { if (!stream.writableEnded && !stream.destroyed) stream.write(chunk); };
    const off = hub.subscribe(req.tenantId, (e) => write(sseLine(e)));
    const beat = setInterval(() => write(": ping\n\n"), heartbeatMs);
    const end = () => {
      if (!open.delete(end)) return;
      clearInterval(beat);
      off();
      stream.end();
    };
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
