import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import type pg from "pg";
import { type Endpoint, peerUrlOf, withClient } from "./endpoint.js";
import { ident, lit, qualified } from "./sql.js";

// Z52 (모의 심사 Q27): 구독 접속 문자열의 비밀번호 문제.
// Postgres 구독은 CONNECTION 문자열을 pg_subscription.subconninfo에 그대로(평문) 저장한다. 그 열은 일반 계정에 안 보이지만
// 슈퍼유저·백업·덤프에는 남는다. 지금까지는 상대 DB의 "관리자" 접속 문자열을 그대로 넣어서, 새면 관리자 권한이 샌다.
// 고친 방식: 복제 길 하나마다 "쓰고 버리는 복제 전용 계정"을 발행자(상대 DB)에 만든다.
//   - 권한: 로그인 + 복제 + 복제할 표 SELECT만 (쓰기·DDL 없음). 비밀번호는 매번 새로 만든 무작위 32바이트
//   - 구독 접속 문자열에는 이 계정만 들어간다 → 새도 "이 표들 읽기"까지만, 그리고 정리(teardown) 때 계정째 지운다
// 버린 대안: .pgpass(구독자 서버 파일) / 인증서 → RDS·Cloud SQL 같은 관리형 DB는 서버 파일을 못 놓는다. IAM 토큰 → 15분 만료라 장기 구독에 못 쓴다
// DRAFT(ai) Z52: 기본 꺼짐. REPL_EPHEMERAL_USER=1 이면 켠다. 맥에서 RDS·Cloud SQL 실제 권한(역할 만들기·복제 권한 주기)을 확인한 뒤 기본 켜기로 바꾼다

export const ephemeralEnabled = (env: NodeJS.ProcessEnv = process.env) => env.REPL_EPHEMERAL_USER === "1";

/** 복제 길 이름(repl_<key>_fwd/rev) → 계정 이름. 길 이름이 이미 63자 안으로 검사돼 있다 */
export const replUserOf = (name: string) => `${name}_u`.slice(0, 63);

/** 발행자 c(관리자 세션)에 전용 계정을 만들거나(있으면 비밀번호만 새로) 표 읽기 권한을 준다. 접속 문자열에 쓸 계정·비밀번호를 돌려준다 */
export async function ensureReplUser(c: pg.Client, e: Endpoint, name: string): Promise<{ user: string; password: string }> {
  const user = replUserOf(name);
  const password = randomBytes(32).toString("base64url");
  const exists = (await c.query(`SELECT 1 FROM pg_roles WHERE rolname=$1`, [user])).rowCount === 1;
  // RDS는 관리자도 REPLICATION 속성을 못 준다 → rds_replication 역할을 준다. 나머지는 속성으로
  const replAttr = e.provider === "rds" ? "" : " REPLICATION";
  // 2026-11-05 실측 (임시 RDS PG16): NOINHERIT 계정은 rds_replication 을 받아도 "permission denied to start WAL sender".
  //   RDS 의 복제 권한은 역할 멤버십으로만 오므로 RDS 에서는 INHERIT 여야 한다 (주는 역할은 rds_replication 하나뿐이라 넓어지지 않음)
  const inheritAttr = e.provider === "rds" ? " INHERIT" : " NOINHERIT";
  // 비밀번호가 서버 로그(log_statement=all)에 남지 않게 이 문장만 기록을 끈다(권한이 없으면 무시)
  await c.query(`SET log_statement = 'none'`).catch(() => {});
  // PF-E20 (FM-APP-hunt-deploy-db-01): 비superuser(RDS·Cloud SQL 관리자)는 위 SET 이 늘 실패해 log_statement=ddl 이면 평문 비밀번호가 서버 로그에 남았다
  //   → 평문 대신 SCRAM-SHA-256 검증자를 넘긴다 (Postgres 가 그대로 저장, 로그에는 해시만. 접속은 평문 비밀번호로 그대로 된다)
  const verifier = scramVerifier(password);
  if (exists) await c.query(`ALTER ROLE ${ident(user)} WITH LOGIN${replAttr}${inheritAttr} PASSWORD ${lit(verifier)}`);
  else await c.query(`CREATE ROLE ${ident(user)} WITH LOGIN${replAttr}${inheritAttr} PASSWORD ${lit(verifier)}`);
  await c.query(`RESET log_statement`).catch(() => {});
  // PG16+: 멤버십마다 INHERIT 옵션이 따로 있고 기본값은 "부여할 때의 계정 INHERIT 속성"이다. 예전에 NOINHERIT 로 만든 계정의 멤버십은
  //   ALTER ROLE … INHERIT 뒤에도 inherit=false 로 남아 WAL sender 가 계속 거부됐다 (2026-11-05 임시 RDS 실측) → 명시한다
  if (e.provider === "rds") {
    const v = Number((await c.query<{ v: string }>(`SELECT current_setting('server_version_num') v`)).rows[0]!.v);
    await c.query(`GRANT rds_replication TO ${ident(user)}${v >= 160000 ? " WITH INHERIT TRUE" : ""}`);
  }
  // 초기 복사(COPY)는 이 계정으로 표를 읽는다 → 발행에 든 표만 SELECT
  const t = await c.query<{ schemaname: string; tablename: string }>(
    `SELECT schemaname, tablename FROM pg_publication_tables WHERE pubname=$1`, [name]);
  for (const s of new Set(t.rows.map((r) => r.schemaname))) await c.query(`GRANT USAGE ON SCHEMA ${ident(s)} TO ${ident(user)}`);
  for (const r of t.rows) await c.query(`GRANT SELECT ON ${qualified(r.schemaname, r.tablename)} TO ${ident(user)}`);
  return { user, password };
}

/** PF-E20: RFC 5802/7677 SCRAM-SHA-256 저장 모양 (Postgres pg_authid 와 같은 꼴). 비밀번호는 base64url 글자라 SASLprep 이 바꿀 게 없다 */
export function scramVerifier(password: string, salt: Buffer = randomBytes(16), iterations = 4096): string {
  const salted = pbkdf2Sync(password, salt, iterations, 32, "sha256");
  const clientKey = createHmac("sha256", salted).update("Client Key").digest();
  const storedKey = createHash("sha256").update(clientKey).digest();
  const serverKey = createHmac("sha256", salted).update("Server Key").digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString("base64")}$${storedKey.toString("base64")}:${serverKey.toString("base64")}`;
}

/** 상대 DB 접속 문자열(peerUrl)의 계정·비밀번호만 바꾼다. 주소·포트·DB·sslmode는 그대로 */
export function withUser(peerUrl: string, user: string, password: string): string {
  let u: URL;
  try { u = new URL(peerUrl); } catch { throw new Error("REPL_EPHEMERAL_USER=1 needs URL-form peer connection string (postgres://...)"); }
  u.username = encodeURIComponent(user); u.password = encodeURIComponent(password);
  return u.toString();
}

/** 구독에 넣을 접속 문자열. 켜져 있으면 전용 계정을 만들어 그 계정으로, 꺼져 있으면 예전처럼 상대 peerUrl 그대로 */
export async function subscriptionConninfo(from: Endpoint, name: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const base = withConnectTimeout(peerUrlOf(from), env);
  if (!ephemeralEnabled(env)) return base;
  const { user, password } = await withClient(from, (c) => ensureReplUser(c, from, name));
  return withUser(base, user, password);
}

/** PF-E7 (FM-APP-16): 구독 접속 문자열에 connect_timeout 이 없으면 붙인다 (기본 10초, REPL_PEER_CONNECT_TIMEOUT_SEC).
 *  없으면 상대(출발)가 안 닿을 때 CREATE SUBSCRIPTION 이 도착 서버의 TCP 시간 초과(약 2분 14초)까지 막혀, 재시도 4번이면 paused 까지 ~10분.
 *  URL 모양(postgres://…)만 손댄다. key=value 모양·이미 있는 값은 그대로. 0 이면 안 붙인다 */
export function withConnectTimeout(url: string, env: NodeJS.ProcessEnv = process.env): string {
  const sec = env.REPL_PEER_CONNECT_TIMEOUT_SEC === undefined || env.REPL_PEER_CONNECT_TIMEOUT_SEC === "" ? 10 : Number(env.REPL_PEER_CONNECT_TIMEOUT_SEC);
  if (!Number.isFinite(sec) || sec <= 0 || !/^postgres(ql)?:\/\//.test(url) || /[?&]connect_timeout=/.test(url)) return url;
  return `${url}${url.includes("?") ? "&" : "?"}connect_timeout=${Math.floor(sec)}`;
}

/** 정리: 전용 계정의 권한을 거두고 지운다. 남은 접속(walsender)은 끊는다. 없으면 아무것도 안 함. 지웠으면 true */
export async function dropReplUser(c: pg.Client, name: string): Promise<boolean> {
  const user = replUserOf(name);
  if ((await c.query(`SELECT 1 FROM pg_roles WHERE rolname=$1`, [user])).rowCount !== 1) return false;
  await c.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename=$1`, [user]);
  // PF-E15 (FM-APP-28): PG16 비superuser(RDS rds_superuser·Cloud SQL·CNPG 앱 관리자)는 CREATEROLE 로 만든 계정에 ADMIN 만 있고 권한 상속이 없어
  //   DROP OWNED 가 'permission denied to drop objects' 로 실패했다 → 먼저 그 계정을 자기에게 준다 (superuser 면 이미 되므로 실패 무시)
  await c.query(`GRANT ${ident(user)} TO CURRENT_USER`).catch(() => undefined);
  await c.query(`DROP OWNED BY ${ident(user)}`);   // 이 DB 안에서 준 권한 회수 (가진 객체는 없다)
  await c.query(`DROP ROLE ${ident(user)}`);
  return true;
}
