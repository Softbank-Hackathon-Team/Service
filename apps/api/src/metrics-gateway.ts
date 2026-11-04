import { createServer, type IncomingMessage, type Server } from "node:http";
import { hashMetricToken, isMetricTokenShape, type MetricTokenLookup } from "./auth/metric-token.js";

// OTel 게이트웨이의 입구. 고객 수집기 → (터널) → 여기 → 같은 파드의 OTel Collector → Prometheus
//  1. Bearer 지표 토큰으로 회사·환경을 찾는다. 모르는 토큰은 401
//  2. 찾은 값을 헤더로 Collector 에 넘긴다. Collector 가 보낸 쪽 꼬리표를 버리고 이 값으로 덮어쓴다
// 보낸 쪽 헤더는 내용 종류 두 개만 전달한다 (x-svc-* 를 흉내 내도 Collector 까지 못 간다)

export const TENANT_HEADER = "x-svc-tenant";
export const ENV_HEADER = "x-svc-environment";
// DRAFT(ai): 한 번에 4MiB. 지표는 15초마다 작은 묶음이라 넉넉하다
const MAX_BODY_BYTES = 4 * 1024 * 1024;

export interface GatewayOpts {
  lookup: MetricTokenLookup;
  collectorUrl: string;
  maxBodyBytes?: number;
  fetch?: typeof fetch;
  onError?: (e: unknown) => void;
}

async function readBody(req: IncomingMessage, max: number): Promise<Buffer | null> {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > max) return null;
    parts.push(chunk as Buffer);
  }
  return Buffer.concat(parts);
}

export function createMetricsGateway(o: GatewayOpts): Server {
  const f = o.fetch ?? fetch;
  const server = createServer(async (req, res) => {
    const send = (status: number, msg: string) => res.writeHead(status, { "content-type": "text/plain" }).end(msg);
    try {
      if (req.method === "GET" && req.url === "/healthz") return void send(200, "ok");
      if (req.url !== "/v1/metrics") return void send(404, "not found");
      if (req.method !== "POST") return void send(405, "method not allowed");
      const token = /^Bearer (\S+)$/.exec(req.headers.authorization ?? "")?.[1];
      const owner = token && isMetricTokenShape(token) ? await o.lookup(hashMetricToken(token)) : undefined;
      if (!owner) return void send(401, "unauthorized");
      const body = await readBody(req, o.maxBodyBytes ?? MAX_BODY_BYTES);
      if (!body) { res.setHeader("connection", "close"); return void send(413, "too large"); }
      const headers: Record<string, string> = { [TENANT_HEADER]: owner.tenantId, [ENV_HEADER]: owner.envId };
      if (req.headers["content-type"]) headers["content-type"] = req.headers["content-type"];
      if (req.headers["content-encoding"]) headers["content-encoding"] = req.headers["content-encoding"];
      const up = await f(o.collectorUrl, { method: "POST", headers, body: new Uint8Array(body) });
      res.writeHead(up.status, { "content-type": up.headers.get("content-type") ?? "application/octet-stream" })
        .end(Buffer.from(await up.arrayBuffer()));
    } catch (e) {
      // DB·Collector 가 잠깐 죽은 경우. 수집기는 503 이면 다시 보낸다
      o.onError?.(e);
      if (res.headersSent) res.destroy(); else send(503, "unavailable");
    }
  });
  server.requestTimeout = 30_000;
  return server;
}
