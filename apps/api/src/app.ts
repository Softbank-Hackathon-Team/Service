import Fastify from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { pool, fastifyObservabilityOptions } from "@svc/core";
import { authPlugin } from "./plugins/auth.js";
import { errorsPlugin } from "./plugins/errors.js";
import { idempotencyPlugin } from "./plugins/idempotency.js";
import { rateLimitPlugin } from "./plugins/rate-limit.js";
import { observabilityPlugin, createApiRegistry } from "./plugins/observability.js";
import { API_PREFIX, ROUTE_PLUGINS } from "./routes/index.js";

// Z81: 앱 만들기(buildApp)와 띄우기(main.ts: 큐·지표 서버·listen·종료 신호)를 나눴다.
//   Fastify 시험 안내(Guides/Testing)가 권하는 모양: 앱 파일은 만들기만, 서버 파일이 listen.
//   예전엔 main.ts 가 import 하자마자 listen 해서 시험·명세 생성기가 진짜 등록 순서를 그대로 쓸 수 없었다.
// 여기서는 DB 에 붙지 않는다 (pool 은 /readyz 가 처음 부를 때 연결)
export async function buildApp() {
  // 로그 형식·비밀값 가리기는 core obs/log.ts 한 곳에서 (T, 위협 모델 U)
  const app = Fastify(fastifyObservabilityOptions("api"));
  const metrics = createApiRegistry();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(errorsPlugin);
  await app.register(authPlugin);
  // Z52: 요청 횟수 제한. 회사 번호로 세므로 인증 뒤에 (RATE_LIMIT=0 이면 끔)
  await app.register(rateLimitPlugin);
  await app.register(idempotencyPlugin);
  await app.register(observabilityPlugin, { registry: metrics });
  app.get("/healthz", async () => ({ ok: true }));
  app.get("/readyz", async () => { await pool.query("SELECT 1"); return { ok: true }; });
  for (const r of ROUTE_PLUGINS) await app.register(r.plugin, { prefix: API_PREFIX });
  return { app, metrics };
}
