import { readFileSync } from "node:fs";
import pg from "pg";

// 어느 클라우드든 "접속 문자열 + 제공자 이름"만 바꾸면 같은 코드가 돈다.
// provider는 점검 메시지(어떤 파라미터를 켜야 하나)에만 쓰고, 복제 SQL 자체는 표준 Postgres와 같다.
export type Provider = "postgres" | "rds" | "cloudsql" | "cnpg" | "azure";

export interface Endpoint {
  /** 사람이 읽는 이름. 로그·측정값에 들어간다 (예: "aws-rds-src") */
  label: string;
  provider: Provider;
  /** 제어판(워커)이 이 DB에 붙을 때 쓰는 관리자 접속 문자열 */
  adminUrl: string;
  /** 상대 DB가 이 DB에 복제 연결을 걸 때 쓰는 접속 문자열 (CREATE SUBSCRIPTION ... CONNECTION).
   *  네트워크 위치가 달라 adminUrl과 다를 수 있다 (도커 안 이름, 사설 IP, 터널). 없으면 adminUrl */
  peerUrl?: string;
  /** 앱이 쓰는 DB 계정. 전환 때 이 계정의 쓰기 권한을 회수(펜스)한다 */
  appRole: string;
  /** APP-22 (가): 앱 계정 말고도 이 DB 에 쓰는 계정 (도착 앱이 컷오버 전까지 출발에 붙는 전용 계정). 울타리를 같이 친다. 없는 계정은 건너뜀 */
  fenceRoles?: string[];
  /** 복제할 표가 있는 스키마. 기본 public */
  schema?: string;
  /** Z77: 워커 → 이 DB 접속의 TLS. 없으면 예전처럼 adminUrl 그대로 (로컬·k3d 데모) */
  tls?: EndpointTls;
  /** 이 끝점을 어디서 만들었나. "db" = replication_endpoints 줄 (이전마다). 없으면 워커 .env (REPL_*) */
  origin?: "db";
}

// Z77 DRAFT(ai): 클라우드 DB 는 TLS + CA 파일로 상대를 확인한다. 규칙은 Z64 PgBouncer server_tls_ca_file 과 같다:
//   CA 묶음 파일 하나(RDS 지역 묶음 + Cloud SQL 서버 CA 를 이어 붙인 db-ca-bundle.pem)를 REPL_CA_FILE 로 준다.
//   verify-full = CA + 주소 이름까지 확인 (RDS 엔드포인트 이름). verify-ca = CA 만 (Cloud SQL 공인 IP: 인증서에 IP 이름이 없을 수 있다【미확인】)
//   require = 암호화만 (CA 확인 없음). 워커 쪽에는 쓰지 않기를 권한다
export type SslMode = "require" | "verify-ca" | "verify-full";
export interface EndpointTls {
  mode: SslMode;
  caFile?: string;
  /** CA 인증서 PEM 글자 (replication_endpoints.ca_pem). 있으면 caFile 보다 먼저 */
  caPem?: string;
  /** host 가 IP 일 때 서버 인증서에서 확인할 이름 (verify-full). node-pg 는 host 가 IP 면 ssl.servername 을 덮어쓰지 않는다
   *  (node_modules/pg/lib/connection.js upgradeToSSL: net.isIP(host) === 0 일 때만 servername = host). host 가 이름이면 pg 가 host 로 덮는다 */
  servername?: string;
}
const SSL_MODES: SslMode[] = ["require", "verify-ca", "verify-full"];

/** 접속 문자열에서 ssl 관련 값을 뺀다. pg 는 문자열 안 sslmode 가 ssl 객체를 덮어써서, CA 파일 규칙이 조용히 무시될 수 있다 */
function stripSslParams(url: string): string {
  try {
    const u = new URL(url);
    for (const k of ["sslmode", "sslrootcert", "sslcert", "sslkey", "ssl", "uselibpqcompat"]) u.searchParams.delete(k);
    return u.toString();
  } catch { return url; }
}

/** pg.Client 설정. tls 가 없으면 예전과 똑같다 */
// RV-06 DRAFT(ai): 고객 DB 연결이 중간에 조용히 끊기면(중계기·터널·NAT 가 패킷을 버림) 응답 없는 질의가 OS 기본 TCP 시간(수 시간) 동안 안 끝난다.
//   컷오버 C2 울타리 뒤(출발 읽기 전용·앱 붙잡힘)에서 걸리면 되돌림(catch) 이 안 돌고, 잠금 연장은 따로 돌아 리퍼도 못 잡는다.
//   → TCP keepalive(10초 뒤부터 probe) 로 죽은 연결을 OS 가 끊게 하고, 접속 자체는 REPL_CONNECT_TIMEOUT_MS(기본 20초) 안에 끝나야 한다.
//   질의 시간 상한(query_timeout)은 안 둔다: node-pg 는 시간만 지나면 약속만 거절하고 연결은 그 질의에 묶인 채라 뒤 질의가 줄 서서 또 멈춘다
const connectTimeoutMs = (env: NodeJS.ProcessEnv = process.env) => {
  const v = env.REPL_CONNECT_TIMEOUT_MS;
  const n = v === undefined || v.trim() === "" ? 20_000 : Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 20_000;
};
export function clientConfig(e: Endpoint, env: NodeJS.ProcessEnv = process.env): pg.ClientConfig {
  const base = { application_name: "svc-replication", keepAlive: true, keepAliveInitialDelayMillis: 10_000, connectionTimeoutMillis: connectTimeoutMs(env) };
  if (!e.tls) return { ...base, connectionString: e.adminUrl };
  const { mode, caFile, caPem, servername } = e.tls;
  if (mode !== "require" && !caFile && !caPem) throw new Error(`${e.label}: sslmode=${mode} 는 CA 파일(REPL_CA_FILE) 또는 ca_pem 이 필요하다`);
  let ca: string | undefined = caPem;
  if (!ca && caFile) {
    try { ca = readFileSync(caFile, "utf8"); } catch (err) { throw new Error(`${e.label}: CA 파일을 못 읽었다 ${caFile} (${(err as Error).message})`); }
  }
  const ssl: pg.ClientConfig["ssl"] = mode === "require"
    ? { rejectUnauthorized: false }
    : { ca, rejectUnauthorized: true, ...(servername ? { servername } : {}), ...(mode === "verify-ca" ? { checkServerIdentity: () => undefined } : {}) };
  return { ...base, connectionString: stripSslParams(e.adminUrl), ssl };
}

/** 상대 DB 가 이 DB 에 붙을 때(CREATE SUBSCRIPTION) 쓰는 문자열의 TLS 문제. 클라우드 DB 는 서버 쪽 CA 파일을 못 두므로 require 이상이면 된다 */
export function peerTlsProblem(e: Endpoint): string | null {
  if (!e.tls) return null;
  const m = /[?&]sslmode=([a-z-]+)/.exec(peerUrlOf(e))?.[1];
  if (!m || !(SSL_MODES as string[]).includes(m))
    return `${e.label}: 상대가 붙는 주소(PEER_URL)에 sslmode=require 이상이 없다 (지금 ${m ?? "없음"}). 공개 경로에서 평문 복제를 막는다`;
  return null;
}

// Z38 REVIEW-5 Z77-2·3 (04 조각): 연결 전에 볼 수 있는 네트워크·TLS 문제
const MANAGED: Provider[] = ["rds", "cloudsql"];
export const isManaged = (e: Endpoint) => MANAGED.includes(e.provider);

/** 사설·로컬 주소면 true. 공개 인터넷을 지나는지 가르는 데만 쓴다 (사설 IP·루프백·점 없는 이름·.internal/.local/.svc) */
export function isPrivateHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  const m = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(h);
  if (m) {
    const a = Number(m[1]), b = Number(m[2]);
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  if (h === "::1" || h.startsWith("fd") || h.startsWith("fc")) return true;
  return !h.includes(".") || /\.(internal|local|svc|cluster\.local)$/.test(h);
}

const hostOf = (url: string) => { try { return new URL(url).hostname; } catch { return ""; } };

/** Z77-3: 관리형 DB(RDS rds.force_ssl=1, Cloud SQL ENCRYPTED_ONLY)는 평문 접속을 거절한다.
 *  워커 쪽 TLS 설정 없이 붙으면 pg 오류("no pg_hba.conf entry … no encryption")만 나와 이유가 안 보이므로 연결 전에 알린다 */
export function workerTlsProblem(e: Endpoint): string | null {
  if (!isManaged(e) || e.tls) return null;
  const m = /[?&]sslmode=([a-z-]+)/.exec(e.adminUrl)?.[1];
  if (m && (SSL_MODES as string[]).includes(m)) return null;   // 문자열에 sslmode=require 이상이면 pg 가 TLS 로 붙는다
  return `${e.label}: ${e.provider} 는 평문 접속을 거절한다. 워커 → DB TLS 설정이 없다 (REPL_*_SSLMODE·REPL_CA_FILE 없음, URL 에 sslmode 없음)`;
}

/** Z77-2: 상대 DB 가 이 DB 의 PEER_URL 로 붙는 길이 평문인데 공개 인터넷을 지나는지.
 *  예전 peerTlsProblem 은 "이 끝점이 워커 쪽 TLS 를 켰을 때"만 봐서, TLS 를 안 켜는 맥 출발(→ Cloud SQL·RDS 가 중계기 공인 IP 로 붙음)을 놓쳤다 */
export function peerPathProblem(e: Endpoint, other: Endpoint): string | null {
  if (e.tls) return peerTlsProblem(e);
  if (!isManaged(other)) return null;                                   // 상대가 로컬·CNPG 면 예전과 같음
  const url = peerUrlOf(e), host = hostOf(url);
  if (!host || isPrivateHost(host)) return null;                        // 중계기 사설 IP(VPC 안 + SSH) 는 괜찮다
  const m = /[?&]sslmode=([a-z-]+)/.exec(url)?.[1];
  if (m && (SSL_MODES as string[]).includes(m)) return null;
  return `${e.label}: ${other.provider} 가 공개 주소 ${host} 로 이 DB 에 붙는데 PEER_URL 에 sslmode=require 이상이 없다 (지금 ${m ?? "없음"}). 공개 경로 평문 복제`;
}

export const schemaOf = (e: Endpoint) => e.schema ?? "public";
export const peerUrlOf = (e: Endpoint) => e.peerUrl ?? e.adminUrl;

/** 관리자 세션 하나. 출발 DB를 read_only로 바꾼 뒤에도 플랫폼 작업은 해야 하므로 세션 단위로 끈다 */
export async function connect(e: Endpoint): Promise<pg.Client> {
  const c = new pg.Client(clientConfig(e));
  c.on("error", () => {});
  await c.connect();
  await c.query("SET default_transaction_read_only = off");
  return c;
}

export async function withClient<T>(e: Endpoint, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = await connect(e);
  try { return await fn(c); } finally { await c.end().catch(() => {}); }
}

/** 환경 변수에서 끝점 만들기. 예: REPL_SOURCE_URL, REPL_SOURCE_PEER_URL, REPL_SOURCE_PROVIDER, REPL_SOURCE_APP_ROLE
 *  Z77 TLS: REPL_<쪽>_SSLMODE (없으면 REPL_SSLMODE), REPL_<쪽>_CA_FILE (없으면 REPL_CA_FILE).
 *  CA 파일만 주면 verify-full. 둘 다 없으면 TLS 설정 없음 (예전과 같다) */
export function endpointFromEnv(prefix: "REPL_SOURCE" | "REPL_TARGET", env: NodeJS.ProcessEnv = process.env): Endpoint {
  const url = env[`${prefix}_URL`];
  if (!url) throw new Error(`${prefix}_URL is not set`);
  return {
    label: env[`${prefix}_LABEL`] || prefix.toLowerCase(),
    provider: (env[`${prefix}_PROVIDER`] as Provider | undefined) || "postgres",
    adminUrl: url,
    peerUrl: env[`${prefix}_PEER_URL`] || undefined,
    // PF-E13 (FM-APP-24): 빈 값은 기본값 (demo-day 가 옛 .env 값을 막으려고 빈 값으로 적는다)
    appRole: env[`${prefix}_APP_ROLE`] || "app_user",
    ...(env[`${prefix}_FENCE_ROLES`] ? { fenceRoles: env[`${prefix}_FENCE_ROLES`]!.split(",").map((x) => x.trim()).filter(Boolean) } : {}),
    schema: env[`${prefix}_SCHEMA`] || undefined,
    tls: tlsFromEnv(prefix, env),
  };
}

function tlsFromEnv(prefix: string, env: NodeJS.ProcessEnv): EndpointTls | undefined {
  const caFile = env[`${prefix}_CA_FILE`] || env.REPL_CA_FILE || undefined;
  const raw = env[`${prefix}_SSLMODE`] || env.REPL_SSLMODE || undefined;
  if (!caFile && !raw) return undefined;
  if (raw === "disable") return undefined; // 로컬 데모에서 한쪽만 끄기
  const mode = (raw ?? "verify-full") as SslMode;
  if (!SSL_MODES.includes(mode)) throw new Error(`${prefix}_SSLMODE=${raw}: require | verify-ca | verify-full | disable 중 하나`);
  return { mode, caFile };
}
