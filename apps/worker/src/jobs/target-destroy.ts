import { dropRuntimeLinkSecret } from "../app-link.js";
import { MigrationJob, QUEUES, redactText, type MigrationStatus } from "@svc/contracts";
import { boss, withTenant, writeAudit } from "@svc/core";
import { createRealTerraformRunner, envFor, gcpTerraformEnv, iacMockEnabled, readImported, workRootOf, type GcpTerraformCred, type RealTerraformRunner } from "@svc/adapters";
import { withGcpCred } from "../gcp-token-server.js";
import { readMigration, type MigrationRow } from "./_step.js";
import { withStepRoles } from "./_roles.js";
import { tenantSlug } from "../gitops/bundle.js";

// G5-1: 이전이 도착에 만든 자원 지우기. advance 가 rolled_back 으로 옮기는 트랜잭션에 넣는다 (core advance.ts 5-2 tearsDownTarget).
// DECISION(team): 실패 → AI 원인 분석 → failed, 도착 자원이 일부 만들어졌으면 사람 확인 없이 자동으로 지우고 끝 (Jeong 11/3 20:02Z, ADR-066)
//   위 결정은 11/4 01:53Z 결정(ADR-066 개정)으로 바뀌었다: failed 는 사람에게 재시도·거절을 묻고, 거절(롤백)로 rolled_back 이 될 때 지운다
// 지우는 범위 = 이 이전의 terraform 작업 폴더 state 에 있는 것만 (apply 실행기와 같은 폴더 규칙 findWorkDir). 고객 원래 자원은 state 에 없다.
//   가져오기가 찾은 기존 도착 자원(imported.json)은 우리가 만든 것이 아니라 지우지 않는다.
// 상태는 바꾸지 않는다(끝 상태 그대로, advance 없음). 결과는 감사 target_teardown.done(ok) / target_teardown.failed(error).
// 자격: 도착 destroy 실행 역할 (STEP_ROLES.rollback = target operate destroy). 진짜 AWS 자격이면 terraform env 에 그것만 넘긴다.
// DRAFT(ai): 환경 잠금은 쥐지 않는다. provisioning 실패는 잠금을 풀고, 다른 이전은 다른 작업 폴더(state)를 쓰므로 겹치지 않는다.
//   같은 이전의 provisioning 재시도는 지우기가 끝날 때까지 409 TEARDOWN_PENDING (api control.ts failure-decision).
// 실패하면 늦춰 다시 넣는다(teardownRetrySec, PF FM-ORC-12). 다 쓰면 감사 gave_up + 작업 폴더 경로 → 사람이 npm run tf:real -- destroy <이전 id>
export const TEARDOWN_FROM: readonly MigrationStatus[] = ["failed", "cancelled", "rolled_back"];   // 지우기 전에 취소해도 지운다. PF FM-ORC-08: 롤백으로 끝나도

export type TargetDestroyOutcome = "destroyed" | "nothing" | "missing" | "blocked" | "skipped" | "stub" | "retrying" | "gave_up";

// PF FM-ORC-12·25: 예전 재시도는 pg-boss 2번×60초(약 2분)뿐이라, 멈추는 apply 가 정지 유예(20분) 동안 state 잠금을 쥐고 있으면
//   STATE_LOCKED 로 몇 분 만에 포기 → 그 뒤 apply 가 끝낸 자원은 아무도 안 지웠다. 이제 처리기가 직접 늦춰 다시 넣는다(같은 작업 키).
//   DRAFT(ai): 기본 1·2·5·10·20·20·20분(합 78분 > terraform 작업 예산 45분 + 정지 유예 20분). TEARDOWN_RETRY_SEC="60,120,…" 로 바꿈.
//   다 쓰면 감사 target_teardown.gave_up(error) + 손 명령. 기다리는 동안은 재시도가 409 TEARDOWN_PENDING (예약 작업도 셈)
export function teardownRetrySec(env: NodeJS.ProcessEnv = process.env): number[] {
  const raw = env.TEARDOWN_RETRY_SEC?.split(",").map((x) => Number(x.trim())).filter((n) => Number.isFinite(n) && n >= 0);
  return raw && raw.length ? raw : [60, 120, 300, 600, 1200, 1200, 1200];
}

// PF FM-ORC-P01: terraform destroy 실패 갈래 (로그 글자로). DB 삭제 보호는 계획 때 DB_DISPOSABLE=1 이 없으면 켜진다 (adapters target aws·gcp deletion_protection)
export function destroyFailureCause(log: readonly string[]): string {
  const t = log.join("\n");
  if (/deletion.?protection|protected DB instance|Cannot delete protected/i.test(t)) return "DELETION_PROTECTED";
  if (/state lock|Error acquiring the state lock|ConditionalCheckFailed/i.test(t)) return "STATE_LOCKED";
  if (/AccessDenied|UnauthorizedOperation|PERMISSION_DENIED|Permission .* denied|403/i.test(t)) return "ACCESS_DENIED";
  if (/ENOENT|executable file not found|command not found/i.test(t)) return "TF_BIN_MISSING";
  return "TF_DESTROY_FAILED";
}
const CAUSE_HINT: Record<string, string> = {
  DELETION_PROTECTED: "DB 삭제 보호가 켜진 채 만들어짐(계획 때 DB_DISPOSABLE=1 없음). 콘솔·CLI 로 보호를 끈 뒤 npm run tf:real -- destroy <이전 id>",
  STATE_LOCKED: "같은 작업 폴더에 다른 terraform(예: demo-day down) 이 도는 중. 끝나면 pg-boss 재시도가 이어서 지운다",
  ACCESS_DENIED: "도착 destroy 실행 역할 권한 부족(infra/permissions destroy 정책). 권한을 고친 뒤 npm run tf:real -- destroy <이전 id>",
};
export interface TargetDestroyDeps {
  env?: NodeJS.ProcessEnv;
  /** 시험용. 없으면 진짜 실행기 (빌린 자격 env 로) */
  runner?: Pick<RealTerraformRunner, "destroy">;
  /** 시험용: 역할 빌리기 건너뛰기 */
  noRoles?: boolean;
  /** 시험용: 늦춰 다시 넣기 (없으면 pg-boss send startAfter) */
  requeue?: (j: MigrationJob, delaySec: number) => Promise<unknown>;
}

export async function handleTargetDestroy(raw: unknown, d: TargetDestroyDeps = {}): Promise<TargetDestroyOutcome> {
  const j = MigrationJob.parse(raw);
  const env = d.env ?? process.env;
  // 작업 내용은 믿지 않는다: 상태·도착 환경은 DB 에서 다시 읽는다
  const row = await withTenant(j.tenantId, async (tx) => {
    const m = await readMigration(tx, j.migrationId);
    if (!m) return null;
    const p = await tx.query<{ provider: string }>(`SELECT provider FROM environments WHERE id = $1`, [m.targetEnvId]);
    return { m, provider: p.rows[0]?.provider ?? null };
  });
  if (!row || !TEARDOWN_FROM.includes(row.m.status)) {
    await audit(j, "target_teardown.skipped", "ok", { status: row?.m.status ?? null, reason: "not failed/cancelled (다시 계획·롤백 중이면 그쪽이 자원을 쓴다)" });
    return "skipped";
  }
  const { m, provider } = row;
  // 흉내 (MOCK_IAC=1 시험·smoke, Azure Mock): 진짜 자원이 없다
  if (!d.runner && (iacMockEnabled(env) || provider === "azure_mock")) {
    await audit(j, "target_teardown.done", "ok", { provider, stub: true, iac: provider === "azure_mock" ? "azure_mock" : "mock" });
    return "stub";
  }
  if (readImported(workRootOf(env), j.migrationId, tenantSlug(j.tenantId))) {
    await audit(j, "target_teardown.done", "ok", { provider, imported: true, note: "가져온 기존 자원은 지우지 않음" });
    return "nothing";
  }
  const run = async (credEnv?: Record<string, string>, gcpCred?: GcpTerraformCred) => {
    const runner = d.runner ?? createRealTerraformRunner({ env: gcpCred ? gcpTerraformEnv(gcpCred, env) : credEnv ? envFor(credEnv, env) : env });
    return runner.destroy(j.migrationId);
  };
  let r: Awaited<ReturnType<typeof run>>;
  try {
    r = d.noRoles || d.runner
      ? await run()
      : await withStepRoles("rollback", j, m as MigrationRow, (roles) => withGcpCred(roles, undefined, (gcpCred) => run(roles.awsEnv?.target, gcpCred)));
  } catch (e) {
    // PF FM-ORC-07: 역할 빌리기 거부·terraform 없음(spawn ENOENT) 같은 예외도 감사에 남긴다 (예전엔 pg-boss 실패로만 사라짐)
    await audit(j, "target_teardown.failed", "error", { provider, error: redactText((e as Error)?.message ?? String(e)).slice(0, 300),   // RV-16: 자르기 전에 가림 (자른 끝이 ARN·URL 가운데면 규칙이 안 맞음)
      hint: `npm run tf:real -- destroy ${j.migrationId}` });
    return retryLater(j, d, env, "EXCEPTION");
  }
  const base = { provider, workDir: r.workDir, elapsedMs: r.elapsedMs, steps: r.steps.map((s) => `${s.step}:${s.code}`) };
  if ("skipped" in r && r.skipped) {
    // 작업 폴더 없음 = terraform 이 시작도 안 했다(재확인 실패·사실 모자람) 또는 실행기의 실패 즉시 destroy 가 이미 지움.
    // PF FM-OPS-05: 단, apply 가 작업 폴더를 남겼다고 적었는데 지금 못 찾으면(워커의 TF_WORK_DIR·HOME 이 apply 때와 다름) "지울 것 없음"이 아니다
    //   → 감사 error + 그 경로. 다시 해도 같은 폴더를 못 찾으니 재시도하지 않는다 (사람이 그 폴더에서 tf:real destroy)
    const recorded = await recordedWorkDir(j);
    if (recorded) {
      await audit(j, "target_teardown.failed", "error", { ...base, recordedWorkDir: recorded, error: "work dir recorded by apply not found (TF_WORK_DIR changed?)",
        hint: `TF_WORK_DIR=<apply 때 뿌리> npm run tf:real -- destroy ${j.migrationId}` });
      return "missing";
    }
    await audit(j, "target_teardown.done", "ok", { ...base, nothing: r.skipped });
    return "nothing";
  }
  if (!r.ok) {
    // PF FM-ORC-P01: 실패 원인을 갈래로 남긴다 (예전엔 단계 코드만 → 왜 못 지웠는지 맥 로그를 뒤져야 했다). 꼬리 5줄은 감사가 주소·계정을 가린다
    const cause = destroyFailureCause(r.log);
    const tailLines = r.log.slice(-5).map((l) => redactText(l).slice(0, 200));   // RV-16
    await audit(j, "target_teardown.failed", "error", { ...base, cause, tail: tailLines, hint: CAUSE_HINT[cause] ?? `npm run tf:real -- destroy ${j.migrationId}` });
    // 삭제 보호는 다시 해도 똑같이 막힌다 → 재시도 안 함 (사람이 보호를 끄고 tf:real destroy)
    if (cause === "DELETION_PROTECTED") return "blocked";
    return retryLater(j, d, env, cause);
  }
  // APP-22 (가): Terraform 밖에서 만든 출발 전용 계정 비밀 그릇도 지운다 (state 에 없어 destroy 가 안 지움)
  const linkSecret = d.runner ? { skipped: "test_runner" } : await dropRuntimeLinkSecret(j, m as MigrationRow, env);
  await audit(j, "target_teardown.done", "ok", { ...base, ...(linkSecret.skipped ? {} : { linkSecret }) });
  return "destroyed";
}

// 지우기 요청(target_teardown.requested) 뒤 실패 횟수만큼 늦춰 같은 작업 키로 다시 넣는다. 다 쓰면 gave_up
async function retryLater(j: MigrationJob, d: TargetDestroyDeps, env: NodeJS.ProcessEnv, cause: string): Promise<TargetDestroyOutcome> {
  const delays = teardownRetrySec(env);
  const n = await withTenant(j.tenantId, async (tx) => Number((await tx.query<{ n: string }>(
    `SELECT count(*) AS n FROM audit_events WHERE target = $1 AND action = 'target_teardown.failed'
       AND seq > COALESCE((SELECT max(seq) FROM audit_events WHERE target = $1 AND action = 'target_teardown.requested'), 0)`,
    [j.migrationId])).rows[0]?.n ?? 0));
  if (n > delays.length) {
    await audit(j, "target_teardown.gave_up", "error", { cause, attempts: n,
      hint: `자동 지우기 포기. 원인을 고친 뒤 npm run tf:real -- destroy ${j.migrationId} (작업 폴더 state 기준)` });
    return "gave_up";
  }
  const delaySec = delays[Math.max(0, n - 1)] ?? 60;
  const send = d.requeue ?? ((job: MigrationJob, sec: number) => boss.send(QUEUES.targetDestroy,
    { tenantId: job.tenantId, requestId: job.requestId, migrationId: job.migrationId },
    { singletonKey: `${QUEUES.targetDestroy}:${job.migrationId}`, startAfter: sec }));
  await send(j, delaySec);
  await audit(j, "target_teardown.retry_scheduled", "ok", { cause, attempt: n, of: delays.length, inSec: delaySec });
  return "retrying";
}

// apply 실패 감사(apply.failed detail.workDir, apply-real runDetail)가 적은 작업 폴더
async function recordedWorkDir(j: MigrationJob): Promise<string | null> {
  return withTenant(j.tenantId, async (tx) => (await tx.query<{ w: string | null }>(
    `SELECT detail->>'workDir' AS w FROM audit_events WHERE target = $1 AND action LIKE 'apply.%' AND detail ? 'workDir'
      ORDER BY seq DESC LIMIT 1`, [j.migrationId])).rows[0]?.w ?? null);
}

async function audit(j: MigrationJob, action: string, result: "ok" | "error", detail: Record<string, unknown>) {
  await withTenant(j.tenantId, (tx) => writeAudit(tx, j.tenantId, { actor: "worker", action, target: j.migrationId, result,
    detail: { requestId: j.requestId, mode: "auto", ...detail } }));
}
