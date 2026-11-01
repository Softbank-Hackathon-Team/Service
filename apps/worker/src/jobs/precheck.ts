import { randomUUID } from "node:crypto";
import { MigrationJob, PrecheckItem, QUEUES } from "@svc/contracts";
import { withTenant } from "@svc/core";
import { runCloudPrecheck, toPrecheckItems, spawnExec, type PrecheckEnvInfo, type PrecheckInput, type PrecheckDeps, type CloudProvider } from "@svc/adapters";
import { endpointFromEnv, withClient } from "@svc/replication";
import { runStep } from "./_step.js";
import { withStepRoles } from "./_roles.js";
import type { MigrationRow } from "./_step.js";

// 사전 점검: 이전해도 되는지 본다. block(FAIL)이 하나라도 있으면 명세 검토로 되돌린다
// Z97: STUB(고정 "확인됨")을 실조회로 바꿨다 — 자격(STS·tokeninfo·kubectl)·도착 API·결제·할당량·DB 버전·TCP·디스크.
//   규칙·명령은 @svc/adapters precheck/cloud-precheck.ts 한 곳. 흉내는 MOCK_PRECHECK=1 (시험 전용)일 때만

/** 시험 고정값 (계획서 시험 등에서 쓰는 모양 견본). 실제 단계는 쓰지 않는다 */
export function stubPrecheck(): PrecheckItem[] {
  return [
    { id: "PC-CRED-S", level: "info", message: "PASS 출발 자격 증명 — MOCK_PRECHECK=1 — 시험용 흉내 (실조회 안 함)" },
    { id: "PC-CRED-T", level: "info", message: "PASS 도착 자격 증명 — MOCK_PRECHECK=1 — 시험용 흉내 (실조회 안 함)" },
  ].map((i) => PrecheckItem.parse(i));
}

async function envInfo(tenantId: string, m: MigrationRow): Promise<{ source: PrecheckEnvInfo; target: PrecheckEnvInfo }> {
  return withTenant(tenantId, async (tx) => {
    const q = await tx.query(`SELECT id, provider, name, account_id, external_id FROM environments WHERE id = ANY($1::uuid[])`, [[m.sourceEnvId, m.targetEnvId]]);
    const by = new Map(q.rows.map((r) => [r.id as string, r]));
    const one = (id: string, side: "source" | "target"): PrecheckEnvInfo => {
      const r = by.get(id);
      return { side, provider: (r?.provider ?? "onprem") as CloudProvider, name: r?.name, accountId: r?.account_id ?? null, externalId: r?.external_id ?? null };
    };
    return { source: one(m.sourceEnvId, "source"), target: one(m.targetEnvId, "target") };
  });
}

/** 출발 DB 버전·크기·주소. REPL_SOURCE_URL 이 없으면 모름(null) → 점검이 WARN 으로 말한다 */
export async function sourceDbFacts(env: NodeJS.ProcessEnv = process.env): Promise<Pick<PrecheckInput, "sourcePgMajor" | "sourceDbBytes" | "endpoints">> {
  const endpoints: NonNullable<PrecheckInput["endpoints"]> = [];
  for (const [p, name] of [["REPL_SOURCE", "출발 DB"], ["REPL_TARGET", "도착 DB"]] as const) {
    const url = env[`${p}_URL`];
    if (!url) continue;
    try { const u = new URL(url); endpoints.push({ name, host: u.hostname, port: Number(u.port || 5432) }); } catch { /* 주소 모양이 틀리면 TCP 대상에서 뺀다 */ }
  }
  if (!env.REPL_SOURCE_URL) return { sourcePgMajor: null, sourceDbBytes: null, endpoints };
  try {
    const r = await withClient(endpointFromEnv("REPL_SOURCE", env), async (c) =>
      (await c.query(`SELECT current_setting('server_version_num')::int AS v, pg_database_size(current_database())::bigint AS b`)).rows[0]);
    const v = Number(r.v);
    return { sourcePgMajor: v >= 100000 ? Math.floor(v / 10000) : v / 10000, sourceDbBytes: Number(r.b), endpoints };
  } catch { return { sourcePgMajor: null, sourceDbBytes: null, endpoints }; }
}

export async function realPrecheck(tenantId: string, m: MigrationRow, deps: Partial<PrecheckDeps> = {}): Promise<PrecheckItem[]> {
  const env = deps.env ?? process.env;
  const [envs, db] = await Promise.all([envInfo(tenantId, m), sourceDbFacts(env)]);
  const checks = await runCloudPrecheck({ ...envs, ...db }, { exec: spawnExec, ...deps, env });
  return toPrecheckItems(checks).map((i) => PrecheckItem.parse(i));
}

export async function handlePrecheck(raw: unknown) {
  const job = MigrationJob.parse(raw); // 큐 내용은 믿지 않는다: 모양부터
  return runStep(job, {
    name: "precheck",
    expect: "prechecking",
    work: async (j, m) => withStepRoles("precheck", j, m, async () => {
      const items = await realPrecheck(j.tenantId, m);
      const precheckBlockers = items.filter((i) => i.level === "block").length;
      const precheckWarnings = items.filter((i) => i.level === "warn").length;
      const mock = process.env.MOCK_PRECHECK === "1";
      if (precheckBlockers > 0)
        return { to: "spec_review", detail: { precheck: items, precheckWarnings, ...(mock ? { stub: true } : {}) }, evidence: { precheckBlockers } };
      const planId = randomUUID();
      return {
        to: "planning",
        detail: { precheck: items, precheckWarnings, planId, ...(mock ? { stub: true } : {}) },
        evidence: { precheckBlockers },
        next: { queue: QUEUES.plan,
                // 작업 키는 core jobKey 한 곳(plan:<이전 번호>). 환경 겹침은 env_locks 예약이 막는다 (Z43 F3)
                data: { tenantId: job.tenantId, requestId: job.requestId, migrationId: job.migrationId, planId } },
      };
    }),
  });
}
