import { tmpdir } from "node:os";
import { envFor, spawnExec, type Exec } from "@svc/adapters";
import type { ReplicationEndpoint } from "@svc/contracts";
import { parsePasswordRef } from "@svc/replication";
import { withStepRoles, type StepRoles } from "../jobs/_roles.js";
import type { MigrationRow } from "../jobs/_step.js";
import { realStsEnabled } from "../platform.js";

// DECISION(team): 출발 DB 관리자 비밀번호는 고객이 넘기지 않는다. RDS 가 관리하는 마스터 비밀(Secrets Manager rds!db-…)을
//   워커가 출발 실행 역할을 빌려 읽는다 (2026-11-06, 보안·온프레 영역 제안 + 연결 템플릿 영역 동의)
// 끝점 줄의 password_ref = aws-sm:<ARN>. 이 파일이 그 값을 읽어 메모리(Map)로만 넘긴다. DB·로그·env·파일에 쓰지 않는다.
// 권한: 고객 실행 역할(svc-operate) 인라인 relay 의 SourceDbMasterSecretRead (rds!db-* 중 태그 aws:rds:primaryDBInstanceArn = 그 DB 하나).
//   세션 정책은 중계기와 같은 relay (security STEP_ROLES.relay). 빌린 자격은 읽자마자 돌려준다
// DRAFT(ai): 캐시 없음. 복제 객체를 만들 때마다(sync·cutover·rollback·cleanup·리퍼, 단계 한 번에 한 번) 새로 읽는다.
//   RDS 는 기본 7일마다 이 비밀을 바꾼다 → 오래 쥐고 있으면 바뀐 뒤 관리자 접속이 실패한다. 단계마다 읽으면 다음 단계(재시도 포함)는 새 값을 쓴다.
//   단계 도중에 바뀌면 그 단계는 인증 실패로 끝나고 다시 시도할 때 새 값을 읽는다. 구독(복제 길)은 관리자 비밀번호를 안 쓴다 (record.ts ephemeralPeerUser)

/** 출발 줄에서 aws-sm 참조의 ARN 들 (중복 없이). 문법이 틀린 줄은 여기서 거르지 않는다 (끝점을 만들 때 REPL_SECRET_UNRESOLVED) */
export function managedSecretArns(rows: readonly Pick<ReplicationEndpoint, "side" | "passwordRef">[]): string[] {
  const out = new Set<string>();
  for (const r of rows) {
    if (r.side !== "source") continue;
    try { const p = parsePasswordRef(r.passwordRef); if (p.kind === "aws-sm") out.add(p.arn); } catch { /* 위 주석 */ }
  }
  return [...out];
}

export class ManagedSecretError extends Error {
  constructor(message: string, readonly awsCode?: string) { super(message); this.name = "ManagedSecretError"; }
}

const AWS_CODE = /An error occurred \(([A-Za-z0-9.]+)\)/;
/** 관리 비밀 하나 읽기 → 비밀번호. RDS 관리 비밀은 {"username","password"} JSON 이다. 오류 글자에 값은 없다 */
export async function readManagedSecret(arn: string, d: { env: NodeJS.ProcessEnv; exec?: Exec; timeoutMs?: number }): Promise<string> {
  const region = arn.split(":")[3] ?? "";
  if (!/^[a-z0-9-]+$/.test(region)) throw new ManagedSecretError("관리 비밀 ARN 에서 리전을 못 읽었다");
  const r = await (d.exec ?? spawnExec)("aws", ["secretsmanager", "get-secret-value", "--secret-id", arn,
    "--query", "SecretString", "--output", "text", "--region", region], { cwd: tmpdir(), env: d.env, timeoutMs: d.timeoutMs ?? 30_000 });
  if (r.code !== 0) {
    const awsCode = AWS_CODE.exec(r.stderr)?.[1];
    // stderr 에 비밀 값은 없다 (실패했으므로). 그래도 길이만 남긴다
    const why = r.code === 127 ? "aws CLI 가 없다 (워커 이미지 확인)" : r.stderr.replace(/\s+/g, " ").trim().slice(0, 200);
    const hint = awsCode === "AccessDeniedException"
      ? " — 연결 스택 입력값 SourceDbInstanceId 에 이 DB 식별자를 넣고 스택을 업데이트했는지 확인" : "";
    throw new ManagedSecretError(`관리 비밀 읽기 실패: ${why}${hint}`, awsCode);
  }
  let password: unknown;
  try { password = (JSON.parse(r.stdout.trim()) as { password?: unknown }).password; } catch { /* 아래 */ }
  if (typeof password !== "string" || !password) throw new ManagedSecretError("관리 비밀 모양이 틀렸다 (password 칸 없음)");
  return password;
}

export interface FetchManagedDeps {
  env?: NodeJS.ProcessEnv;
  exec?: Exec;
  /** 출발 중계기 역할 빌리기 (시험이 바꾼다). 기본 withStepRoles("relay") */
  borrow?: <T>(fn: (r: Pick<StepRoles, "awsEnv" | "denied">) => Promise<T>) => Promise<T>;
  /** 진짜 발급기를 쓰는가 (기본 platform realStsEnabled). 아니면 빌린 자격 대신 워커 자기 자격(개발 맥 프로필)으로 읽는다 */
  realSts?: boolean;
}

/** ARN 들 → 비밀번호 (메모리 Map). 빌림 → 읽기 → 회수가 이 함수 안에서 끝난다 */
export async function fetchManagedSecrets(j: { tenantId: string; migrationId: string }, m: MigrationRow, arns: readonly string[],
  deps: FetchManagedDeps = {}): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!arns.length) return out;
  const base = deps.env ?? process.env;
  const borrow = deps.borrow ?? (<T>(fn: (r: StepRoles) => Promise<T>) => withStepRoles("relay", j, m, fn));
  await borrow(async (roles) => {
    const cred = roles.awsEnv?.source;
    if (!cred) {
      if (roles.denied.length) throw new ManagedSecretError(`출발 실행 역할(중계기 세션 정책)을 못 빌렸다: ${roles.denied.map((x) => x.code).join(",")}`);
      // 진짜 발급기인데 자격이 없으면 워커 자기 자격으로 고객 비밀을 읽으려 하지 않는다
      if (deps.realSts ?? realStsEnabled()) throw new ManagedSecretError("출발 실행 역할 자격이 없다 (출발 환경이 AWS 인지, 연결이 끝났는지)");
    }
    const env = cred ? envFor(cred, base) : base;
    for (const arn of arns) out.set(arn, await readManagedSecret(arn, { env, ...(deps.exec ? { exec: deps.exec } : {}) }));
  });
  return out;
}
