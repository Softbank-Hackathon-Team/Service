import { randomUUID } from "node:crypto";
import { MigrationJob, PrecheckItem, QUEUES, SourceDbFacts, type AppSpecV2, type Provider } from "@svc/contracts";
import { latestAcceptedSpecV2, withTenant } from "@svc/core";
import { envFor, v2PrecheckItems, runCloudPrecheck, toPrecheckItems, spawnExec, resolveSpecV2, targetFactsV2, sourceFactsV2, appEnvV2,
  type EnvSide, type PrecheckEnvInfo, type PrecheckInput, type PrecheckDeps, type CloudProvider } from "@svc/adapters";
import { evaluatePortabilityV2, toSecurityPrecheckItems } from "@svc/security";
import { endpointFromEnv, withClient } from "@svc/replication";
import { runStep } from "./_step.js";
import { withStepRoles, type StepRoles } from "./_roles.js";
import type { MigrationRow } from "./_step.js";
import { planIrV2 } from "./plan-v2.js";

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

// L5c: 빌린 관찰 자격(진짜 발급기일 때만 있음) → 쪽마다 CLI env. 워커 자기 자격(AWS_PROFILE·키)은 지운다
export function precheckSideEnv(roles: Pick<StepRoles, "awsEnv"> | undefined, env: NodeJS.ProcessEnv): PrecheckDeps["sideEnv"] {
  const out: NonNullable<PrecheckDeps["sideEnv"]> = {};
  for (const side of ["source", "target"] as const) { const e = roles?.awsEnv?.[side]; if (e) out[side] = envFor(e, env); }
  return Object.keys(out).length ? out : undefined;
}

export async function realPrecheck(tenantId: string, m: MigrationRow, deps: Partial<PrecheckDeps> = {}, roles?: Pick<StepRoles, "awsEnv">): Promise<PrecheckItem[]> {
  const env = deps.env ?? process.env;
  const [envs, db] = await Promise.all([envInfo(tenantId, m), sourceDbFacts(env)]);
  const sideEnv = deps.sideEnv ?? precheckSideEnv(roles, env);
  const checks = await runCloudPrecheck({ ...envs, ...db }, { exec: spawnExec, ...deps, env, ...(sideEnv ? { sideEnv } : {}) });
  return toPrecheckItems(checks).map((i) => PrecheckItem.parse(i));
}

// TA3 (설계 27번 3.6): PLAN_IR=v2 면 v2 명세를 도착 capability 와 대조한다. 못 그리는 칸·사람 확인 → block (명세 검토로 되돌림)
//   깃발 off 면 빈 목록 (지금 점검 그대로)
export async function v2PrecheckFor(tenantId: string, m: MigrationRow, env: NodeJS.ProcessEnv = process.env): Promise<PrecheckItem[]> {
  if (!planIrV2(env)) return [];
  return withTenant(tenantId, async (tx) => {
    const row = await latestAcceptedSpecV2(tx, m.id);
    const e = await tx.query(`SELECT provider FROM environments WHERE id=$1`, [m.targetEnvId]);
    if (!row || !e.rows[0]) return [];   // 명세·도착이 없으면 계획 단계 재확인이 막는다
    return v2PrecheckItems(e.rows[0].provider, row);
  });
}

// 보안 판정 연결: 명세의 보안 요구사항 + 출발 사실(가져오기가 읽은 securityFacts) + 도착 사실(모듈 고정값)을 맞대어
//   막기(block → 명세 검토로 되돌림)·경고(warn → 계획서 승인 항목 precheck_warn:SEC:…)·참고(info)를 낸다. 순수 함수
export function securityPrecheckItems(i: { spec: AppSpecV2; securityFacts?: Record<string, SourceDbFacts>; source: EnvSide; target: EnvSide }): PrecheckItem[] {
  const t = targetFactsV2(i.target, i.spec);
  const r = evaluatePortabilityV2({
    requirements: i.spec.security?.requirements ?? null,
    source: sourceFactsV2(i.source, i.spec, i.securityFacts),
    target: t.env, targetDbs: t.dbs, appEnv: appEnvV2(i.spec),
  });
  return toSecurityPrecheckItems(r).map((x) => PrecheckItem.parse(x));
}

// PLAN_IR=v2 일 때만. SEC_PRECHECK=0 이면 끔 (지금 점검 그대로). 명세를 못 쓰면 [] (v2PrecheckFor·계획 단계가 막는다)
export async function securityPrecheckFor(tenantId: string, m: MigrationRow, env: NodeJS.ProcessEnv = process.env): Promise<PrecheckItem[]> {
  if (!planIrV2(env) || env.SEC_PRECHECK === "0") return [];
  return withTenant(tenantId, async (tx) => {
    const row = await latestAcceptedSpecV2(tx, m.id);
    const spec = row ? resolveSpecV2(row) : null;
    if (!row || !spec?.ok) return [];
    // 출발 사실은 같은 판의 spec_v2.securityFacts (spec 밖이라 사람 PATCH 로 안 바뀜). 모양이 틀리거나 없으면 모름
    const f = await tx.query(`SELECT to_jsonb(s)->'spec_v2'->'securityFacts' AS f FROM spec_versions s WHERE s.migration_id = $1 AND s.version = $2`, [m.id, row.version]);
    const raw = f.rows[0]?.f;
    const facts: Record<string, SourceDbFacts> = {};
    if (raw && typeof raw === "object") for (const [id, v] of Object.entries(raw)) { const p = SourceDbFacts.safeParse(v); if (p.success) facts[id] = p.data; }
    const e = await tx.query(`SELECT id, provider, region FROM environments WHERE id = ANY($1::uuid[])`, [[m.sourceEnvId, m.targetEnvId]]);
    const side = (id: string): EnvSide | null => {
      const r = e.rows.find((x) => x.id === id);
      return r ? { envId: id, provider: r.provider as Provider, region: (r.region as string | null) ?? null } : null;
    };
    const source = side(m.sourceEnvId), target = side(m.targetEnvId);
    if (!source || !target) return [];
    return securityPrecheckItems({ spec: spec.spec, securityFacts: facts, source, target });
  });
}

export async function handlePrecheck(raw: unknown) {
  const job = MigrationJob.parse(raw); // 큐 내용은 믿지 않는다: 모양부터
  return runStep(job, {
    name: "precheck",
    expect: "prechecking",
    work: async (j, m) => withStepRoles("precheck", j, m, async (roles) => {
      const items = [...await realPrecheck(j.tenantId, m, {}, roles), ...await v2PrecheckFor(j.tenantId, m), ...await securityPrecheckFor(j.tenantId, m)];
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
