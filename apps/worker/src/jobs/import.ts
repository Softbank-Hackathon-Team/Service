import { ImportResultV2, MigrationJob, SourceScope, checkV2, checkV2Reviews, syncCheckReviews, specIssueLines, type ObserveSession, type Provider, type RawInventory } from "@svc/contracts";
import { withTenant, advance, scrubString } from "@svc/core";
import { applyInclude, type CliDeps, gcpEnvFor, AWS_DATA_READ_ACTIONS, AWS_NET_READ_ACTIONS, GCP_NET_READ_PERMISSIONS, measureImportAccuracy, targetBuilderFor, GCP_DATA_READ_PERMISSIONS, actionsOfCommands, AdapterError, CLOUDRUN_OBSERVE_PERMISSIONS, discoverForImport, ECS_OBSERVE_ACTIONS, EC2_OBSERVE_ACTIONS, GCE_OBSERVE_PERMISSIONS, envFor, inventoryForAudit, isAdapterError, normalizeV2, carryHumanEdits, type PrevSpecV2 } from "@svc/adapters";
import { StsCliError, TempRoleDenied } from "@svc/security";
import { MOCK_CREDENTIALS, refuseMockCredentials, tempRoles } from "../platform.js";
import { failedAttempts, recordAttemptFailure, isLastAttempt } from "./_step.js";
import { envNumber } from "@svc/contracts";
import { log } from "../instrument.js";
import { onpremPullSource, onpremSnapshotDeps } from "./_onprem-snapshot.js";
import { CLOUDRUN_RAW_KINDS, VM_RAW_KIND } from "@svc/adapters";

// 가져오기가 옮길 원본 워크로드 종류. 하나도 없으면 옮길 앱이 없다 → SOURCE_INCOMPLETE (영구 실패)
const WORKLOAD_KINDS = new Set<string>(["k8s.deployment", "k8s.cronjob", "ecs.service", VM_RAW_KIND, CLOUDRUN_RAW_KINDS.service, CLOUDRUN_RAW_KINDS.job]);

// Z38-4: import 는 runStep 을 안 지나서 잠금도 청소 대상도 아니다. 재시도(retryLimit 3)를 다 쓰면 importing 에 영원히 남았다.
//   (Z19 의 "마지막 시도 실패 → failed/paused" 도 runStep 안에만 있어 여기는 못 덮는다)
// DRAFT(ai): 첫 시도 + 재시도 3 = 4번째 실패면 importing → failed(IMPORT_FAILED). 명세 모양 오류(Zod)는 다시 해도 같으니 바로 failed
// Z88: 어댑터 오류 코드 → 실패 사유
const SOURCE_FAILURE = { SOURCE_UNAVAILABLE: "IMPORT_SOURCE_UNAVAILABLE", SOURCE_INCOMPLETE: "IMPORT_SOURCE_INCOMPLETE" } as const;
export const IMPORT_MAX_ATTEMPTS = envNumber(process.env.IMPORT_MAX_ATTEMPTS, 4);

// 가져오기: 출발 환경을 읽어 공통 명세(IR, spec_versions.spec_v2 칸)를 만든다
// M10: runStep과 같은 3구간. ① 재확인(짧은 트랜잭션) → ② discover(트랜잭션 밖, 진짜 클라우드 API면 수 초~수십 초)
//      → ③ 행 잠금 + 상태 다시 확인 + 저장 + advance (한 트랜잭션). 예전엔 discover를 트랜잭션 안에서 불러
//      풀 연결(10개)을 쥔 채 "idle in transaction"이 됐다
// PF-A9 DRAFT(ai): runStep 과 같은 "transition" 로그 한 줄(prev_state → state, failure_code·reason)과 돌려주는 값("advanced"|"skipped").
//   예전엔 가져오기만 상태 이동 로그가 없어서, 영구 실패(관찰 역할 못 빌림 등)로 failed 가 돼도 워커 로그는 "job finished result:ok" 한 줄뿐이었다
export async function handleImport(raw: unknown): Promise<"advanced" | "skipped"> {
  const job = MigrationJob.parse(raw); // 큐 내용은 믿지 않는다: 모양부터
  try {
    const moved = await importOnce(job);
    log.info({ prev_state: "importing", state: moved ? "spec_review" : "importing", result: moved ? "advanced" : "skipped" },
      moved ? "transition" : "transition lost race");
    return moved ? "advanced" : "skipped";
  } catch (e) {
    const msg = ((e as Error)?.message ?? String(e)).slice(0, 500);
    const zod = (e as { name?: string })?.name === "ZodError";   // worker 는 zod 를 직접 의존하지 않는다
    // Z88: 출발 환경 못 읽음·재료 없음은 다시 해도 같다 (자격·클러스터를 사람이 고쳐야 함) → 바로 failed + 이유 그대로
    const source = isAdapterError(e) && (e.code === "SOURCE_UNAVAILABLE" || e.code === "SOURCE_INCOMPLETE") ? (e.code as keyof typeof SOURCE_FAILURE) : null;
    // I3b: 공통 명세 구조 오류(checkV2 errors)도 다시 해도 같다 → 바로 failed(IMPORT_SPEC_INVALID)
    const v2invalid = isAdapterError(e) && e.code === "SPEC_V2_INVALID";
    const permanent = zod || v2invalid || source !== null;
    // L5fix: 읽다가 일시 오류(SOURCE_TRANSIENT)는 다시 해 본다. 재시도를 다 쓰고도 안 되면 사유는 "출발 못 읽음"(IMPORT_FAILED 가 아니라)
    const transient = isAdapterError(e) && e.code === "SOURCE_TRANSIENT";
    const code = source ? SOURCE_FAILURE[source] : transient ? "IMPORT_SOURCE_UNAVAILABLE" : permanent ? "IMPORT_SPEC_INVALID" : "IMPORT_FAILED";
    const attempts = (await failedAttempts(job, "import")) + 1;
    // PF-A8 DRAFT(ai): 감사 횟수만 보면 워커가 죽은 시도(기록 없음)만큼 모자라 pg-boss 마지막 시도에서도 다시 던졌고 → importing 에 영원히 남았다.
    //   pg-boss 가 마지막 시도라고 알려 주면(isLastAttempt) 횟수와 상관없이 failed
    if (!permanent && attempts < IMPORT_MAX_ATTEMPTS && !isLastAttempt()) {
      await recordAttemptFailure(job, "import", { attempts, max: IMPORT_MAX_ATTEMPTS, error: msg });
      throw e;   // pg-boss 재시도
    }
    const moved = await withTenant(job.tenantId, (tx) => advance(tx, { id: job.migrationId, tenantId: job.tenantId }, "importing", "failed", {
      mode: "ifStill", failureCode: code,
      audit: { actor: "worker", action: "migration.failed", target: job.migrationId, result: "error",
               detail: { requestId: job.requestId, error: msg, attempts, permanent } },
    }));
    log.info({ prev_state: "importing", state: moved ? "failed" : "importing", result: moved ? "advanced" : "skipped",
      failure_code: code, reason: scrubString(msg), attempts, permanent }, moved ? "transition" : "transition lost race");
    return moved ? "advanced" : "skipped";
  }
}

async function importOnce(job: MigrationJob): Promise<boolean> {
  // ① 재확인: DB에서 다시 읽는다 (회사 벽 안에서)
  const row = await withTenant(job.tenantId, async (tx) => {
    const m = await tx.query(
      `SELECT m.status, m.source_env_id, m.source_scope, e.provider, e.connection_status, e.account_id, e.region FROM migrations m
         JOIN environments e ON e.id = m.source_env_id WHERE m.id=$1`, [job.migrationId]);
    const r = m.rows[0] as { status: string; source_env_id: string; source_scope: unknown; provider: string; connection_status: string;
      account_id: string | null; region: string | null } | undefined;
    return r && r.status === "importing" ? r : null;   // 두 번 온 작업이면 아무것도 안 함
  });
  if (!row) return false;
  // L5: 출발 환경이 연결됨(또는 불안정이지만 아직 연결)이 아니면 읽지 않는다 (빌릴 역할이 없거나 끊김). 다시 해도 같다 → 영구 실패
  // DRAFT(ai): unstable 도 허용 (주기 재확인 실패 = 일시적일 수 있음. 새 실행 거부는 guards 몫)
  if (row.connection_status !== "connected" && row.connection_status !== "unstable")
    throw new AdapterError("SOURCE_UNAVAILABLE", `출발 환경이 연결 상태가 아님 (${row.connection_status})`);

  // K-1: 이 이전의 출발 범위 (DB 에서 다시 읽은 값). 계약과 안 맞으면 다시 해도 같다 → 영구 실패
  const scope = SourceScope.safeParse(row.source_scope ?? {});
  if (!scope.success) throw new AdapterError("SOURCE_UNAVAILABLE", "이전의 출발 범위(source_scope) 모양이 계약과 안 맞음");

  // ② 바깥 호출 (트랜잭션 밖). L5: 출발 환경 관찰 역할을 빌려 읽고, 끝나면 바로 돌려준다
  // 온프레 pull 모드 출발은 빌릴 자격도 들어갈 길도 없다 → 관찰 역할 없이 Agent 인벤토리 스냅숏으로 같은 discover 를 돌린다 (_onprem-snapshot.ts)
  if (onpremPullSource(row.provider)) {
    const cli = await onpremSnapshotDeps(job.tenantId, row.source_env_id);
    return saveImport(job, await importSpec(row.provider as Provider, cli, await previousImports(job), scope.data));
  }
  const sess = await borrowObserve(job, row);
  try {
    // PREVIDS: 같은 이전의 직전 판의 ids(벤더 키 → id)를 넘겨, 다시 가져와도 같은 자원 = 같은 id. 첫 가져오기는 빈 값
    // PREVIDS2: 같은 이전의 앞 판들(가장 새 것부터)에서 id 와, 사람이 손댄 칸을 읽는다
    const cli: CliDeps = sess.session.cliEnv ? { env: observeEnv(sess.session.cliEnv) } : {};
    const imp = await importSpec(row.provider as Provider, cli, await previousImports(job), scope.data);
    return await saveImport(job, imp);
  } finally {
    await sess.release();
  }
}

// L5: 가져오기 관찰 역할 (설계 AF 7 2단계). 진짜 발급기(REAL_STS=1 + external_id)면 빌린 키를 discover 자식 CLI env 로만 넘긴다.
//   가짜 발급기(stub)면 지금처럼 프로세스 자격 (cliEnv 없음). 장부에 issued → revoked(import_done) 가 남는다
//   #241: 프로세스 자격으로 읽는 건 로컬·시험(REAL_STS=0)뿐이다. 실환경 모드의 AWS·GCP 가 stub 이면 읽지 않고 영구 실패 (워커 권한으로 플랫폼 계정을 읽게 되므로)
// DRAFT(ai): 자격 수명 1시간 (요청 상한 3600). import 는 재발급 고리(_roles.ts)에 없고, 복사한 cliEnv 는 재발급돼도 안 바뀐다
export const IMPORT_OBSERVE_TTL_SEC = 3600;
// DRAFT(ai): discover 가 실제로 부르는 읽기 동작 (discover/index.ts aws 쪽 명령과 같은 목록)
// N8: rds:DescribeDBParameters = 사용자 파라미터 그룹 값 (TLS 강제·파라미터 그대로 옮기기)
export const IMPORT_OBSERVE_ACTIONS = ["sts:GetCallerIdentity", "eks:ListClusters", "eks:DescribeCluster", "rds:DescribeDBInstances", "rds:DescribeDBParameters",
  "ec2:DescribeVpcs", "elasticloadbalancing:DescribeLoadBalancers", "ecr:DescribeRepositories", "secretsmanager:ListSecrets"];
// OBSROLE/OBSROLE2: 장부에 남기는 "이 가져오기가 부르는 읽기 동작" 목록. 표 원본 = adapters common/observe-permissions.ts (고객 관찰 역할 템플릿·연결 스크립트도 같은 표)
//   AWS: 기본 목록 + 데이터 자원(S3·SQS·ElastiCache) 읽기 + ECS·ALB 규칙·Auto Scaling 읽기 + EC2. IMPORT_AWS_IAM=0 이 아니면(ID-5 기본 켬) 앱 신원 IAM 읽기(파드 신원 2 + IAM 5)까지
//   GCP: discover gcp 가 부르는 명령 + 데이터 자원 읽기 + GCE + Cloud Run
const IMPORT_AWS_IAM_KEYS = ["eks list-pod-identity-associations", "eks describe-pod-identity-association", "iam list-attached-role-policies",
  "iam get-policy", "iam get-policy-version", "iam list-role-policies", "iam get-role-policy"] as const;
export const IMPORT_GCP_OBSERVE_ACTIONS = actionsOfCommands("gcp", ["projects describe", "container clusters list", "container clusters get-credentials", "sql instances list",
  "compute networks list", "compute forwarding-rules list", "artifacts repositories list", "secrets list"]);
export const importObserveActions = (provider = "aws"): string[] => {
  if (provider === "gcp") {
    // VMIMPORT: GCE 읽기 + CRIMPORT: Cloud Run 서비스·잡 읽기(adapters import/readers/gcp-cloudrun.ts). 겹치는 권한은 한 번만
    // WI-1 DRAFT(ai): 앱 신원 권한 읽기(프로젝트 IAM 정책)도 같은 깃발(IMPORT_AWS_IAM, 기본 켬)을 따른다
    const iam = process.env.IMPORT_AWS_IAM !== "0" ? actionsOfCommands("gcp", ["projects get-iam-policy"]) : [];
    const base = [...IMPORT_GCP_OBSERVE_ACTIONS, ...GCP_DATA_READ_PERMISSIONS, ...GCP_NET_READ_PERMISSIONS, ...iam.filter((a) => !IMPORT_GCP_OBSERVE_ACTIONS.includes(a))];
    return [...base, ...[...GCE_OBSERVE_PERMISSIONS, ...CLOUDRUN_OBSERVE_PERMISSIONS].filter((a, i, all) => !base.includes(a) && all.indexOf(a) === i)];
  }
  return [...IMPORT_OBSERVE_ACTIONS, ...AWS_DATA_READ_ACTIONS, ...AWS_NET_READ_ACTIONS, ...ECS_OBSERVE_ACTIONS, ...EC2_OBSERVE_ACTIONS.filter((a) => !IMPORT_OBSERVE_ACTIONS.includes(a)), ...(process.env.IMPORT_AWS_IAM !== "0" ? actionsOfCommands("aws", IMPORT_AWS_IAM_KEYS) : [])];
};
async function borrowObserve(job: MigrationJob, row: { source_env_id: string; provider: string; account_id: string | null; region: string | null }) {
  const roles = tempRoles();
  const release = (credentialRef: string) => roles.revoke(credentialRef, job.tenantId, "import_done").then(() => undefined, (e) => console.error("import revoke", scrubString((e as Error).message)));
  let ref: string;
  let session: ObserveSession;
  try {
    const cred = await roles.issue({ tenantId: job.tenantId, envId: row.source_env_id, provider: row.provider as Provider,
      purpose: "observe", migrationId: job.migrationId, actions: importObserveActions(row.provider), ttlSec: IMPORT_OBSERVE_TTL_SEC }, { step: "import" });
    ref = cred.credentialRef;
    if (refuseMockCredentials(cred, row.provider)) {
      await release(ref);
      throw new AdapterError("SOURCE_UNAVAILABLE", `출발 관찰 역할이 가짜 자격 (${MOCK_CREDENTIALS}) — 콘솔 연결 링크로 만든 환경인지 확인`);
    }
    session = { accountId: row.account_id ?? "dev", expiresAt: cred.expiresAt, ...(row.region ? { region: row.region } : {}) };
    if (!cred.stub) {
      const k = roles.use(ref, job.tenantId, job.migrationId);
      // DRAFT(ai): 환경에 리전이 없으면 서울 (issuers.ts AWS_DEFAULT_REGION 과 같음)
      if (k.kind === "aws") session.cliEnv = { AWS_ACCESS_KEY_ID: k.accessKeyId, AWS_SECRET_ACCESS_KEY: k.secretAccessKey,
        AWS_SESSION_TOKEN: k.sessionToken, AWS_REGION: row.region || "ap-northeast-2" };
      // #241: GCP 빌린 토큰도 자식 CLI 로 넘긴다. 안 넘기면 고객 환경을 워커 자기 계정으로 읽는다. GCP_PROJECT 까지 덮는 건 discover(gcpProject)가 이 값을 먼저 보기 때문
      else if (k.kind === "bearer" && row.provider === "gcp" && row.account_id) session.cliEnv = { CLOUDSDK_AUTH_ACCESS_TOKEN: k.token,
        CLOUDSDK_CORE_PROJECT: row.account_id, GCP_PROJECT: row.account_id };
      // 빌렸는데 넘길 수 없으면 프로세스 자격으로 흘러가지 않게 멈춘다
      else {
        await release(ref);
        throw new AdapterError("SOURCE_UNAVAILABLE", `출발 관찰 역할 자격을 CLI 에 넘길 수 없음 (${row.provider}/${k.kind})`);
      }
    }
  } catch (e) {
    // 역할을 못 빌림(거부·없음) = 사람이 연결을 고쳐야 함 → 영구 실패. 그 밖(네트워크·명령 없음)은 재시도
    if (e instanceof TempRoleDenied) throw new AdapterError("SOURCE_UNAVAILABLE", `출발 관찰 역할을 못 빌림 (${e.code})`);
    if (e instanceof StsCliError && e.awsCode) throw new AdapterError("SOURCE_UNAVAILABLE", `출발 관찰 역할을 못 빌림 (${e.awsCode})`);
    throw e;
  }
  return {
    session,
    release: () => release(ref),
  };
}

// PREVIDS/PREVIDS2: 이 이전(migration)의 spec_v2 판들을 가장 새 것부터 읽는다. 작업 내용은 믿지 않고 DB 에서(회사 벽 안에서) 읽는다.
//   범위 = 같은 migration 한 개. 다른 이전·다른 회사의 판은 안 읽는다(RLS + migration_id 조건). 앞 판이 없거나 모양이 틀리면(손상) 그 판은 건너뜀 = 새 id·새 값
//   ids = 가장 새 판의 ids (PREVIDS). history = 사람이 손댄 칸 유지에 쓸 {spec, fieldMeta} 들 (PREVIDS2, carryHumanEdits)
//   included = 가장 새 판에서 사람이 경계 밖에서 끌어온 자원 이름 (BOUNDPULL): 재가져오기 때도 경계 안 유지
interface PreviousImports { ids: Record<string, string>; history: PrevSpecV2[]; included?: string[]; app?: { name: string; meta?: ImportResultV2["fieldMeta"][string] } }
async function previousImports(job: MigrationJob): Promise<PreviousImports> {
  const r = await withTenant(job.tenantId, (tx) => tx.query(
    `SELECT spec_v2 FROM spec_versions WHERE migration_id=$1 AND spec_v2 IS NOT NULL ORDER BY version DESC LIMIT 20`, [job.migrationId]));
  const history: PrevSpecV2[] = [];
  let ids: Record<string, string> = {}, included: string[] | undefined, app: PreviousImports["app"];
  for (const [i, row] of r.rows.entries()) {
    const spec = ImportResultV2.shape.spec.safeParse(row.spec_v2?.spec), fieldMeta = ImportResultV2.shape.fieldMeta.safeParse(row.spec_v2?.fieldMeta);
    const fresh = ImportResultV2.shape.fresh.safeParse(row.spec_v2?.fresh);   // G3b-1: 그 판의 새로 읽은 links·entry·posture (없으면 옛 판)
    if (spec.success && fieldMeta.success) history.push({ spec: spec.data, fieldMeta: fieldMeta.data, ...(fresh.success && fresh.data ? { fresh: fresh.data } : {}) });
    if (i === 0) {
      const p = ImportResultV2.shape.ids.safeParse(row.spec_v2?.ids); if (p.success) ids = p.data;
      const inc = ImportResultV2.shape.included.safeParse(row.spec_v2?.included); if (inc.success) included = inc.data;
      // G3b-5: 앞 판 앱 이름 (사람이 고쳤는지도). 다시 가져와도 이름·도착 네임스페이스가 안 바뀌게
      if (spec.success) app = { name: spec.data.app.name, ...(fieldMeta.success && fieldMeta.data["app.name"] ? { meta: fieldMeta.data["app.name"] } : {}) };
    }
  }
  return { ids, history, ...(included?.length ? { included } : {}), ...(app ? { app } : {}) };
}

async function saveImport(job: MigrationJob, imp: SpecImport): Promise<boolean> {
  // ③ 저장 + 상태 한 칸. 행을 먼저 잠그고 상태를 다시 본다 (② 동안 취소·두 번째 작업이 지나갔을 수 있다)
  return withTenant(job.tenantId, async (tx) => {
    const now = await tx.query("SELECT status FROM migrations WHERE id=$1 FOR UPDATE", [job.migrationId]);
    if (now.rows[0]?.status !== "importing") return false;
    const accuracy = await accuracyOf(tx, job, imp.inv, imp.result);
    // DRAFT(ai): 옛 칸 spec·field_meta 는 남기되 안 쓴다 (spec = {}, field_meta = 초안 표시 자리 {})
    await tx.query(
      `INSERT INTO spec_versions (tenant_id, migration_id, version, spec, field_meta, spec_v2)
       VALUES ($1,$2,(SELECT COALESCE(max(version),0)+1 FROM spec_versions WHERE migration_id=$2),'{}','{}',$3)`, [job.tenantId, job.migrationId, imp.result]);
    return advance(tx, { id: job.migrationId, tenantId: job.tenantId }, "importing", "spec_review", {
      mode: "ifStill",
      // Z88: 읽은 출발 자원 목록(종류·이름·버전만, 환경변수는 이름만)을 감사에 남긴다 → provisioning(Z89)이 "이미 있음" 판단에 쓴다
      audit: { actor: "worker", action: "migration.spec_review", target: job.migrationId, result: "ok",
               detail: { sourceInventory: inventoryForAudit(imp.inv), ...(imp.note ? { note: imp.note } : {}), ...(imp.carry ? { carry: imp.carry } : {}), ...(accuracy ? { accuracy } : {}) } },
    });
  });
}

// ALIGN-v2 IR-10: 가져오기 정확도 %. 도착 환경 종류로 Helm 값을 렌더해 원본과 맞춰 본다 (순수 계산, 네트워크 없음).
//   DRAFT(ai): 렌더가 거부하면(UNSUPPORTED_V2 등) 공통 명세 값과 비교(basis=spec). 숫자를 못 내도 가져오기는 막지 않는다 (null)
async function accuracyOf(tx: { query: (sql: string, p?: unknown[]) => Promise<{ rows: unknown[] }> }, job: MigrationJob, inv: RawInventory, result: ImportResultV2) {
  try {
    let rendered: { workloads?: unknown[] } | undefined;
    try {
      const t = (await tx.query(`SELECT e.id, e.provider, e.region FROM migrations m JOIN environments e ON e.id = m.target_env_id WHERE m.id=$1`, [job.migrationId])).rows[0] as
        { id: string; provider: Provider; region: string | null } | undefined;
      if (t) rendered = targetBuilderFor(t.provider).toWorkloadValues(result.spec, {}, { envId: t.id, provider: t.provider, region: t.region || "default", tenantId: job.tenantId, migrationId: job.migrationId }) as { workloads?: unknown[] };
    } catch { rendered = undefined; }
    return measureImportAccuracy({ inventory: inv, result, rendered });
  } catch (e) {
    console.error("import accuracy", scrubString((e as Error).message));
    return null;
  }
}

// I3b: 공통 명세 가져오기 (설계 24번 2장). discover → normalizeV2 → (앞 판 사람 수정 합치기) → checkV2.
//   원본에 워크로드가 하나도 없으면 SOURCE_INCOMPLETE (옮길 앱이 없다, 다시 해도 같다)
//   checkV2 errors(구조 오류)만 막는다. reviews(벤더 주소·사설 IP 남음)는 fieldMeta 검토 표시만
// 시험이 바깥 읽기(discover)를 느리게·중간 취소로 흉내 낼 수 있게 한 곳에서 부른다 (기본 = discoverForImport)
export const importDeps = { discover: discoverForImport };
type SpecImport = { inv: RawInventory; result: ImportResultV2; note?: string; carry?: { kept: string[]; flagged: string[]; dropped: string[] } };
// #241: 자식 CLI 환경. 워커 자기 AWS 자격을 지우고(envFor), GCP 토큰이면 워커 자기 gcloud 자격(서비스 계정 파일·대리 설정 등)까지 지운다(gcpEnvFor)
const observeEnv = (c: Record<string, string>): NodeJS.ProcessEnv => c.CLOUDSDK_AUTH_ACCESS_TOKEN && c.CLOUDSDK_CORE_PROJECT
  ? gcpEnvFor(c.CLOUDSDK_AUTH_ACCESS_TOKEN, c.CLOUDSDK_CORE_PROJECT, envFor(c)) : envFor(c);
// cli = discover 의 CLI 의존성 (빌린 관찰 자격 env, 또는 온프레 pull 모드의 스냅숏 재생 exec)
async function importSpec(p: Provider, cli: CliDeps, previous: PreviousImports = { ids: {}, history: [] }, scope: SourceScope = {}): Promise<SpecImport> {
  // I4: 앱 신원의 IAM 정책도 읽어 grants·기준선을 채운다.
  // ID-5 DRAFT(ai): 기본 켬 (그대로 이식: 권한 없이 옮기면 도착 앱이 403). IMPORT_AWS_IAM=0 이면 끔. 못 읽으면 unread.IAM 검토 줄
  // K-1: 출발 범위(이전마다)를 discover 에 넘긴다. 빈 칸은 워커 환경변수(개발용) → 자동 고르기 + 검토 줄
  const inv = await importDeps.discover(p, { iam: process.env.IMPORT_AWS_IAM !== "0", scope }, cli);
  if (!(inv.items as Array<{ kind?: string }>).some((i) => WORKLOAD_KINDS.has(String(i.kind))))
    throw new AdapterError("SOURCE_INCOMPLETE", "출발 환경에 옮길 워크로드(k8s·ECS·Cloud Run·VM)가 없음");
  // PARTOF: 앱 묶음 값 = 출발 범위 partOf (K-1) → IMPORT_APP(개발용). 없으면 라벨이 가장 많은 묶음 + 검토 표시
  // G3b-5: 앱 이름 = 출발 범위 appName (이전 만들 때 받은 값) · 앞 판 이름
  const fresh = normalizeV2(inv, { previousIds: previous.ids, partOf: scope.partOf ?? (process.env.IMPORT_APP?.trim() || undefined),
    ...(scope.appName ? { appName: scope.appName } : {}), ...(previous.app ? { previousApp: previous.app } : {}) });
  // BOUNDPULL: 앞 판에서 사람이 경계 밖에서 끌어온 데이터 자원은 이번에도 경계 안에 둔다 (원본에서 사라졌으면 조용히 빠짐)
  const pulled = previous.included?.length ? applyInclude(fresh.result, previous.included, { lenient: true }) : null;
  // PREVIDS2: 앞 판에서 사람이 손댄 칸 유지 (출발 값이 같으면 사람 값·표시, 달라졌으면 새 값 + 다시 검토). 첫 가져오기는 history 가 비어 그대로
  const base = pulled ? pulled.result : fresh.result;
  // G3b-1: 이 판의 새로 읽은 links·entry·posture 를 따로 남긴다 (다음 가져오기 합치기의 바탕)
  base.fresh = { links: structuredClone(base.spec.links), ...(base.spec.entry ? { entry: structuredClone(base.spec.entry) } : {}), posture: structuredClone(base.spec.posture) };
  let { result, report } = carryHumanEdits(base, previous.history);
  let checked = checkV2(result.spec);
  // PREVIDS3 DRAFT(ai): 사람 값을 합친 명세가 구조 검증(checkV2 errors)을 못 통과하면(예: 사람이 지운 링크를 가리키는 칸이 남음) 가져오기를 영구 실패로 막지 않는다.
  //   G3b-2: 통째로 버리지 않고 단위(부품 칸·links·entry·posture)를 하나씩 빼 보며 오류가 줄어드는 단위만 뺀다. 뺀 단위는 새로 읽은 값 + 다시 검토(CARRY_SKIP_NOTE)
  //   그래도 안 되면 합치기를 다 빼되, 사람 값이 있던 단위는 모두 다시 검토로 둔다 (조용히 출발 값으로 돌아가지 않게)
  let carrySkipped = false;
  const skipped = new Set<string>();
  if (checked.errors.length && (report.kept.length || report.flagged.length)) {
    for (const unit of [...report.kept, ...report.flagged].filter((u) => !u.startsWith("check.") && !u.startsWith("links."))) {
      if (!checked.errors.length) break;
      const trial = new Set([...skipped, unit]);
      const t = carryHumanEdits(base, previous.history, { skip: trial });
      const c = checkV2(t.result.spec);
      if (c.errors.length < checked.errors.length) { skipped.add(unit); result = t.result; report = t.report; checked = c; }
    }
    if (checked.errors.length) {
      const plain = checkV2(base.spec);
      if (!plain.errors.length) {
        const all = new Set([...report.kept, ...report.flagged].filter((u) => !u.startsWith("check.") && !u.startsWith("links.")));
        const t = carryHumanEdits(base, previous.history, { skip: all });
        report = { kept: [], flagged: t.report.flagged, dropped: report.dropped };
        result = t.result; checked = checkV2(t.result.spec); carrySkipped = true;
        if (checked.errors.length) { result = base; checked = plain; }
      }
    }
  }
  const { errors } = checked;
  if (errors.length) throw new AdapterError("SPEC_V2_INVALID", `공통 명세 검증 실패: ${errors.slice(0, 5).join("; ")}${errors.length > 5 ? ` 외 ${errors.length - 5}개` : ""}`);
  // DRAFT(ai): reviews 는 막지 않고 fieldMeta 에 검토 표시 (화면이 needs_review 로 센다).
  //   G3c-5: 키 = 내용 키 check.<id>.<자리>.<종류>.<값 지문> (예전 번호 키 check.reviews[i] 대신). PATCH 도 같은 함수로 다시 맞춘다
  result.fieldMeta = syncCheckReviews(result.fieldMeta, checkV2Reviews(result.spec));
  // 저장 전 모양 확인. L-1: 개수 상한 등 모양 오류는 "어느 칸이 몇 개 넘었는지"로 바꿔 영구 실패(IMPORT_SPEC_INVALID) — 값은 안 남김
  const shape = ImportResultV2.safeParse(result);
  if (!shape.success) {
    const lines = specIssueLines(shape.error.issues, result);
    throw new AdapterError("SPEC_V2_INVALID", `공통 명세 모양 검증 실패: ${lines.slice(0, 5).join("; ")}${lines.length > 5 ? ` 외 ${lines.length - 5}개` : ""}`);
  }
  const stored = shape.data;
  // PREVIDS3: 대상이 없어 못 옮긴 사람 값 개수도 note 에, 이름(값 아님)은 감사 detail.carry 에 (각 30개까지)
  const carryNote = report.kept.length || report.flagged.length || report.dropped.length
    ? (carrySkipped ? `앞 판 사람 수정 합치기가 검증을 못 통과해 건너뜀(사람 값 ${report.flagged.length}칸 새로 읽은 값 + 다시 검토)`
      : skipped.size ? `앞 판 사람 수정 유지 ${report.kept.length}칸, 다시 검토 ${report.flagged.length}칸(그중 합치면 검증을 못 넘어 뺀 ${skipped.size}칸)${report.dropped.length ? `, 대상 없어 보류 ${report.dropped.length}개` : ""}`
      : `앞 판 사람 수정 유지 ${report.kept.length}칸, 출발 값 바뀌어 다시 검토 ${report.flagged.length}칸${report.dropped.length ? `, 대상 없어 보류 ${report.dropped.length}개` : ""}`) : undefined;
  const cap = (a: string[]) => a.slice(0, 30);
  const carry = carryNote ? { kept: cap(report.kept), flagged: cap(report.flagged), dropped: cap(report.dropped) } : undefined;
  return { inv, result: stored, ...(carryNote ? { note: carryNote } : {}), ...(carry ? { carry } : {}) };
}
