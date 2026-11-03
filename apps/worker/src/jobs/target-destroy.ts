import { MigrationJob, type MigrationStatus } from "@svc/contracts";
import { withTenant, writeAudit } from "@svc/core";
import { createRealTerraformRunner, envFor, iacMockEnabled, readImported, workRootOf, type RealTerraformRunner } from "@svc/adapters";
import { readMigration, type MigrationRow } from "./_step.js";
import { withStepRoles } from "./_roles.js";
import { tenantSlug } from "../gitops/bundle.js";

// G5-1: 실패한 이전이 도착에 만든 자원 지우기. advance 가 provisioning → failed 와 같은 트랜잭션에 넣는다 (core advance.ts 5-2).
// DECISION(team): 실패 → AI 원인 분석 → failed, 도착 자원이 일부 만들어졌으면 사람 확인 없이 자동으로 지우고 끝 (Jeong 11/3 20:02Z, ADR-066)
// 지우는 범위 = 이 이전의 terraform 작업 폴더 state 에 있는 것만 (apply 실행기와 같은 폴더 규칙 findWorkDir). 고객 원래 자원은 state 에 없다.
//   가져오기가 찾은 기존 도착 자원(imported.json)은 우리가 만든 것이 아니라 지우지 않는다.
// 상태는 바꾸지 않는다(failed 그대로, advance 없음). 결과는 감사 target_teardown.done(ok) / target_teardown.failed(error).
// 자격: 도착 destroy 실행 역할 (STEP_ROLES.rollback = target operate destroy). 진짜 AWS 자격이면 terraform env 에 그것만 넘긴다.
// DRAFT(ai): 환경 잠금은 쥐지 않는다. provisioning 실패는 잠금을 풀고, 다른 이전은 다른 작업 폴더(state)를 쓰므로 겹치지 않는다.
//   같은 이전의 다시 계획은 지우기가 끝날 때까지 409 TEARDOWN_PENDING (api plans.ts).
// 실패하면 pg-boss 가 2번 더(1분 뒤). 그래도 안 되면 감사 error + 작업 폴더 경로 → 사람이 npm run tf:real -- destroy <이전 id>
export const TEARDOWN_FROM: readonly MigrationStatus[] = ["failed", "cancelled"];   // 지우기 전에 취소해도 지운다

export type TargetDestroyOutcome = "destroyed" | "nothing" | "skipped" | "stub";
export interface TargetDestroyDeps {
  env?: NodeJS.ProcessEnv;
  /** 시험용. 없으면 진짜 실행기 (빌린 자격 env 로) */
  runner?: Pick<RealTerraformRunner, "destroy">;
  /** 시험용: 역할 빌리기 건너뛰기 */
  noRoles?: boolean;
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
  const run = async (credEnv?: Record<string, string>) => {
    const runner = d.runner ?? createRealTerraformRunner({ env: credEnv ? envFor(credEnv, env) : env });
    return runner.destroy(j.migrationId);
  };
  const r = d.noRoles || d.runner
    ? await run()
    : await withStepRoles("rollback", j, m as MigrationRow, (roles) => run(roles.awsEnv?.target));
  const base = { provider, workDir: r.workDir, elapsedMs: r.elapsedMs, steps: r.steps.map((s) => `${s.step}:${s.code}`) };
  if ("skipped" in r && r.skipped) {
    // 작업 폴더 없음 = terraform 이 시작도 안 했다(재확인 실패·사실 모자람) 또는 실행기의 실패 즉시 destroy 가 이미 지움
    await audit(j, "target_teardown.done", "ok", { ...base, nothing: r.skipped });
    return "nothing";
  }
  if (!r.ok) {
    // 로그 꼬리는 남기지 않는다(자원 이름은 되지만 오류 원문에 주소가 섞일 수 있어 단계 코드만). 던져서 pg-boss 재시도
    await audit(j, "target_teardown.failed", "error", { ...base, hint: `npm run tf:real -- destroy ${j.migrationId}` });
    throw new Error(`terraform destroy failed for ${j.migrationId} (${base.steps.join(", ")})`);
  }
  await audit(j, "target_teardown.done", "ok", base);
  return "destroyed";
}

async function audit(j: MigrationJob, action: string, result: "ok" | "error", detail: Record<string, unknown>) {
  await withTenant(j.tenantId, (tx) => writeAudit(tx, j.tenantId, { actor: "worker", action, target: j.migrationId, result,
    detail: { requestId: j.requestId, mode: "auto", ...detail } }));
}
