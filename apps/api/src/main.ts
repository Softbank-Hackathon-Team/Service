import { boss, startBoss, startMetricsServer, onShutdown, assertConfig, logEffectiveConfig } from "@svc/core";
import { buildApp } from "./app.js";
import { envNumber } from "@svc/contracts";
import { jwtSecretProblem } from "./auth/jwt.js";
import { startApiReaper } from "./reaper.js";

// Z93: 운영(NODE_ENV=production·AUTH_MODE=real)인데 JWT_SECRET 이 없거나 짧으면 뜨지 않는다 (조용히 로그인만 안 되는 것보다 낫다)
const secretProblem = jwtSecretProblem();
if (secretProblem) { console.error(`[api] ${secretProblem}`); process.exit(1); }

// Z81-09: 설정을 먼저 본다. 틀리면 목록을 내고 끝 코드 2 (큐·포트를 열기 전)
assertConfig("api");
// Z81-10: 실제로 쓰는 설정 값 5개를 한 줄로 (rehearse 가 이 줄을 본다)
logEffectiveConfig("api");

// 앱 등록(플러그인·경로 순서)은 app.ts buildApp 한 곳 (Z81)
const { app, metrics } = await buildApp();

await startBoss(); // api도 작업을 "넣기" 때문에 큐가 필요하다
await startApiReaper(); // API_REAPER=1 일 때만: 워커가 다 죽어도 청소 담당이 돈다 (reaper.ts)
const METRICS_PORT = envNumber(process.env.METRICS_PORT, 9464);
if (METRICS_PORT > 0) await startMetricsServer(metrics, METRICS_PORT);
// Z47: 개발 기본은 내 컴퓨터 안(localhost = 127.0.0.1 과 ::1 둘 다)만. 예전 0.0.0.0 은 행사장 와이파이의 다른 기기가
//   개발용 헤더 인증 API(3000)를 바로 부를 수 있었다. 컨테이너 이미지는 Dockerfile 에서 API_HOST=0.0.0.0 (포트 공개는 compose 가 127.0.0.1 로 제한)
const API_HOST = process.env.API_HOST ?? "localhost";
await app.listen({ port: envNumber(process.env.API_PORT, 3000), host: API_HOST });

// 종료 신호(docker stop, k8s 파드 종료): 새 요청을 그만 받고 처리 중인 요청을 끝낸 뒤 큐를 닫는다.
// 이게 없으면 컨테이너 PID 1 인 node 가 SIGTERM 을 무시해서 docker stop 이 10초 기다렸다 강제 종료한다(Z4 측정)
// Z81: 처리는 core shutdown.ts 한 곳 (단계가 던지면 로그 + 끝 코드 1, 두 번째 신호는 바로 끝냄)
onShutdown([["http", () => app.close()], ["boss", () => boss.stop({ graceful: true })]], { log: app.log });
