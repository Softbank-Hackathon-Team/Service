import type { MigrationStatus } from "@svc/contracts";
import { withTenant, writeAudit, scrubString } from "@svc/core";
import { freezeGkeUpgrades, releaseGkeUpgrades, type CliDeps, type GkeFreezeResult, type GkeFreezeTarget } from "@svc/adapters";
import { tempRoles } from "../platform.js";
import { withStepRoles, type StepRoles } from "./_roles.js";
import type { MigrationRow } from "./_step.js";
import { TARGET_ACCOUNT_SQL } from "./target-account.js";

// 이전 중 도착 GKE 업그레이드 멈춤 (결정: 이전 중 maintenance exclusion, 끝 상태에서 풂).
//   freezeTargetGke  : 이전이 도착 자원을 만들기 시작할 때(오케스트레이터가 부름). 이미 걸려 있으면 그대로
//   releaseTargetGke : 끝 상태(completed·rolled_back·cancelled)에 들어갈 때. 없으면 그대로
//   둘 다 상태를 바꾸지 않는다(advance 없음). 결과는 감사 gke_freeze.* 한 줄.
// 자격: 도착 실행 역할 (STEP_ROLES.gke_freeze = target operate apply). 빌린 bearer 토큰만 쓴다. 가짜 발급기(stub)면 클라우드를 안 부른다(STUB)
// DRAFT(ai): 실패해도 이전을 멈추지 않는다 (안전망이라서). 감사 result=error 로 남기고 돌려준다. release 를 못 해도 제외는 끝 시각(기본 72시간)에 저절로 풀린다
// DRAFT(ai): GCP 도착이 아니거나 클러스터 이름·위치가 없으면 건너뜀 (Cloud Run·VM 도착 등)

export const FREEZE_RELEASE_ON: readonly MigrationStatus[] = ["completed", "rolled_back", "cancelled"];

export type GkeFreezeOutcome =
  | GkeFreezeResult
  | { skipped: "not_gcp" | "no_cluster" | "no_location" | "stub" | "no_credential" | "env_not_found" }
  | { error: string };

export interface GkeFreezeDeps {
  cli?: CliDeps;
  now?: () => Date;
  /** 시험용: 역할 빌리기 대신 이 토큰 (빈 문자열 = stub) */
  token?: string;
}

interface TargetRow { provider: string; project: string | null; cluster: string | null; location: string | null }

async function loadTarget(tenantId: string, m: MigrationRow): Promise<TargetRow | null> {
  return withTenant(tenantId, async (tx) => {
    const q = await tx.query(
      `SELECT provider, ${TARGET_ACCOUNT_SQL} AS project, cluster_name AS cluster, region AS location FROM environments WHERE id = $1`, [m.targetEnvId]);
    return (q.rows[0] as TargetRow | undefined) ?? null;
  });
}

function bearerOf(r: StepRoles, j: { tenantId: string; migrationId: string }): string | null {
  const i = r.creds.findIndex((c, n) => c.provider === "gcp" && r.sides?.[n] === "target");
  const c = i >= 0 ? r.creds[i] : undefined;
  if (!c) return null;
  if (c.stub) return "";
  const k = tempRoles().use(c.credentialRef, j.tenantId, j.migrationId);
  return k.kind === "bearer" ? k.token : null;
}

async function run(kind: "freeze" | "release", j: { tenantId: string; migrationId: string }, m: MigrationRow, reason: string,
  deps: GkeFreezeDeps): Promise<GkeFreezeOutcome> {
  const t = await loadTarget(j.tenantId, m);
  let out: GkeFreezeOutcome;
  if (!t) out = { skipped: "env_not_found" };
  else if (t.provider !== "gcp") out = { skipped: "not_gcp" };
  else if (!t.cluster) out = { skipped: "no_cluster" };
  else if (!t.location || t.location === "default") out = { skipped: "no_location" };
  else {
    const go = async (token: string | null): Promise<GkeFreezeOutcome> => {
      if (token === null) return { skipped: "no_credential" };
      if (token === "") return { skipped: "stub" };   // STUB: 가짜 발급기 → 클라우드 호출 없음
      const target: GkeFreezeTarget = { projectId: t.project!, location: t.location!, cluster: t.cluster!, migrationId: j.migrationId, token };
      try {
        return kind === "freeze" ? await freezeGkeUpgrades(deps.cli ?? {}, target, (deps.now ?? (() => new Date()))())
          : await releaseGkeUpgrades(deps.cli ?? {}, target);
      } catch (e) { return { error: scrubString((e as Error).message).slice(0, 300) }; }
    };
    out = deps.token !== undefined ? await go(deps.token) : await withStepRoles("gke_freeze", j, m, async (r) => go(bearerOf(r, j)));
  }
  if (!("skipped" in out && (out.skipped === "not_gcp" || out.skipped === "env_not_found"))) {
    await withTenant(j.tenantId, (tx) => writeAudit(tx, j.tenantId, {
      actor: "worker", action: `gke_freeze.${kind}`, target: j.migrationId, result: "error" in out ? "error" : "ok",
      detail: { reason, ...out } }));
  }
  return out;
}

/** 이전 중 도착 GKE 업그레이드 멈춤을 건다 (멱등) */
export function freezeTargetGke(j: { tenantId: string; migrationId: string }, m: MigrationRow, deps: GkeFreezeDeps = {}) {
  return run("freeze", j, m, "migration_started", deps);
}

/** 끝 상태에서 푼다 (멱등). to 가 끝 상태가 아니면 아무것도 안 함 */
export async function releaseTargetGke(j: { tenantId: string; migrationId: string }, m: MigrationRow, to: MigrationStatus,
  deps: GkeFreezeDeps = {}): Promise<GkeFreezeOutcome | null> {
  if (!FREEZE_RELEASE_ON.includes(to)) return null;
  return run("release", j, m, to, deps);
}
