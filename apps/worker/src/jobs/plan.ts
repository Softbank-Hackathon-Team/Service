import { ApprovalRowV2, PlanDoc, PlanJob, PrecheckItem, QUEUES, checkV2, AppSpecV2,
  type PlanAcknowledgement, type PlanCostSummary, type PlanStep, type PriceCatalog, type Provider } from "@svc/contracts";
import { PLAN_ROLLBACK_WINDOW_SEC, latestAcceptedSpecV2, retryBudget, SPEC_DRAFT_KEY, type AcceptedSpecV2Row, type Tx } from "@svc/core";
import { estimateCostV2, loadCatalog } from "@svc/cost";
import { DbNetworkError, isAdapterError, NEEDS_HUMAN, regionOf, specV2OrThrow, targetBuilderFor, UNSUPPORTED_V2 } from "@svc/adapters";
import { planEnvLayer, readEnvLayer, type EnvLayerRow } from "../env-layer.js";
import type { z } from "zod";
import { failedAttempts, jobData, recordAttemptFailure, RetryLater, runStep, stableHash, stubWait, type StepOutcome } from "./_step.js";
import { savePlan } from "./plan-store.js";
import { withStepRoles } from "./_roles.js";
import { builderVersion, helmValuesV2, tfCallV2 } from "./plan-v2.js";
import { importedFor, provisionOf, targetFactsOf } from "./plan-facts.js";
import type { ImportedInfra } from "@svc/adapters";
import { TARGET_ACCOUNT_SQL } from "./target-account.js";

type Step = z.infer<typeof PlanStep>;

export interface PlanInput {
  planId: string; migrationId: string; spec: AppSpecV2;
  target: { envId: string; provider: Provider; region: string };
  precheck: PrecheckItem[]; now: Date;
  // PA4: 아래 셋은 계획 작업(handlePlan)이 채운다. costSummary 가 없으면 예전 계획서 모양·지문 그대로
  source?: { provider: Provider };
  specVersion?: number;
  costSummary?: PlanCostSummary;
  v2Approvals?: ApprovalRowV2[];
  // G7-3·G7-4: 계획 작업(handlePlan)이 채운다. 없으면 칸 없음 = 예전 지문
  accountId?: string | null;          // 환경 표 account_id (aws 계정 / gcp 프로젝트) → targetFacts
  imported?: ImportedInfra | null;    // 작업 폴더 imported.json → provision: reuse
  // 환경 층 (env-layer.ts planEnvLayer). 없으면 칸 없음 = 예전 지문 (TF_FACT_* 길)
  envLayer?: NonNullable<PlanDoc["envLayer"]>;
  envLayerFacts?: Record<string, string>;   // existing 일 때 DB 사실 → targetFacts
}

// ---- PA4 (계획 26 · A4): 비용 고지 + 확인 항목 ----

// DRAFT(ai): 계획서 비용 계산의 피크 트래픽. API 미리보기(routes/migration-cost.ts PREVIEW_PEAK_RPS)와 같은 10 rps
export const PLAN_COST_PEAK_RPS = 10;
// PA4fix: 고지 문구의 재시도 횟수는 실제 한도(core retryBudget(): RETRY_BUDGET 환경변수, 숫자 아니면 3)와 같은 함수에서 읽는다.
//   예전엔 상수 3 이라 RETRY_BUDGET=5 로 켜면 고지(3번)와 실제(5번)가 어긋났다. 0 = 한도 꺼짐(횟수 제한 없음)
//   같은 RETRY_BUDGET 이면 문구·지문은 그대로. 계획 만들 때의 값이 지문에 들어가므로 승인 뒤 환경변수가 바뀌어도 본 문구는 그대로다

const r1 = (x: number) => Math.round(x * 10) / 10;

// 출발·도착 월 비용. 명세(구성요소 전부)로 센다. 순수 계산(가격표는 파일). 실패해도 던지지 않는다: 계획을 막지 않고 unknownFields 에 남긴다 (계획 26 A4 함정)
//   시간에 따라 바뀌는 값(priceStale)은 넣지 않는다 → 같은 입력이면 같은 지문
//   가격표에 없는 구성요소·칸은 unknownFields 에 "<종류>:<id>[.<칸>]" 로 남긴다 (출발·도착 합집합, 이름순)
//   catalog 는 시험용 (안 주면 loadCatalog)
export const estimatePlanCost = (spec: AppSpecV2, from: Provider, to: Provider, catalog?: PriceCatalog): PlanCostSummary => {
  try {
    const est = estimateCostV2({ spec, providers: [from, to], peakRps: PLAN_COST_PEAK_RPS }, catalog ?? loadCatalog());
    const env = (p: Provider) => est.envs.find((e) => e.provider === p)!;
    const src = env(from).monthlyUsd;
    const dst = env(to).monthlyUsd;
    const unknownFields = [...(src === null ? ["monthlySource"] : []), ...(dst === null ? ["monthlyTarget"] : []),
      ...[...new Set([...env(from).unknown, ...env(to).unknown])].sort()];
    return { currency: "USD", monthlyTarget: dst, monthlySource: src,
      deltaMonthly: src !== null && dst !== null ? r1(dst - src) : null, unknownFields, priceAsOf: est.priceAsOf };
  } catch {
    return { currency: "USD", monthlyTarget: null, monthlySource: null, deltaMonthly: null, unknownFields: ["*"] };
  }
};

const usd = (v: number | null) => (v === null ? "계산 못 함" : `$${v}`);
// 콜론 있는 칸 = 금액에 반영 안 된 구성요소·칸. 콜론 없는 칸 = monthlySource·monthlyTarget·*
const isUnpriced = (f: string) => f.includes(":");

// 확인 항목 목록. cost·failure_cost_policy 는 항상, 그다음 사전 점검 warn, IR v2 승인 행 (같은 id 는 하나로)
export function buildAcknowledgements(i: {
  cost: PlanCostSummary; from: Provider; to: Provider;
  precheck: PrecheckItem[]; v2Approvals?: ApprovalRowV2[]; env?: NodeJS.ProcessEnv;
}): PlanAcknowledgement[] {
  const c = i.cost;
  const free = retryBudget(i.env ?? process.env);
  const gaps = c.unknownFields.filter((f) => !isUnpriced(f));
  const unpriced = c.unknownFields.filter(isUnpriced);
  const out: PlanAcknowledgement[] = [
    { id: "cost", kind: "cost",
      // DRAFT(ai): 고지 문구. "고객 부담" 뜻 = 자원은 고객 계정에 생기므로 클라우드 요금은 처음부터 고객 청구서 (계획 26 3.1 추정)
      text: `예상 월 비용(USD): 도착 ${i.to} ${usd(c.monthlyTarget)} / 출발 ${i.from} ${usd(c.monthlySource)} / 차이 ${usd(c.deltaMonthly)}. `
        + "도착 자원은 고객 클라우드 계정에 만들어지고 요금도 고객 계정에 청구됩니다"
        + (gaps.length ? ` (계산 못 한 칸: ${gaps.join(", ")})` : "")
        // TA3 비용 DRAFT(ai): v2 에서 가격표에 없어 빠진 구성요소·칸. 사람이 "이 금액이 전부가 아니다"를 보고 확인하게 문구로 적는다
        + (unpriced.length ? `. 일부 자원·설정은 위 금액에 포함되지 않았습니다: ${unpriced.join(", ")}` : "")
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
    const text = [a.from !== undefined || a.to !== undefined ? `${a.from ?? "?"} → ${a.to ?? "?"}` : "", a.detail ?? "",
      a.lost?.length ? `옮기지 못하는 것: ${a.lost.join(", ")}` : "", a.appChange ? "앱 코드 변경 필요" : ""]
      .filter(Boolean).join(" · ") || a.subject;
    // 구조 칸은 substitute 만 싣는다 (다른 종류 항목은 예전 모양·지문 그대로)
    out.push({ id: `${a.kind}:${a.subject}`, kind: a.kind, text, ref: a.subject,
      ...(a.kind === "substitute" ? { from: a.from, to: a.to, lost: a.lost ?? [], appChange: a.appChange ?? false } : {}) });
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
// G7-1: 만료 깨우기 작업의 대기(초). 만료 시각 + 1초 (작업이 일찍 깨면 남은 만큼 다시 미룬다)
export const planExpiryDelaySec = (expiresAt: string, now = Date.now()) =>
  Math.max(1, Math.ceil((Date.parse(expiresAt) - now) / 1000) + 1);

// 계획서 만들기. 도착 Builder 의 Terraform 루트 호출·Helm 값(workloads[])을 진짜로 만든다 (Builder 는 순수 함수)
// 같은 입력이면 같은 planHash가 나와야 한다 (사람이 본 계획 = 실행할 계획)
// Z77: 데모 DB 네트워크 변수(DB_PUBLIC 등, env 기본 process.env)도 지문에 넣는다
export function buildPlanDoc(i: PlanInput, env: NodeJS.ProcessEnv = process.env): PlanDoc {
  // G8-1: 자원 이름 seed 에 이전 번호를 넣는다 (apply-real·gitops approvedValues 와 같은 규칙)
  const target = { ...i.target, migrationId: i.migrationId };
  const tf = tfCallV2(i.spec, target, env);
  // STUB: 진짜 Terraform 출력값은 apply 뒤에 생긴다. 계획 단계에서는 빈 값으로 Helm 값 모양만 고정한다
  const helm = helmValuesV2(i.spec, target);
  const from = i.source?.provider ?? i.target.provider;
  // 출발 관리형 상품이 도착에서 다른 상품이 되는 자원 = substitute 확인 항목 (명세에 출발 벤더가 없어 여기서 출발을 넘긴다)
  // 앱 코드를 고쳐야 하는 대체(appChange)도 따로 켜는 자리 없이 이 확인 항목(계획 승인 체크)으로 받는다 (11/06 설계 스레드 합의)
  const v2Approvals = [...(i.v2Approvals ?? []), ...(targetBuilderFor(i.target.provider).substitutionsV2?.(i.spec, from) ?? [])];
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
    adapterVersion: builderVersion(i.target.provider),
    steps,
    precheck: i.precheck,
    // DECISION(team): 롤백 기준 5xx>1% 또는 p95>2배, 30초 창 (decisions 2026-10-30)
    rollbackCriteria: { errorRatePct: 1, p95Multiplier: 2, windowSec: 30 },
    // F8-4: 롤백 가능 창 길이를 승인 대상으로 (DRAFT(ai) 기본 120초, core PLAN_ROLLBACK_WINDOW_SEC)
    rollbackWindowSec: PLAN_ROLLBACK_WINDOW_SEC,
    tfPlanHash: stableHash(tf),
    helmValuesHash: stableHash(helm),
    // 매트릭스 줄 = module.<종류>["<id>"] (apply 가 이 목록으로 상태 주소를 고른다)
    instances: tf.instances,
    // PA4: 비용 요약이 있을 때만 새 칸을 싣는다 (없으면 예전 지문 그대로)
    ...(i.specVersion !== undefined ? { specVersion: i.specVersion } : {}),
    ...(i.costSummary ? {
      costSummary: i.costSummary,
      acknowledgements: buildAcknowledgements({ cost: i.costSummary, from, to: i.target.provider, precheck: i.precheck, v2Approvals, env }),
    } : {}),
  };
  // G7-3·G7-4: 도착 사실·재사용 — 있을 때만 칸 (없으면 예전 지문)
  const targetFacts = i.accountId !== undefined ? targetFactsOf(tf.vars, env, i.target.provider, i.accountId, i.envLayerFacts) : undefined;
  const provision = provisionOf(i.imported ?? null);
  Object.assign(body, {
    ...(targetFacts ? { targetFacts } : {}),
    ...(provision ? { provision } : {}),
    ...(i.envLayer ? { envLayer: i.envLayer } : {}),
  });
  // 환경 층 새로 만들기: GKE 비용·시간·자동 삭제 없음을 사람이 확인하는 항목. create 계획에만 생기는 칸이라 다른 계획 지문은 그대로
  if (i.envLayer?.mode === "create") {
    const acks = ((body as { acknowledgements?: PlanAcknowledgement[] }).acknowledgements ??= []);
    acks.push({ id: "env_layer_create", kind: "env_layer_create", ref: "gcp/env", text: i.envLayer.notice ?? "도착 GKE 를 새로 만듭니다 (비용 발생)" });
  }
  if (provision && "acknowledgements" in body && Array.isArray(body.acknowledgements))
    body.acknowledgements.push({ id: "provision_reuse", kind: "provision_reuse", ref: provision.source,
      text: `도착 자원을 새로 만들지 않고 이미 있는 자원 ${provision.resources.length}개(${provision.resources.join(", ") || "목록 없음"})를 다시 씁니다. 비용 고지는 새로 만드는 기준이라 실제와 다를 수 있습니다` });
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
      // Z19 H1: AI 초안 판(_draft)은 계획 입력이 아니다. 사람·규칙이 만든 최신 판만 쓴다. 모양 확인(resolve)은 work 에서 (NEEDS_HUMAN 이면 바로 failed)
      const specRow = await latestAcceptedSpecV2(tx, m.id);
      const e = await tx.query(
        `SELECT id, provider, connection_status, ${TARGET_ACCOUNT_SQL} AS account_id FROM environments WHERE id=$1`, [m.targetEnvId]);   // A안: GCP = 전용 프로젝트
      const env = e.rows[0];
      // PA4: 출발 환경 종류 (비용 비교의 출발)
      const se = await tx.query(`SELECT provider FROM environments WHERE id=$1`, [m.sourceEnvId]);
      // E10-4: 예전엔 여기서 null → job.rejected 로 조용히 끝나고 이전이 planning 에 영원히 남았다 (planning 은 잠금 단계가 아니라 청소도 안 봄).
      //   이제 명세·환경이 없으면 바로 failed(PLAN_RECHECK_FAILED, 다시 계획 가능). 도착이 잠깐 unstable 이면 정해진 간격으로 몇 번 기다린 뒤 failed
      if (!specRow || !env || env.connection_status !== "connected")
        return { recheckFailed: !specRow ? "no accepted spec" : !env ? "target environment missing" : `target ${env.connection_status}`,
                 retryable: !!specRow && !!env && env.connection_status === "unstable" } as PlanRecheckFailed;
      // Z97: 계획서의 사전 점검 칸 = 바로 앞 precheck 단계가 실조회로 남긴 결과 (감사 precheck.planning detail). 예전엔 STUB 고정값
      const pc = await tx.query(
        `SELECT detail->'precheck' AS items FROM audit_events WHERE target=$1 AND action='precheck.planning' ORDER BY seq DESC LIMIT 1`, [m.id]);
      const precheck = PrecheckItem.array().safeParse(pc.rows[0]?.items ?? []);
      const extras = await loadPlanSpecExtras(tx, m.id);
      const envLayerRow = env.provider === "gcp" ? await readEnvLayer(tx, m.targetEnvId) : null;
      return { envLayerRow, specRow, provider: env.provider as Provider, precheck: precheck.success ? precheck.data : [],
               accountId: (env.account_id as string | null) ?? null,
               sourceProvider: (se.rows[0]?.provider ?? env.provider) as Provider, ...extras };
    },
    work: async (j, m, loaded) => "recheckFailed" in (loaded as object)
      ? planRecheckOutcome(j, loaded as PlanRecheckFailed)
      : withStepRoles("plan", j, m, async () => {
      const { specRow, provider, precheck, sourceProvider, specVersion, v2Approvals, accountId, envLayerRow } = loaded as {
        specRow: AcceptedSpecV2Row; provider: Provider; precheck: PrecheckItem[]; accountId: string | null; envLayerRow: EnvLayerRow | null;
        sourceProvider: Provider; specVersion?: number; v2Approvals: ApprovalRowV2[] };
      await stubWait();
      const { spec } = specV2OrThrow(specRow);
      const plan = buildPlanDoc({
        planId: job.planId, migrationId: m.id, spec,
        // TODO(human): 환경별 리전은 environments 표에 칸이 없다. 연결 정보에서 가져올지 정해야 한다
        target: { envId: m.targetEnvId, provider, region: "default" },
        precheck, now: new Date(),
        // PA4: 비용 고지·확인 항목은 항상 싣는다 (승인 때 확인을 강제하는 건 api 깃발 PLAN_ACKS)
        source: { provider: sourceProvider }, specVersion, v2Approvals,
        // TA3 비용: Terraform 루트와 같은 명세로 센다
        costSummary: estimatePlanCost(spec, sourceProvider, provider),
        accountId, imported: importedFor(process.env, m.id, job.tenantId),
        // 환경 층: DB ready 줄이면 existing(그 사실), 없고 ENV_LAYER_AUTO=1 이면 create(GKE 생성 고지). 그 밖은 칸 없음
        ...(() => { const el = planEnvLayer(provider, envLayerRow, process.env, accountId, regionOf({ envId: m.targetEnvId, provider, region: "default" }));
          return { ...(el.envLayer ? { envLayer: el.envLayer } : {}), ...(el.dbFacts ? { envLayerFacts: el.dbFacts } : {}) }; })(),
      });
      return { to: "awaiting_approval", detail: { planId: plan.planId, planHash: plan.planHash },
               inTx: (tx) => savePlan(tx, job.tenantId, plan),
               // G7-1: 만료 시각에 깨어나 stale 로 옮길 작업. 키는 계획마다 (다시 계획하면 새 계획의 작업이 따로 선다)
               next: { queue: QUEUES.planExpiry, data: { ...jobData(j), planId: plan.planId },
                 opts: { singletonKey: `${QUEUES.planExpiry}:${plan.planId}`, startAfter: planExpiryDelaySec(plan.expiresAt) } } };
    }),
    onError: planOnError,
  });
}

// E10-4: 계획 재확인 실패. 도착이 unstable 이면 PLAN_RECHECK_RETRY_SEC 간격으로 PLAN_RECHECK_MAX 번까지 다시 (감사 plan.attempt_failed 로 셈)
// DRAFT(ai): 30초 × 4번 = 2분. 주기 재확인(1시간)이 흔들림을 되돌리는 데 그보다 오래 걸리면 failed 로 끝나고 사람이 다시 계획한다
interface PlanRecheckFailed { recheckFailed: string; retryable: boolean }
export const PLAN_RECHECK_RETRY_SEC = 30;
export const PLAN_RECHECK_MAX = 4;
async function planRecheckOutcome(j: z.infer<typeof PlanJob>, f: PlanRecheckFailed): Promise<StepOutcome> {
  if (f.retryable) {
    const n = await failedAttempts(j, "plan");
    if (n + 1 < PLAN_RECHECK_MAX) {
      await recordAttemptFailure(j, "plan", { attempts: n + 1, max: PLAN_RECHECK_MAX, error: f.recheckFailed });
      throw new RetryLater(QUEUES.plan, { ...jobData(j), planId: j.planId }, PLAN_RECHECK_RETRY_SEC, { recheck: f.recheckFailed });
    }
  }
  return { to: "failed", failureCode: "PLAN_RECHECK_FAILED", detail: { planId: j.planId, recheck: f.recheckFailed } };
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
