import pg from "pg";
import { envNumber } from "@svc/contracts";
import { createLogger, scrubString } from "./obs/log.js";

export type Tx = pg.PoolClient;

// Z49: 프로세스당 연결 상한. 기본 10 = 예전 값. 동시 요청 10개에서 10개가 다 차는 것을 확인했다 (docs/PERF.md 5절).
// 늘리기 전에 DB max_connections(기본 100)를 본다: 프로세스마다 이것 + pg-boss 10 + 생존 신호 1 (+ NOTIFY 켜면 1)
export const DB_POOL_MAX = Math.max(1, envNumber(process.env.DB_POOL_MAX, 10) || 10);
export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: DB_POOL_MAX,
});
// 쉬는 연결이 서버 쪽에서 끊기면(펜스·재시작) 풀이 error를 낸다. 처리기가 없으면 프로세스가 죽는다
// Z81-08: 다른 줄과 같은 JSON 한 줄로 (component=pg-pool). 예전 console.error 글자는 로그 검색에 안 걸렸다. 오류는 type·message·code
const poolLog = createLogger(process.env.SERVICE_NAME ?? "svc", { component: "pg-pool" });
pool.on("error", (err) => poolLog.warn({ err }, "idle client error"));

// 모든 DB 작업은 이 함수 하나를 지난다.
// 트랜잭션 열기 → 회사 표시 → 일 → 확정/취소
export async function withTenant<T>(
  tenantId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  const c = await pool.connect();
  // 빌린 연결이 일하는 중 끊겨도 프로세스가 죽지 않게. 오류는 진행 중인 query가 대신 던진다
  const onErr = (e: Error) => console.error("[pg client] error", scrubString(e.message));
  c.on("error", onErr);
  let broken: Error | undefined;
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const out = await fn(c);
    await c.query("COMMIT");
    return out;
  } catch (e) {
    // 연결이 이미 죽었으면 ROLLBACK도 실패한다. 원래 오류를 가리지 않게 삼키고 연결은 버린다
    await c.query("ROLLBACK").catch((re: Error) => { broken = re; });
    throw e;
  } finally {
    c.off("error", onErr);
    c.release(broken);
  }
}

// 전용 연결 묶음. 생존 신호처럼 "일반 연결이 바빠도 줄 서면 안 되는" 일에 쓴다
const dedicatedPoolLog = createLogger(process.env.SERVICE_NAME ?? "svc", { component: "pg-dedicated-pool" });
export function createDedicatedPool(max = 1): pg.Pool {
  return new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    max,
    connectionTimeoutMillis: 5000,
  }).on("error", (err) => dedicatedPoolLog.warn({ err }, "idle client error"));
}
