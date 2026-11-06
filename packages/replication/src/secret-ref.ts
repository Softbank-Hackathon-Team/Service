import { createHmac } from "node:crypto";

// DECISION(team): 끝점은 이전마다 DB 행으로 (2026-11-05, 보안·온프레 영역)
// replication_endpoints.password_ref 를 진짜 비밀번호로 바꾸는 곳. 워커가 접속 직전에만 부른다.
// 만든 값은 저장하지 않고, 로그·오류 글자에 넣지 않는다 (오류에는 참조 글자만)
//   derive:<용도> = base64url(HMAC-SHA256(키 = REPL_SECRET_MASTER_KEY, 글 = `${회사}:${이전}:${쪽}:${용도}`)) 앞 32자
//   env:<이름>    = process.env[이름]. 이름은 REPL_SECRET_ 로 시작해야 한다 (행이 DATABASE_URL 같은 다른 비밀을 못 읽게)
//   aws-sm:<ARN>  = 출발 RDS 가 관리하는 마스터 비밀 (Secrets Manager rds!db-…). 이 패키지는 클라우드를 부르지 않는다:
//                   워커가 출발 실행 역할을 빌려 미리 읽은 값(managed: ARN → 비밀번호, 메모리)을 받아서 꺼내기만 한다
// 【사실】 HMAC 을 키 유도에 쓰는 방식은 contracts agent-sig deriveAgentSecret 과 같다 (RFC 5869 HKDF 의 한 단계)

export const REPL_MASTER_KEY_MIN = 32;
const DERIVE_RE = /^derive:([a-z0-9_-]{1,64})$/;
const ENV_RE = /^env:(REPL_SECRET_[A-Z0-9_]+)$/;
// contracts PASSWORD_REF_RE·db 0053 CHECK 와 같은 규칙 (RDS 관리 비밀만)
const AWS_SM_RE = /^aws-sm:(arn:aws:secretsmanager:[a-z0-9-]+:[0-9]{12}:secret:rds!db-[A-Za-z0-9-]+)$/;

export type PasswordRef = { kind: "derive"; purpose: string } | { kind: "env"; name: string } | { kind: "aws-sm"; arn: string };
/** 워커가 미리 읽어 둔 관리 비밀 (ARN → 비밀번호). 메모리에만. 로그·오류에 값을 넣지 않는다 */
export type ManagedSecrets = ReadonlyMap<string, string>;
export interface SecretScope { tenantId: string; migrationId: string; side: "source" | "target" }

/** 참조 글자 해석. 문법이 틀리면 오류 (값은 안 읽는다) */
export function parsePasswordRef(ref: string): PasswordRef {
  const d = DERIVE_RE.exec(ref);
  if (d) return { kind: "derive", purpose: d[1]! };
  const e = ENV_RE.exec(ref);
  if (e) return { kind: "env", name: e[1]! };
  const a = AWS_SM_RE.exec(ref);
  if (a) return { kind: "aws-sm", arn: a[1]! };
  if (ref.startsWith("aws-sm:")) throw new Error(`password_ref aws-sm: 는 RDS 관리 비밀 ARN(…:secret:rds!db-…)만 받는다`);
  if (ref.startsWith("env:")) throw new Error(`password_ref ${JSON.stringify(ref)}: env: 는 REPL_SECRET_[A-Z0-9_]+ 이름만 읽는다`);
  throw new Error(`password_ref 문법이 틀렸다 (derive:<용도> | env:REPL_SECRET_<이름> | aws-sm:<RDS 관리 비밀 ARN>)`);   // 원문은 안 붙인다 (진짜 비밀번호를 넣었을 수 있다)
}

/** derive:<용도> 의 값. gitops(CNPG 역할 비밀번호 렌더) 등 다른 곳도 같은 값을 만들 수 있게 내보낸다 */
export function deriveReplPassword(masterKey: string | undefined, scope: SecretScope, purpose: string): string {
  if (!masterKey) throw new Error("REPL_SECRET_MASTER_KEY 가 없다 (derive: 참조를 풀 수 없음)");
  if (masterKey.length < REPL_MASTER_KEY_MIN) throw new Error(`REPL_SECRET_MASTER_KEY 는 ${REPL_MASTER_KEY_MIN}자 이상`);
  if (!/^[a-z0-9_-]{1,64}$/.test(purpose)) throw new Error(`derive 용도 ${JSON.stringify(purpose)}: 소문자·숫자·_·- 1~64자`);
  return createHmac("sha256", masterKey)
    .update(`${scope.tenantId}:${scope.migrationId}:${scope.side}:${purpose}`)
    .digest("base64url").slice(0, 32);
}

/** 참조 → 비밀번호. 실패하면 오류 (오류 글자에 값은 없다) */
export function resolvePasswordRef(ref: string, scope: SecretScope, env: NodeJS.ProcessEnv = process.env, managed?: ManagedSecrets): string {
  const p = parsePasswordRef(ref);
  if (p.kind === "derive") return deriveReplPassword(env.REPL_SECRET_MASTER_KEY, scope, p.purpose);
  if (p.kind === "aws-sm") {
    const v = managed?.get(p.arn);
    if (!v) throw new Error(`password_ref aws-sm: 워커가 이 관리 비밀을 읽어 오지 못했다 (${p.arn.split(":secret:")[1] ?? "?"})`);
    return v;
  }
  const v = env[p.name];
  if (!v) throw new Error(`password_ref env:${p.name}: 워커 환경 변수가 없거나 비었다`);
  return v;
}
