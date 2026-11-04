import { createLogger, onShutdown, pool } from "@svc/core";
import { envNumber } from "@svc/contracts";
import { dbMetricTokenLookup } from "./auth/metric-token.js";
import { createMetricsGateway } from "./metrics-gateway.js";

// api 이미지의 두 번째 진입점 (node metrics-gateway.mjs). 차트 templates/otel-gateway.yaml 이 띄운다
const log = createLogger("metrics-gateway");
const server = createMetricsGateway({
  lookup: dbMetricTokenLookup,
  collectorUrl: process.env.COLLECTOR_URL ?? "http://127.0.0.1:4319/v1/metrics",
  onError: (err) => log.warn({ err }, "metrics push failed"),
});
const port = envNumber(process.env.GATEWAY_PORT, 4318);
server.listen(port, "0.0.0.0", () => log.info({ port }, "metrics gateway listening"));

onShutdown([
  ["http", () => new Promise((done) => server.close(done))],
  ["pg", () => pool.end()],
], { log });
