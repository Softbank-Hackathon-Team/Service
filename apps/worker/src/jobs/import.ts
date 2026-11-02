import { AppSpec, ImportResultV2, MigrationJob, checkV2, type FieldMeta, type ObserveSession, type Provider, type RawInventory } from "@svc/contracts";
import { withTenant, advance } from "@svc/core";
import { AWS_DATA_READ_ACTIONS, AdapterError, adapterFor, discoverForImport, ECS_OBSERVE_ACTIONS, envFor, inventoryForAudit, isAdapterError, normalizeV2, projectV1 } from "@svc/adapters";
import { StsCliError, TempRoleDenied } from "@svc/security";
import { tempRoles } from "../platform.js";
import { failedAttempts, recordAttemptFailure } from "./_step.js";
import { envNumber } from "@svc/contracts";

// Z38-4: import 는 runStep 을 안 지나서 잠금도 청소 대상도 아니다. 재시도(retryLimit 3)를 다 쓰면 importing 에 영원히 남았다.
//   (Z19 의 "마지막 시도 실패 → failed/paused" 도 runStep 안에만 있어 여기는 못 덮는다)
// DRAFT(ai): 첫 시도 + 재시도 3 = 4번째 실패면 importing → failed(IMPORT_FAILED). 명세 모양 오류(Zod)는 다시 해도 같으니 바로 failed
// Z88: 어댑터 오류 코드 → 실패 사유
const SOURCE_FAILURE = { SOURCE_UNAVAILABLE: "IMPORT_SOURCE_UNAVAILABLE", SOURCE_INCOMPLETE: "IMPORT_SOURCE_INCOMPLETE" } as const;
export const IMPORT_MAX_ATTEMPTS = envNumber(process.env.IMPORT_MAX_ATTEMPTS, 4);

// 가져오기: 출발 환경을 읽어 공통 명세(spec v1)를 만든다
// M10: runStep과 같은 3구간. ① 재확인(짧은 트랜잭션) → ② discover(트랜잭션 밖, 진짜 클라우드 API면 수 초~수십 초)
//      → ③ 행 잠금 + 상태 다시 확인 + 저장 + advance (한 트랜잭션). 예전엔 discover를 트랜잭션 안에서 불러
//      풀 연결(10개)을 쥔 채 "idle in transaction"이 됐다
export async function handleImport(raw: unknown) {
  const job = MigrationJob.parse(raw); // 큐 내용은 믿지 않는다: 모양부터
  try {
    await importOnce(job);
  } catch (e) {
    const msg = ((e as Error)?.message ?? String(e)).slice(0, 500);
    const zod = (e as { name?: string })?.name === "ZodError";   // worker 는 zod 를 직접 의존하지 않는다
    // Z88: 출발 환경 못 읽음·재료 없음은 다시 해도 같다 (자격·클러스터를 사람이 고쳐야 함) → 바로 failed + 이유 그대로
    const source = isAdapterError(e) && (e.code === "SOURCE_UNAVAILABLE" || e.code === "SOURCE_INCOMPLETE") ? (e.code as keyof typeof SOURCE_FAILURE) : null;
    // I3b: 공통 명세 v2 구조 오류(checkV2 errors)도 다시 해도 같다 → 바로 failed(IMPORT_SPEC_INVALID)
    const v2invalid = isAdapterError(e) && (e.code === "SPEC_V2_INVALID" || e.code === "IMPORT_IR_INVALID");
    const permanent = zod || v2invalid || source !== null;
    // L5fix: 읽다가 일시 오류(SOURCE_TRANSIENT)는 다시 해 본다. 재시도를 다 쓰고도 안 되면 사유는 "출발 못 읽음"(IMPORT_FAILED 가 아니라)
    const transient = isAdapterError(e) && e.code === "SOURCE_TRANSIENT";
    const code = source ? SOURCE_FAILURE[source] : transient ? "IMPORT_SOURCE_UNAVAILABLE" : permanent ? "IMPORT_SPEC_INVALID" : "IMPORT_FAILED";
    const attempts = (await failedAttempts(job, "import")) + 1;
    if (!permanent && attempts < IMPORT_MAX_ATTEMPTS) {
      await recordAttemptFailure(job, "import", { attempts, max: IMPORT_MAX_ATTEMPTS, error: msg });
      throw e;   // pg-boss 재시도
    }
    await withTenant(job.tenantId, (tx) => advance(tx, { id: job.migrationId, tenantId: job.tenantId }, "importing", "failed", {
      mode: "ifStill", failureCode: code,
      audit: { actor: "worker", action: "migration.failed", target: job.migrationId, result: "error",
               detail: { requestId: job.requestId, error: msg, attempts, permanent } },
    }));
  }
}

async function importOnce(job: MigrationJob) {
  // ① 재확인: DB에서 다시 읽는다 (회사 벽 안에서)
  const row = await withTenant(job.tenantId, async (tx) => {
    const m = await tx.query(
      `SELECT m.status, m.source_env_id, e.provider, e.connection_status, e.account_id, e.region FROM migrations m
         JOIN environments e ON e.id = m.source_env_id WHERE m.id=$1`, [job.migrationId]);
    const r = m.rows[0] as { status: string; source_env_id: string; provider: string; connection_status: string;
      account_id: string | null; region: string | null } | undefined;
    return r && r.status === "importing" ? r : null;   // 두 번 온 작업이면 아무것도 안 함
  });
  if (!row) return;
  // L5: 출발 환경이 연결됨(또는 불안정이지만 아직 연결)이 아니면 읽지 않는다 (빌릴 역할이 없거나 끊김). 다시 해도 같다 → 영구 실패
  // DRAFT(ai): unstable 도 허용 (주기 재확인 실패 = 일시적일 수 있음. 새 실행 거부는 guards 몫)
  if (row.connection_status !== "connected" && row.connection_status !== "unstable")
    throw new AdapterError("SOURCE_UNAVAILABLE", `출발 환경이 연결 상태가 아님 (${row.connection_status})`);

  // ② 바깥 호출 (트랜잭션 밖). L5: 출발 환경 관찰 역할을 빌려 읽고, 끝나면 바로 돌려준다
  const sess = await borrowObserve(job, row);
  try {
    // I3b: 깃발은 여기서 매번 읽는다(R16: 시험이 한 프로세스에서 켰다 껐다). adapters 는 환경변수를 안 읽고 옵션으로만 받는다
    // I3bfix DRAFT(ai): 앞뒤 공백은 config 검사(trim)와 같이 무시. 비었으면 v1. v1·v2 가 아닌 값(V2, 2 …)은 조용히 v1 로 가지 않고 영구 실패(IMPORT_SPEC_INVALID)
  const flag = process.env.IMPORT_IR?.trim();
  if (flag && flag !== "v1" && flag !== "v2") throw new AdapterError("IMPORT_IR_INVALID", `IMPORT_IR 은 v1 | v2 중 하나 (받은 값: ${flag.slice(0, 20)})`);
  const ir = flag === "v2" ? "v2" : "v1";
    const v2 = ir === "v2" ? await importV2(row.provider as Provider, sess.session) : null;
    let inv: RawInventory, spec: unknown, fieldMeta: FieldMeta;
    if (v2) ({ inv, spec, fieldMeta } = v2);
    else {
      const a = adapterFor(row.provider as Provider);
      inv = await a.discover(sess.session, { kind: "container", selector: "*" });
      ({ spec, fieldMeta } = a.normalize(inv));
    }
    await saveImport(job, inv, spec, fieldMeta, ir, v2);
  } finally {
    await sess.release();
  }
}

// L5: 가져오기 관찰 역할 (설계 AF 7 2단계). 진짜 발급기(REAL_STS=1 + external_id)면 빌린 키를 discover 자식 CLI env 로만 넘긴다.
//   가짜 발급기(stub)면 지금처럼 프로세스 자격 (cliEnv 없음). 장부에 issued → revoked(import_done) 가 남는다
// DRAFT(ai): 자격 수명 1시간 (요청 상한 3600). import 는 재발급 고리(_roles.ts)에 없고, 복사한 cliEnv 는 재발급돼도 안 바뀐다
export const IMPORT_OBSERVE_TTL_SEC = 3600;
// DRAFT(ai): discover 가 실제로 부르는 읽기 동작 (discover/index.ts aws 쪽 명령과 같은 목록)
export const IMPORT_OBSERVE_ACTIONS = ["sts:GetCallerIdentity", "eks:ListClusters", "eks:DescribeCluster", "rds:DescribeDBInstances",
  "ec2:DescribeVpcs", "elasticloadbalancing:DescribeLoadBalancers", "ecr:DescribeRepositories", "secretsmanager:ListSecrets"];
// OBSROLE: 깃발 IMPORT_IR=v2 일 때만 데이터 자원 읽기(S3·SQS·ElastiCache) 동작을 더해 요청한다 (깃발 off = 지금 목록 그대로).
//   목록 원본은 adapters discover/data.ts (고객 관찰 역할 템플릿도 같은 목록을 가져감)
//   I9: v2 는 ECS·ALB 규칙·Auto Scaling 읽기(adapters import/readers/aws-ecs.ts)도 더한다
export const importObserveActions = (): string[] =>
  process.env.IMPORT_IR?.trim() === "v2" ? [...IMPORT_OBSERVE_ACTIONS, ...AWS_DATA_READ_ACTIONS, ...ECS_OBSERVE_ACTIONS] : IMPORT_OBSERVE_ACTIONS;
async function borrowObserve(job: MigrationJob, row: { source_env_id: string; provider: string; account_id: string | null; region: string | null }) {
  const roles = tempRoles();
  let ref: string;
  let session: ObserveSession;
  try {
    const cred = await roles.issue({ tenantId: job.tenantId, envId: row.source_env_id, provider: row.provider as Provider,
      purpose: "observe", migrationId: job.migrationId, actions: importObserveActions(), ttlSec: IMPORT_OBSERVE_TTL_SEC }, { step: "import" });
    ref = cred.credentialRef;
    session = { accountId: row.account_id ?? "dev", expiresAt: cred.expiresAt, ...(row.region ? { region: row.region } : {}) };
    if (!cred.stub) {
      const k = roles.use(ref, job.tenantId, job.migrationId);
      // DRAFT(ai): 환경에 리전이 없으면 서울 (issuers.ts AWS_DEFAULT_REGION 과 같음)
      if (k.kind === "aws") session.cliEnv = { AWS_ACCESS_KEY_ID: k.accessKeyId, AWS_SECRET_ACCESS_KEY: k.secretAccessKey,
        AWS_SESSION_TOKEN: k.sessionToken, AWS_REGION: row.region || "ap-northeast-2" };
    }
  } catch (e) {
    // 역할을 못 빌림(거부·없음) = 사람이 연결을 고쳐야 함 → 영구 실패. 그 밖(네트워크·명령 없음)은 재시도
    if (e instanceof TempRoleDenied) throw new AdapterError("SOURCE_UNAVAILABLE", `출발 관찰 역할을 못 빌림 (${e.code})`);
    if (e instanceof StsCliError && e.awsCode) throw new AdapterError("SOURCE_UNAVAILABLE", `출발 관찰 역할을 못 빌림 (${e.awsCode})`);
    throw e;
  }
  return {
    session,
    release: () => roles.revoke(ref, job.tenantId, "import_done").then(() => undefined, (e) => console.error("import revoke", (e as Error).message)),
  };
}

async function saveImport(job: MigrationJob, inv: RawInventory, spec: unknown, fieldMeta: FieldMeta, ir: string, v2: V2Import | null) {
  AppSpec.parse(spec); // T02 조건: 명세 Zod 통과

  // ③ 저장 + 상태 한 칸. 행을 먼저 잠그고 상태를 다시 본다 (② 동안 취소·두 번째 작업이 지나갔을 수 있다)
  await withTenant(job.tenantId, async (tx) => {
    const now = await tx.query("SELECT status FROM migrations WHERE id=$1 FOR UPDATE", [job.migrationId]);
    if (now.rows[0]?.status !== "importing") return;
    // 깃발 off(또는 v2 에서 되돌아감) INSERT 는 지금과 글자 하나 안 바꾼다 (0023 적용 전 DB 에서도 동작)
    if (v2?.result) await tx.query(
      `INSERT INTO spec_versions (tenant_id, migration_id, version, spec, field_meta, spec_v2)
       VALUES ($1,$2,1,$3,$4,$5)`, [job.tenantId, job.migrationId, spec, fieldMeta, v2.result]);
    else await tx.query(
      `INSERT INTO spec_versions (tenant_id, migration_id, version, spec, field_meta)
       VALUES ($1,$2,1,$3,$4)`, [job.tenantId, job.migrationId, spec, fieldMeta]);
    await advance(tx, { id: job.migrationId, tenantId: job.tenantId }, "importing", "spec_review", {
      mode: "ifStill",
      // Z88: 읽은 출발 자원 목록(종류·이름·버전만, 환경변수는 이름만)을 감사에 남긴다 → provisioning(Z89)이 "이미 있음" 판단에 쓴다
      audit: { actor: "worker", action: "migration.spec_review", target: job.migrationId, result: "ok",
               detail: { sourceInventory: inventoryForAudit(inv), ...(ir === "v2" ? { ir: v2?.result ? "v2" : "v1-fallback", ...(v2?.note ? { note: v2.note } : {}) } : {}) } },
    });
  });
}

// I3b: 공통 명세 v2 가져오기 (설계 24번 2장). discover(v2) → normalizeV2 → checkV2 → projectV1.
//   원본에 k8s 워크로드가 하나도 없으면(사실상 MOCK aws 의 ECS 원본) v1 경로로 되돌아간다: v1 discover 를 다시 부르고 spec_v2 는 NULL
//   checkV2 errors(구조 오류)만 막는다. reviews(벤더 주소·사설 IP 남음)는 spec_v2.fieldMeta 검토 표시만
type V2Import = { inv: RawInventory; spec: unknown; fieldMeta: FieldMeta; result: ImportResultV2 | null; note?: string };
async function importV2(p: Provider, sess: ObserveSession): Promise<V2Import> {
  // I4: 깃발 IMPORT_AWS_IAM=1 이면 앱 신원의 IAM 정책도 읽어 grants·기준선을 채운다 (기본 꺼짐 = 지금 그대로)
  const inv = await discoverForImport(p, { ir: "v2", iam: process.env.IMPORT_AWS_IAM === "1" }, sess.cliEnv ? { env: envFor(sess.cliEnv) } : {});
  // I9: ECS 서비스도 v2 워크로드 (관리형 컨테이너 갈래). 워크로드가 하나도 없을 때만 v1 경로로 되돌아간다
  const k8s = (inv.items as Array<{ kind?: string }>).some((i) => i.kind === "k8s.deployment" || i.kind === "k8s.cronjob" || i.kind === "ecs.service");
  if (!k8s) {
    const a = adapterFor(p);
    const inv1 = await a.discover(sess, { kind: "container", selector: "*" });
    const { spec, fieldMeta } = a.normalize(inv1);
    return { inv: inv1, spec, fieldMeta, result: null, note: "원본에 k8s·ECS 워크로드 없음 → v1 경로 (spec_v2 없음)" };
  }
  const { result, projectionEnv } = normalizeV2(inv);
  const { errors, reviews } = checkV2(result.spec);
  if (errors.length) throw new AdapterError("SPEC_V2_INVALID", `공통 명세 v2 검증 실패: ${errors.slice(0, 5).join("; ")}${errors.length > 5 ? ` 외 ${errors.length - 5}개` : ""}`);
  // DRAFT(ai): reviews 는 막지 않고 fieldMeta 에 "check.reviews[i]" 키로 검토 표시 (화면이 needs_review 로 센다)
  reviews.forEach((r, i) => { result.fieldMeta[`check.reviews[${i}]`] = { source: "checkV2", confidence: 0.6, needs_review: true, rationale: r }; });
  const stored = ImportResultV2.parse(result);   // 저장 전 모양 확인 (ZodError → 영구 실패)
  const { spec, fieldMeta } = projectV1(stored, projectionEnv, { mainApp: process.env.IMPORT_APP || undefined });
  return { inv, spec, fieldMeta, result: stored };
}
