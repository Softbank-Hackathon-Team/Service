import { connect as netConnect } from "node:net";
import type { Endpoint, EndpointTls, Provider, SslMode } from "./endpoint.js";
import { parsePasswordRef, resolvePasswordRef, type ManagedSecrets } from "./secret-ref.js";

// DECISION(team): 끝점은 이전마다 DB 행으로 (2026-11-05, 보안·온프레 영역)
// replication_endpoints 한 줄 → Endpoint. 순수 함수 (비밀번호 참조 풀기만 env 를 읽는다)

/** contracts ReplicationEndpoint 와 같은 모양.
 *  DRAFT(ai): 이 패키지는 따로 도는 package-lock.json 이 있어 @svc/* 에 기대지 않는다. 그래서 z.infer 대신 구조 타입으로 받는다.
 *  워커가 contracts 값을 그대로 넘기므로 모양이 어긋나면 워커 타입 검사가 깨진다 */
export interface EndpointRecord {
  tenantId: string; migrationId: string; side: "source" | "target"; label: string; provider: Provider;
  host: string; port: number; dbname: string; username: string; passwordRef: string;
  peerHost: string | null; peerPort: number | null; appRole: string; fenceRoles: string[]; schemaName: string | null;
  sslmode: SslMode | null; tlsServername: string | null; caPem: string | null;
}

const hostPart = (h: string) => (h.includes(":") && !h.startsWith("[") ? `[${h}]` : h);
const pgUrl = (user: string, pass: string, host: string, port: number, db: string, query = "") =>
  `postgres://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${hostPart(host)}:${port}/${encodeURIComponent(db)}${query}`;

/** 줄 → Endpoint. 비밀번호는 여기서만 풀어 접속 문자열 안에만 둔다 (반환값을 로그에 남기지 않는다) */
export function endpointFromRecord(r: EndpointRecord, env: NodeJS.ProcessEnv = process.env, managed?: ManagedSecrets): Endpoint {
  const pass = resolvePasswordRef(r.passwordRef, { tenantId: r.tenantId, migrationId: r.migrationId, side: r.side }, env, managed);
  // 관리 비밀(aws-sm)은 고객 DB 의 마스터 비밀번호다. 구독 접속 문자열(pg_subscription.subconninfo, 상대 서버에 평문 저장)에 넣지 않고
  //   이 길 전용 계정을 만들어 그 계정만 넣는다 (Z52 repluser). REPL_EPHEMERAL_USER 전역 설정과 상관없이 이 끝점은 늘 켠다
  const managedAdmin = parsePasswordRef(r.passwordRef).kind === "aws-sm";
  const tls: EndpointTls | undefined = r.sslmode ? {
    mode: r.sslmode,
    ...(r.caPem ? { caPem: r.caPem } : {}),
    // DRAFT(ai): 줄에 ca_pem 이 없으면 워커의 공용 CA 묶음(REPL_CA_FILE, RDS 지역 묶음 + Cloud SQL CA)을 쓴다.
    //   CA 묶음은 회사별 끝점 값이 아니라 공개 신뢰 설정이라 "줄과 env 를 섞지 않는다" 규칙 밖으로 봤다
    ...(!r.caPem && env.REPL_CA_FILE ? { caFile: env.REPL_CA_FILE } : {}),
    ...(r.tlsServername ? { servername: r.tlsServername } : {}),
  } : undefined;
  // 상대 DB(CREATE SUBSCRIPTION)가 붙는 주소. 워커 쪽 TLS 를 켰으면 sslmode=require 를 붙인다 (peerTlsProblem 규칙과 같다).
  // DRAFT(ai): 상대 쪽은 verify-* 가 아니라 require: 관리형 DB 서버에는 CA 파일을 둘 수 없다 (endpoint.ts peerTlsProblem 주석과 같은 이유)
  const peerQuery = r.sslmode ? "?sslmode=require" : "";
  const peerUrl = r.peerHost || r.sslmode
    ? pgUrl(r.username, pass, r.peerHost ?? r.host, r.peerPort ?? r.port, r.dbname, peerQuery)
    : undefined;
  return {
    label: r.label,
    provider: r.provider,
    adminUrl: pgUrl(r.username, pass, r.host, r.port, r.dbname),
    ...(peerUrl ? { peerUrl } : {}),
    appRole: r.appRole,
    ...(r.fenceRoles.length ? { fenceRoles: [...r.fenceRoles] } : {}),
    ...(r.schemaName ? { schema: r.schemaName } : {}),
    ...(tls ? { tls } : {}),
    ...(managedAdmin ? { ephemeralPeerUser: true } : {}),
    origin: "db",
  };
}

/** 워커가 붙는 주소 (adminUrl 의 host·port). 도달 확인·오류 글자용 (비밀번호 없음) */
export function endpointAddress(e: Endpoint): { host: string; port: number } {
  const u = new URL(e.adminUrl);
  return { host: u.hostname.replace(/^\[|\]$/g, ""), port: Number(u.port || 5432) };
}

/** TCP 연결만 해 본다 (DB 로그인 없음). 시간 안에 붙으면 null, 아니면 이유 글자 */
export function tcpReachProblem(host: string, port: number, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    const s = netConnect({ host, port });
    const done = (why: string | null) => { clearTimeout(t); s.removeAllListeners(); s.on("error", () => {}); s.destroy(); resolve(why); };
    const t = setTimeout(() => done(`${timeoutMs}ms 안에 TCP 연결 안 됨`), timeoutMs);
    s.once("connect", () => done(null));
    s.once("error", (e: NodeJS.ErrnoException) => done(e.code ?? e.message));
  });
}
