import pg from "pg";

// 접속 정보는 Helm 차트(gitops/charts/app)가 넣는 DB_* 이름을 그대로 쓴다.
// DB_SSLMODE: disable(로컬 compose) | require(RDS·Cloud SQL·CNPG, 인증서 검증 없음)
// TODO(human): 운영은 verify-full + 클라우드별 CA 묶음. 지금은 require(암호화만)
export function dbConfig(env = process.env) {
  const ssl = (env.DB_SSLMODE ?? "disable") === "disable" ? false : { rejectUnauthorized: false };
  return {
    host: env.DB_HOST ?? "localhost",
    port: Number(env.DB_PORT ?? 5432),
    database: env.DB_NAME ?? "shop",
    user: env.DB_USER ?? "app",
    password: env.DB_PASSWORD,
    ssl,
    max: Number(env.DB_POOL_MAX ?? 10),
    connectionTimeoutMillis: Number(env.DB_CONNECT_TIMEOUT_MS ?? 5000),
    idleTimeoutMillis: 30000,
    application_name: "shop-app",
    options: "-c search_path=shop,public",
  };
}

// 연결이 끊긴 종류의 오류. 컷오버 펜스(세션 강제 종료)나 DB 재시작 때 난다.
const RETRYABLE = new Set(["57P01", "57P02", "57P03", "08006", "08003", "08001", "ECONNRESET", "ECONNREFUSED", "EPIPE"]);
export const isRetryable = (e) => RETRYABLE.has(e?.code) || /Connection terminated/i.test(e?.message ?? "");

export function createDb(env = process.env) {
  const pool = new pg.Pool(dbConfig(env));
  const counters = { retries: 0, failures: 0 };
  pool.on("error", (e) => console.error(JSON.stringify({ level: "warn", msg: "idle client error", code: e.code, err: e.message })));

  // DRAFT(ai): 연결 오류면 1번만 다시 시도한다. 쓰기는 client_ref(유일)로 멱등이라 두 번 들어가지 않는다.
  async function withRetry(fn) {
    try {
      return await fn();
    } catch (e) {
      if (!isRetryable(e)) throw e;
      counters.retries++;
      await new Promise((r) => setTimeout(r, Number(env.DB_RETRY_DELAY_MS ?? 200)));
      try {
        return await fn();
      } catch (e2) {
        counters.failures++;
        throw e2;
      }
    }
  }

  const query = (text, params) => withRetry(() => pool.query(text, params));

  async function tx(fn) {
    return withRetry(async () => {
      const c = await pool.connect();
      // 빌려 간(checked-out) 연결에도 error 처리기를 단다. 없으면 세션 강제 종료 때 프로세스가 죽는다 (10/31 실측).
      let broken = null;
      const onError = (e) => { broken = e; };
      c.on("error", onError);
      try {
        await c.query("BEGIN");
        const out = await fn(c);
        await c.query("COMMIT");
        return out;
      } catch (e) {
        if (isRetryable(e)) broken = e;
        else await c.query("ROLLBACK").catch(() => {});
        throw e;
      } finally {
        c.off("error", onError);
        c.release(broken ?? undefined);
      }
    });
  }

  return { pool, query, tx, counters };
}
