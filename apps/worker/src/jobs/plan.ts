import { AppSpec, PlanDoc, PlanJob, PrecheckItem, type PlanStep, type Provider } from "@svc/contracts";
import { latestAcceptedSpec } from "@svc/core";
import { adapterFor, DbNetworkError, withDbNetwork } from "@svc/adapters";
import type { z } from "zod";
import { runStep, stableHash, stubWait, type StepOutcome } from "./_step.js";
import { savePlan } from "./plan-store.js";
import { withStepRoles } from "./_roles.js";

type Step = z.infer<typeof PlanStep>;

export interface PlanInput {
  planId: string; migrationId: string; spec: AppSpec;
  target: { envId: string; provider: Provider; region: string };
  precheck: PrecheckItem[]; now: Date;
}

// DRAFT(ai): 승인 유효 시간 2시간 (설계 5.4 "승인 유효 2시간"을 따름)
export const PLAN_TTL_MS = 2 * 60 * 60 * 1000;

// 계획서 만들기. 어댑터의 toTerraform / toHelmValues를 진짜로 부른다 (어댑터는 순수 함수)
// 같은 입력이면 같은 planHash가 나와야 한다 (사람이 본 계획 = 실행할 계획)
// Z77: 데모 DB 네트워크 변수(DB_PUBLIC 등, env 기본 process.env)도 지문에 넣는다. 안 켜면 예전과 같은 지문
export function buildPlanDoc(i: PlanInput, env: NodeJS.ProcessEnv = process.env): PlanDoc {
  const a = adapterFor(i.target.provider);
  const tf = withDbNetwork(a.toTerraform(i.spec, i.target), i.target.provider, env);
  // STUB: 진짜 Terraform 출력값은 apply 뒤에 생긴다. 계획 단계에서는 빈 값으로 Helm 값 모양만 고정한다
  const helm = a.toHelmValues(i.spec, {}, i.target);
  // DRAFT(ai): 단계별 예상 시간·게이트는 설계 문서 수치가 정해지기 전 임시값
  const steps: Step[] = [
    { id: "provision", owner: "terraform", estSec: 300, rollback: "terraform destroy (사람 승인)" },
    { id: "deploy", owner: "argocd", estSec: 120, gate: "synced_healthy" },
    { id: "sync", owner: "worker", estSec: 300, gate: "replication_lag_ms < 1000" },
    { id: "shift", owner: "worker", weights: [10, 50, 100], holdSec: 30, rollback: "weights -> source 100" },
    { id: "cutover", owner: "worker", estSec: 60 },
    { id: "cleanup", owner: "worker", estSec: 60 },
  ];
  const body = {
    planId: i.planId,
    migrationId: i.migrationId,
    adapterVersion: a.version,
    steps,
    precheck: i.precheck,
    // DECISION(team): 롤백 기준 5xx>1% 또는 p95>2배, 30초 창 (decisions 2026-10-30)
    rollbackCriteria: { errorRatePct: 1, p95Multiplier: 2, windowSec: 30 },
    tfPlanHash: stableHash(tf),
    helmValuesHash: stableHash(helm),
  };
  // planHash는 만료 시각을 뺀 내용 전체의 지문이다 (같은 계획을 다시 만들어도 같은 지문)
  const planHash = stableHash(body);
  return PlanDoc.parse({ ...body, planHash,
    expiresAt: new Date(i.now.getTime() + PLAN_TTL_MS).toISOString() });
}

export async function handlePlan(raw: unknown) {
  const job = PlanJob.parse(raw);
  return runStep(job, {
    name: "plan",
    expect: "planning",
    // ① 재확인: 명세가 있고, 도착 환경이 연결돼 있어야 한다 (설계 5.2 plan 행)
    load: async (tx, _j, m) => {
      // Z19 H1: AI 초안 판(_draft)은 계획 입력이 아니다. 사람·규칙이 만든 최신 판만 쓴다
      const spec = await latestAcceptedSpec(tx, m.id);
      const e = await tx.query(
        `SELECT id, provider, connection_status FROM environments WHERE id=$1`, [m.targetEnvId]);
      const env = e.rows[0];
      if (!spec || !env || env.connection_status !== "connected") return null;
      // Z97: 계획서의 사전 점검 칸 = 바로 앞 precheck 단계가 실조회로 남긴 결과 (감사 precheck.planning detail). 예전엔 STUB 고정값
      const pc = await tx.query(
        `SELECT detail->'precheck' AS items FROM audit_events WHERE target=$1 AND action='precheck.planning' ORDER BY seq DESC LIMIT 1`, [m.id]);
      const precheck = PrecheckItem.array().safeParse(pc.rows[0]?.items ?? []);
      return { spec: AppSpec.parse(spec), provider: env.provider as Provider, precheck: precheck.success ? precheck.data : [] };
    },
    work: async (j, m, loaded) => withStepRoles("plan", j, m, async () => {
      const { spec, provider, precheck } = loaded as { spec: AppSpec; provider: Provider; precheck: PrecheckItem[] };
      await stubWait();
      const plan = buildPlanDoc({
        planId: job.planId, migrationId: m.id, spec,
        // TODO(human): 환경별 리전은 environments 표에 칸이 없다. 연결 정보에서 가져올지 정해야 한다
        target: { envId: m.targetEnvId, provider, region: "default" },
        precheck, now: new Date(),
      });
      return { to: "awaiting_approval", detail: { planId: plan.planId, planHash: plan.planHash },
               inTx: (tx) => savePlan(tx, job.tenantId, plan) };
    }),
    onError: planOnError,
  });
}

// Z38 REVIEW-5 Z77-1: DB_PEER_CIDRS 가 틀리면 재시도해도 같다 → 바로 failed(DB_NETWORK_INVALID).
//   예전엔 재시도를 다 쓴 뒤 JOB_FAILED_PLAN 이라 화면에서 이유(허용 목록이 넓다 등)가 안 보였다
export async function planOnError(e: unknown): Promise<StepOutcome | null> {
  if (e instanceof DbNetworkError) return { to: "failed", failureCode: e.code, detail: { error: e.message } };
  return null;
}
