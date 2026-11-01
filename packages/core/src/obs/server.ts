import { createServer, type Server } from "node:http";
import { Registry, PROM_CONTENT_TYPE } from "./metrics.js";

// 지표 전용 작은 HTTP 서버. GET /metrics 만 답한다
// DRAFT(ai): 업무 API 포트(3000)가 아니라 따로 연다(기본 9464). 이유:
//  - 업무 API 는 인증 훅(x-dev-tenant → 나중에 세션)이 모든 경로에 걸린다. /metrics 는 Prometheus 가 인증 없이 긁는다
//  - cloudflared 터널·인그레스는 3000 만 내보낸다. 9464 는 클러스터 안(Prometheus)에서만 닿는다 → 회사 합계 숫자가 밖으로 안 나간다
// 대안(버림): 3000 에 /metrics 를 두고 인증 예외 → 터널로 공개되거나, 예외 목록을 인증 플러그인에 하나 더 둬야 한다
export function startMetricsServer(reg: Registry, port: number, host = "0.0.0.0"): Promise<Server> {
  const srv = createServer(async (req, res) => {
    if (req.method !== "GET" || (req.url ?? "").split("?")[0] !== "/metrics") {
      res.writeHead(404).end();
      return;
    }
    try {
      const body = await reg.render();
      res.writeHead(200, { "content-type": PROM_CONTENT_TYPE }).end(body);
    } catch (e) {
      res.writeHead(500, { "content-type": "text/plain" }).end(String((e as Error).message));
    }
  });
  // Z12-2: 예전엔 listen 오류(EADDRINUSE)를 아무도 안 받아 프로세스가 죽었다 → 이제 Promise가 실패한다
  return new Promise((ok, fail) => {
    srv.once("error", fail);
    srv.listen(port, host, () => { srv.off("error", fail); ok(srv); });
  });
}

// Z12-2 (Z36): 포트가 차 있으면 다음 포트를 차례로 시도한다. 다 차 있거나 다른 오류면 null (지표만 끄고 프로세스는 산다)
// DRAFT(ai): 최대 10개 (9465 → 9474). 같은 맥에서 워커 여러 개로 장애 데모를 할 때 쓴다. 쿠버네티스는 파드마다 포트가 따로라 첫 시도에 붙는다
//   대안 "바로 0(임의 포트)"은 버림: Prometheus·사람이 어느 포트를 긁을지 짐작할 수 없다. 대안 "그냥 끄기"는 버림: 두 번째 워커 지표가 사라진다
export async function startMetricsServerNear(
  reg: Registry, port: number, o: { tries?: number; host?: string; onBusy?: (port: number) => void } = {},
): Promise<{ server: Server; port: number } | null> {
  const tries = Math.max(1, o.tries ?? 10);
  for (let p = port; p < port + tries; p++) {
    try {
      return { server: await startMetricsServer(reg, p, o.host), port: p };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EADDRINUSE") return null;
      o.onBusy?.(p);
    }
  }
  return null;
}
