import { AppSpec, ApprovalRowV2, PlanDoc, PlanJob, PrecheckItem, checkV2, AppSpecV2,
  type PlanAcknowledgement, type PlanCostSummary, type PlanStep, type Provider } from "@svc/contracts";
import { latestAcceptedSpec, latestAcceptedSpecV2, retryBudget, SPEC_DRAFT_KEY, type AcceptedSpecV2Row, type Tx } from "@svc/core";
import { estimateCost, loadCatalog } from "@svc/cost";
import { adapterFor, DbNetworkError, isAdapterError, NEEDS_HUMAN, specV2OrThrow, UNSUPPORTED_V2, withDbNetwork } from "@svc/adapters";
import type { z } from "zod";
import { runStep, stableHash, stubWait, type StepOutcome } from "./_step.js";
import { savePlan } from "./plan-store.js";
import { withStepRoles } from "./_roles.js";
import { builderVersion, helmValuesV2, planIrV2, tfCallV2 } from "./plan-v2.js";

type Step = z.infer<typeof PlanStep>;

export interface PlanInput {
  planId: string; migrationId: string; spec: AppSpec;
  target: { envId: string; provider: Provider; region: string };
  precheck: PrecheckItem[]; now: Date;
  // PA4: 아래 셋은 계획 작업(handlePlan)이 채운다. costSummary 가 없으면 예전 계획서 모양·지문 그대로
  source?: { provider: Provider };
  specVersion?: number;
  costSummary?: PlanCostSummary;
  v2Approvals?: ApprovalRowV2[];
  // TA3: PLAN_IR=v2 일 때만. 있으면 도착 Builder v2 로 지문을 만들고 계획서에 irVersion·specSource·instances 를 싣는다
  specV2?: { spec: AppSpecV2; source: "spec_v2" | "upconvert" };
}

// ---- PA4 (계획 26 · A4): 비용 고지 + 확인 항목 ----

// DRAFT(ai): 계획서 비용 계산의 피크 트래픽. API 미리보기(routes/migration-cost.ts PREVIEW_PEAK_RPS)와 같은 10 rps
export const PLAN_COST_PEAK_RPS = 10;
// PA4fix: 고지 문구의 재시도 횟수는 실제 한도(core retryBudget(): RETRY_BUDGET 환경변수, 숫자 아니면 3)와 같은 함수에서 읽는다.
//   예전엔 상수 3 이라 RETRY_BUDGET=5 로 켜면 고지(3번)와 실제(5번)가 어긋났다. 0 = 한도 꺼짐(횟수 제한 없음)
//   같은 RETRY_BUDGET 이면 문구·지문은 그대로. 계획 만들 때의 값이 지문에 들어가므로 승인 뒤 환경변수가 바뀌어도 본 문구는 그대로다

type CostEstimator = (spec: AppSpec, from: Provider, to: Provider) => PlanCostSummary;

const r1 = (x: number) => Math.round(x * 10) / 10;

// 출발·도착 월 비용. 순수 계산(가격표는 파일). 실패해도 던지지 않는다: 계획을 막지 않고 unknownFields 에 남긴다 (계획 26 A4 함정)
// 시간에 따라 바뀌는 값(priceStale)은 넣지 않는다 → 같은 입력이면 같은 지문
export const estimatePlanCost: CostEstimator = (spec, from, to) => {
  try {
    const est = estimateCost({ spec, from, targets: [to], traffic: { peakRps: PLAN_COST_PEAK_RPS }, profile: "startup" },
      loadCatalog(), { breakpoints: false });
    const src = est.envs.find((e) => e.provider === from)?.monthlyUsd ?? null;
    const dst = est.envs.find((e) => e.provider === to)?.monthlyUsd ?? null;
    const unknownFields = [...(src === null ? ["monthlySource"] : []), ...(dst === null ? ["monthlyTarget"] : [])];
    return { currency: "USD", monthlyTarget: dst, monthlySource: src,
      deltaMonthly: src !== null && dst !== null ? r1(dst - src) : null, unknownFields, priceAsOf: est.priceAsOf };
  } catch {
    return { currency: "USD", monthlyTarget: null, monthlySource: null, deltaMonthly: null, unknownFields: ["*"] };
  }
};

const usd = (v: number | null) => (v === null ? "계산 못 함" : `$${v}`);

// 확인 항목 목록. cost·failure_cost_policy 는 항상, 그다음 사전 점검 warn, IR v2 승인 행 (같은 id 는 하나로)
export function buildAcknowledgements(i: {
  cost: PlanCostSummary; from: Provider; to: Provider;
  precheck: PrecheckItem[]; v2Approvals?: ApprovalRowV2[]; env?: NodeJS.ProcessEnv;
}): PlanAcknowledgement[] {
  const c = i.cost;
  const free = retryBudget(i.env ?? process.env);
  const out: PlanAcknowledgement[] = [
    { id: "cost", kind: "cost",
      // DRAFT(ai): 고지 문구. "고객 부담" 뜻 = 자원은 고객 계정에 생기므로 클라우드 요금은 처음부터 고객 청구서 (계획 26 3.1 추정)
      text: `예상 월 비용(USD): 도착 ${i.to} ${usd(c.monthlyTarget)} / 출발 ${i.from} ${usd(c.monthlySource)} / 차이 ${usd(c.deltaMonthly)}. `
        + "도착 자원은 고객 클라우드 계정에 만들어지고 요금도 고객 계정에 청구됩니다"
        + (c.unknownFields.length ? ` (계산 못 한 칸: ${c.unknownFields.join(", ")})` : "")
        + (c.stub ? " (가짜 고정값)" : "") },
    { id: "failure_cost_policy", kind: "failure_cost_policy",
      text: (free > 0
        ? `이전이 실패하면 AI 원인 분석과 재시도 ${free}번까지의 AI 비용은 플랫폼이 부담합니다. 그 뒤 재시도의 비용은 고객 부담입니다. `
        : "이전이 실패하면 AI 원인 분석과 재시도의 AI 비용은 횟수 제한 없이 플랫폼이 부담합니다. ")
        + "클라우드 자원 요금은 처음부터 고객 계정에 청구됩니다" },
  ];
  for (const p of i.precheck) if (p.level === "warn")
    out.push({ id: `precheck_warn:${p.id}`, kind: "precheck_warn", text: p.message + (p.fix ? ` (조치: ${p.fix})` : ""), ref: p.id });
  for (const a of i.v2Approvals ?? []) {
    const text = [a.from !== undefined || a.to !== undefined ? `${a.from ?? "?"} → ${a.to ?? "?"}` : "", a.detail ?? ""]
      .filter(Boolean).join(" · ") || a.subject;
    out.push({ id: `${a.kind}:${a.subject}`, kind: a.kind, text, ref: a.subject });
  }
  // 같은 id 가 두 번이면 글을 합친다 (acks 는 id 로만 덮으므로)
  const byId = new Map<string, PlanAcknowledgement>();
  for (const a of out) {
    const prev = byId.get(a.id);
    byId.set(a.id, prev ? { ...prev, text: `${prev.text} / ${a.text}` } : a);
  }
  return [...byId.values()];
}

// 계획에 쓰는 명세 판의 번호와 IR v2 승인 행. spec_v2 칸은 IR 묶음(0023)이 넣는다 → to_jsonb 로 읽어 칸이 없어도 안 깨진다
// latestAcceptedSpec 과 같은 줄(초안 판 제외 최신)을 고른다
export async function loadPlanSpecExtras(tx: Tx, migrationId: string): Promise<{ specVersion?: number; v2Approvals: ApprovalRowV2[] }> {
  const r = await tx.query(
    `SELECT s.version, to_jsonb(s)->'spec_v2'->'spec' AS v2 FROM spec_versions s
      WHERE s.migration_id = $1 AND NOT (s.field_meta ? $2) ORDER BY s.version DESC LIMIT 1`, [migrationId, SPEC_DRAFT_KEY]);
  const row = r.rows[0] as { version: number; v2: unknown } | undefined;
  if (!row) return { v2Approvals: [] };
  const v2 = AppSpecV2.safeParse(row.v2);
  return { specVersion: Number(row.version), v2Approvals: v2.success ? checkV2(v2.data).approvals : [] };
}

// DRAFT(ai): 승인 유효 시간 2시간 (설계 5.4 "승인 유효 2시간"을 따름)
export const PLAN_TTL_MS = 2 * 60 * 60 * 1000;

// 계획서 만들기. 어댑터의 toTerraform / toHelmValues를 진짜로 부른다 (어댑터는 순수 함수)
// 같은 입력이면 같은 planHash가 나와야 한다 (사람이 본 계획 = 실행할 계획)
// Z77: 데모 DB 네트워크 변수(DB_PUBLIC 등, env 기본 process.env)도 지문에 넣는다. 안 켜면 예전과 같은 지문
export function buildPlanDoc(i: PlanInput, env: NodeJS.ProcessEnv = process.env): PlanDoc {
  const a = adapterFor(i.target.provider);
  // TA3: v2 면 고정 루트 + workloads[] (v1 함수는 안 부름). v1 이면 예전 그대로
  const v2 = i.specV2;
  const tf = v2 ? tfCallV2(v2.spec, i.target, env) : withDbNetwork(a.toTerraform(i.spec, i.target), i.target.provider, env);
  // STUB: 진짜 Terraform 출력값은 apply 뒤에 생긴다. 계획 단계에서는 빈 값으로 Helm 값 모양만 고정한다
  const helm = v2 ? helmValuesV2(v2.spec, i.target) : a.toHelmValues(i.spec, {}, i.target);
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
    adapterVersion: v2 ? builderVersion(i.target.provider) : a.version,
    steps,
    precheck: i.precheck,
    // DECISION(team): 롤백 기준 5xx>1% 또는 p95>2배, 30초 창 (decisions 2026-10-30)
    rollbackCriteria: { errorRatePct: 1, p95Multiplier: 2, windowSec: 30 },
    tfPlanHash: stableHash(tf),
    helmValuesHash: stableHash(helm),
    // TA3: v2 계획서만 세 칸. v1 body 엔 키 자체를 안 넣는다 (canonical 이 undefined 도 키로 남겨 v1 지문이 바뀌므로)
    ...(v2 ? { irVersion: "2" as const, specSource: v2.source, instances: "instances" in tf ? tf.instances : [] } : {}),
    // PA4: 비용 요약이 있을 때만 새 칸을 싣는다 (없으면 예전 지문 그대로)
    ...(i.specVersion !== undefined ? { specVersion: i.specVersion } : {}),
    ...(i.costSummary ? {
      costSummary: i.costSummary,
      acknowledgements: buildAcknowledgements({ cost: i.costSummary, from: i.source?.provider ?? i.target.provider,
        to: i.target.provider, precheck: i.precheck, v2Approvals: i.v2Approvals, env }),
    } : {}),
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
      // PA4: 출발 환경 종류 (비용 비교의 출발)
      const se = await tx.query(`SELECT provider FROM environments WHERE id=$1`, [m.sourceEnvId]);
      if (!spec || !env || env.connection_status !== "connected") return null;
      // Z97: 계획서의 사전 점검 칸 = 바로 앞 precheck 단계가 실조회로 남긴 결과 (감사 precheck.planning detail). 예전엔 STUB 고정값
      const pc = await tx.query(
        `SELECT detail->'precheck' AS items FROM audit_events WHERE target=$1 AND action='precheck.planning' ORDER BY seq DESC LIMIT 1`, [m.id]);
      const precheck = PrecheckItem.array().safeParse(pc.rows[0]?.items ?? []);
      const extras = await loadPlanSpecExtras(tx, m.id);
      // TA3: 깃발 v2 면 같은 판의 spec_v2 + "앞 판에 있었나". 고르기(resolve)는 work 에서 (NEEDS_HUMAN 이면 바로 failed)
      const specRowV2 = planIrV2() ? await latestAcceptedSpecV2(tx, m.id) : null;
      return { spec: AppSpec.parse(spec), provider: env.provider as Provider, precheck: precheck.success ? precheck.data : [],
               sourceProvider: (se.rows[0]?.provider ?? env.provider) as Provider, ...extras, specRowV2 };
    },
    work: async (j, m, loaded) => withStepRoles("plan", j, m, async () => {
      const { spec, provider, precheck, sourceProvider, specVersion, v2Approvals, specRowV2 } = loaded as {
        spec: AppSpec; provider: Provider; precheck: PrecheckItem[];
        sourceProvider: Provider; specVersion?: number; v2Approvals: ApprovalRowV2[]; specRowV2: AcceptedSpecV2Row | null };
      await stubWait();
      const specV2 = specRowV2 ? specV2OrThrow(specRowV2) : undefined;
      const plan = buildPlanDoc({
        planId: job.planId, migrationId: m.id, spec,
        // TODO(human): 환경별 리전은 environments 표에 칸이 없다. 연결 정보에서 가져올지 정해야 한다
        target: { envId: m.targetEnvId, provider, region: "default" },
        precheck, now: new Date(),
        // PA4: 비용 고지·확인 항목은 항상 싣는다 (승인 때 확인을 강제하는 건 api 깃발 PLAN_ACKS)
        source: { provider: sourceProvider }, specVersion, v2Approvals,
        costSummary: estimatePlanCost(spec, sourceProvider, provider),
        ...(specV2 ? { specV2 } : {}),
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
  // TA3: v2 Builder 가 못 그림 / 사람이 정해야 함 — 재시도해도 같다 → 바로 failed (재시도 다 쓰지 않음)
  if (isAdapterError(e) && (e.code === UNSUPPORTED_V2 || e.code === NEEDS_HUMAN))
    return { to: "failed", failureCode: e.code, detail: { error: e.message } };
  return null;
}
