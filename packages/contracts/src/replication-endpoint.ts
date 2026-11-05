import { z } from "zod";

// DECISION(team): 끝점은 이전마다 DB 행으로 (2026-11-05, 보안·온프레 영역)
// 이전 하나의 복제 끝점 한쪽 (db 0050 replication_endpoints 한 줄). core 가 읽고·쓰고, 워커(@svc/replication)가 Endpoint 로 바꾼다.
// 비밀번호는 칸에 없다. password_ref 만 있고, 진짜 값은 워커가 실행할 때만 만든다 (저장·로그 금지)

/** 비밀번호 참조 문법.
 *  derive:<용도>  = REPL_SECRET_MASTER_KEY 로 HMAC 유도 (회사·이전·쪽·용도마다 다름)
 *  env:<이름>     = 워커 환경 변수. 이름은 REPL_SECRET_ 로 시작해야 한다 (행이 DATABASE_URL 같은 다른 비밀을 못 읽게) */
// DRAFT(ai): 용도 글자는 소문자·숫자·_·- 1~64자. db 0050 의 CHECK 와 같은 규칙
export const PASSWORD_REF_RE = /^(derive:[a-z0-9_-]{1,64}|env:REPL_SECRET_[A-Z0-9_]+)$/;

export const ReplicationSide = z.enum(["source", "target"]);
export type ReplicationSide = z.infer<typeof ReplicationSide>;

export const ReplicationProvider = z.enum(["postgres", "rds", "cloudsql", "cnpg", "azure"]);
export const ReplicationSslMode = z.enum(["require", "verify-ca", "verify-full"]);

// DRAFT(ai): 주소 칸은 접속 문자열에 그대로 들어가므로 URL 을 깨는 글자(/ @ ? # 공백)를 막는다. IPv6 는 대괄호 없이 받는다
const HOST = z.string().min(1).max(253).regex(/^[A-Za-z0-9.:_-]+$/, "host: 글자·숫자·. : _ - 만");
const PORT = z.number().int().min(1).max(65535);
const NAME = z.string().min(1).max(63);

export const ReplicationEndpoint = z.object({
  tenantId: z.uuid(),
  migrationId: z.uuid(),
  side: ReplicationSide,
  label: z.string().min(1).max(100),
  provider: ReplicationProvider,
  host: HOST,
  port: PORT,
  dbname: NAME,
  username: NAME,
  passwordRef: z.string().regex(PASSWORD_REF_RE, "passwordRef: derive:<용도> | env:REPL_SECRET_<이름>"),
  /** 상대 DB 가 이 DB 에 붙을 때(CREATE SUBSCRIPTION) 쓰는 주소. 없으면 host/port */
  peerHost: HOST.nullable(),
  peerPort: PORT.nullable(),
  appRole: NAME,
  fenceRoles: z.array(NAME).max(20),
  schemaName: NAME.nullable(),
  sslmode: ReplicationSslMode.nullable(),
  /** host 가 IP(중계기 등)일 때 서버 인증서에서 확인할 이름 (verify-full) */
  tlsServername: z.string().min(1).max(253).regex(/^[A-Za-z0-9.-]+$/).nullable(),
  /** 공개 CA 인증서 PEM. 개인 키는 받지 않는다 */
  caPem: z.string().max(65536)
    .refine((s) => s.includes("-----BEGIN CERTIFICATE-----"), "caPem: CERTIFICATE PEM 이어야 한다")
    .refine((s) => !/PRIVATE KEY/.test(s), "caPem: 개인 키는 넣지 않는다")
    .nullable(),
}).strict().refine((e) => e.peerPort === null || e.peerHost !== null, { message: "peerPort 는 peerHost 와 같이", path: ["peerPort"] });
export type ReplicationEndpoint = z.infer<typeof ReplicationEndpoint>;
