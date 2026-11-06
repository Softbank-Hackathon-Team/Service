import { z } from "zod";
import { ChartSealedSecret } from "./chart-values.js";

// DECISION(team): 끝점은 이전마다 DB 행으로 (2026-11-05, 보안·온프레 영역)
// 이전 하나의 복제 끝점 한쪽 (db 0050 replication_endpoints 한 줄). core 가 읽고·쓰고, 워커(@svc/replication)가 Endpoint 로 바꾼다.
// 비밀번호는 칸에 없다. password_ref 만 있고, 진짜 값은 워커가 실행할 때만 만든다 (저장·로그 금지)

/** 비밀번호 참조 문법.
 *  derive:<용도>  = REPL_SECRET_MASTER_KEY 로 HMAC 유도 (회사·이전·쪽·용도마다 다름)
 *  env:<이름>     = 워커 환경 변수. 이름은 REPL_SECRET_ 로 시작해야 한다 (행이 DATABASE_URL 같은 다른 비밀을 못 읽게)
 *  aws-sm:<ARN>   = 출발 RDS 가 관리하는 마스터 비밀(Secrets Manager rds!db-…). 워커가 출발 실행 역할을 빌려 그때그때 읽고 메모리에만 둔다
 *  tf:<키>        = 도착 클라우드 DB 비밀번호. 실행기가 도착 비밀 그릇에서 꺼내 이전 작업 폴더 db-secret.json(0600)에 둔 값 (키는 _password 로 끝남) */
// DRAFT(ai): 용도 글자는 소문자·숫자·_·- 1~64자. db 0050·0053·0054 의 CHECK 와 같은 규칙
// DRAFT(ai): aws-sm 은 RDS 관리 비밀(rds!db-)만 받는다. 줄이 고객 계정의 다른 비밀을 가리키지 못하게 (고객 역할 문장도 rds!db-* + 그 DB 태그로만 허용)
export const PASSWORD_REF_RE =
  /^(derive:[a-z0-9_-]{1,64}|env:REPL_SECRET_[A-Z0-9_]+|aws-sm:arn:aws:secretsmanager:[a-z0-9-]+:[0-9]{12}:secret:rds!db-[A-Za-z0-9-]+|tf:[a-z0-9_]{1,55}_password)$/;

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
  passwordRef: z.string().regex(PASSWORD_REF_RE, "passwordRef: derive:<용도> | env:REPL_SECRET_<이름> | aws-sm:<RDS 관리 비밀 ARN> | tf:<…_password>"),
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
  /** 중계기 공개 주소 (온프레 터널 dbTunnel.relay.host). 도착 줄 또는 온프레 CNPG 줄에만 (db 0057) */
  relayHost: z.string().min(1).max(253).regex(/^[A-Za-z0-9.-]+$/, "relayHost: IP 또는 이름만").nullable(),
  /** 중계기 호스트 키 줄 (ssh-keyscan 출력, 공개 값). 터널이 처음 보는 키를 거부하도록 고정한다. 개인 키는 받지 않는다 */
  relayKnownHosts: z.string().min(1).max(8192)
    .refine((s) => !/PRIVATE KEY/.test(s), "relayKnownHosts: 개인 키는 넣지 않는다")
    .refine((s) => s.split("\n").some((l) => /^\S+ (ssh-ed25519|ecdsa-sha2-nistp256|ssh-rsa) [A-Za-z0-9+/=]+/.test(l.trim())), "relayKnownHosts: `<호스트> <키 종류> <키>` 줄이 하나 이상")
    .nullable(),
  /** 중계기 sshd 포트 (기본 22) */
  relayPort: PORT,
}).strict()
  .refine((e) => e.peerPort === null || e.peerHost !== null, { message: "peerPort 는 peerHost 와 같이", path: ["peerPort"] })
  // db 0057: 온프레 CNPG 줄이면 출발(source)이어도 중계기 칸을 쓴다 (온프레 → 클라우드, ADR-031 R4)
  .refine((e) => e.side === "target" || e.provider === "cnpg" || (e.relayHost === null && e.relayKnownHosts === null), { message: "relay* 는 도착(target) 줄 또는 CNPG 줄에만", path: ["relayHost"] })
  .refine((e) => (e.relayHost === null) === (e.relayKnownHosts === null), { message: "relayHost 와 relayKnownHosts 는 같이", path: ["relayKnownHosts"] });
export type ReplicationEndpoint = z.infer<typeof ReplicationEndpoint>;

// DRAFT(ai): 워커가 이전마다 봉인한 SealedSecret 값(암호문만)과 그 입력 지문 (db 0050 sealed_material, 도착 줄).
//   다시 렌더할 때 digest 가 같고 도착 줄 ca_pem 이 caSha256 과 같으면 이 값을 그대로 다시 쓴다 → 같은 입력이면 같은 커밋 묶음.
//   digest = HMAC-SHA256(REPL_SECRET_MASTER_KEY, 입력) 이라 마스터 키를 바꾸면 다시 봉인한다. 평문은 없다 (apps/worker gitops/replication-delivery.ts)
export const ReplicationSealedMaterial = z.object({
  version: z.literal(1),
  digest: z.string().regex(/^[0-9a-f]{64}$/),
  caSha256: z.string().regex(/^[0-9a-f]{64}$/),
  sealedSecrets: z.array(ChartSealedSecret).min(1).max(10),
}).strict();
export type ReplicationSealedMaterial = z.infer<typeof ReplicationSealedMaterial>;
