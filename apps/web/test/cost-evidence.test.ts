import { test } from "node:test";
import assert from "node:assert/strict";
import {
  basisTag,
  changeText,
  envCostCaption,
  envCostSummary,
  extraRefs,
  figureRows,
  figuresOf,
  lineGroups,
  monthlyChange,
  money,
  moveCostBody,
  promoAmount,
  promoBuckets,
  promoSummary,
  shareRecent,
  sourceLine,
  targetPrice,
} from "../src/features/cost/evidence";
import type { CostLine, CostProjection, CostPromotion, EnvCostView } from "../src/lib/types";

// 숫자는 근거 비용 샘플(EKS t3.medium x2 + RDS db.t3.medium 20GB + ALB + NAT → GCP·온프레)과 같다
const promo = (over: Partial<CostPromotion>): CostPromotion => ({
  id: "p", provider: "gcp", title: "p", kind: "program_credit", status: "conditional", condition: "c", appliesTo: "a",
  firstYearUsd: 0, monthlyUsd: Array(12).fill(0), validUntil: null, sourceUrl: "https://example.com", checkedAt: "2026-11-06", note: null, ...over,
});
const FREE_TIER = promo({ id: "gcp-gke-free-tier", status: "applied", kind: "recurring_credit", firstYearUsd: 876 });
const TRIAL = promo({ id: "gcp-free-trial-300", kind: "trial_credit", firstYearUsd: 300 });
const STARTUPS = promo({ id: "gcp-startups-start" });
const WAIVER = promo({ id: "aws-exit-data-transfer", provider: "aws", kind: "data_transfer_waiver" });
const GCP: CostProjection = {
  monthlyUsd: 276.83, yearlyUsd: 3321.96, appliedYearlyUsd: 2445.96, conditionalYearlyUsd: 2145.96, appliedMonthlyUsd: 203.83,
  promotions: [FREE_TIER, TRIAL, STARTUPS, WAIVER],
};
const AWS: CostProjection = { monthlyUsd: 307.4, yearlyUsd: 3688.8, appliedYearlyUsd: 3688.8, conditionalYearlyUsd: 3688.8, appliedMonthlyUsd: 307.4, promotions: [] };
const ONPREM: CostProjection = { monthlyUsd: 394.94, yearlyUsd: 4739.28, appliedYearlyUsd: 4739.28, conditionalYearlyUsd: 4739.28, appliedMonthlyUsd: 394.94, promotions: [WAIVER] };
const env = (over: Partial<EnvCostView>): EnvCostView => ({
  envId: "e", name: "shop-aws", provider: "aws", status: "ok", reason: null, inventoryCheckedAt: null, breakdown: null, projection: AWS, ...over,
});

test("금액은 센트까지, 천 단위 쉼표, 음수는 앞에 -", () => {
  assert.equal(money(307.4), "$307.40");
  assert.equal(money(2445.96), "$2,445.96");
  assert.equal(money(-73), "-$73.00");
  assert.equal(money(-0.001), "$0.00", "반올림해서 0 이면 부호를 붙이지 않는다");
});

test("한 달·1년: 늘 받는 프로모션을 뺀 금액을 쓰고, 정가와 조건 충족 시 금액은 다를 때만 따로 둔다", () => {
  assert.deepEqual(figuresOf(GCP), { monthly: 203.83, listMonthly: 276.83, yearly: 2445.96, listYearly: 3321.96, conditionalYearly: 2145.96 });
  assert.deepEqual(figuresOf(AWS), { monthly: 307.4, listMonthly: null, yearly: 3688.8, listYearly: null, conditionalYearly: null });
  // 조건부 금액이 없으면(신청 프로그램뿐) 조건 충족 시 금액을 두지 않는다
  assert.equal(figuresOf(ONPREM).conditionalYearly, null);
  assert.deepEqual(figureRows(figuresOf(GCP)), [
    { name: "정가 한 달", value: "$276.83" },
    { name: "늘 받는 할인", value: "-$73.00" },
    { name: "1년", value: "$2,445.96" },
    { name: "조건 충족 시 1년", value: "$2,145.96" },
  ]);
  assert.deepEqual(figureRows(figuresOf(AWS)), [{ name: "1년", value: "$3,688.80" }]);
});

test("도착 후보 줄: 월·1년(+조건 충족 시), 계산하지 못했으면 서버 이유", () => {
  assert.deepEqual(targetPrice({ feasible: true, reason: null, projection: GCP }), { month: "월 $203.83", year: "1년 $2,445.96 · 조건 충족 시 $2,145.96" });
  assert.deepEqual(targetPrice({ feasible: true, reason: null, projection: ONPREM }), { month: "월 $394.94", year: "1년 $4,739.28" });
  assert.deepEqual(targetPrice({ feasible: false, reason: "Azure 는 모의 환경이라 비용을 세지 않습니다", projection: null }), { reason: "Azure 는 모의 환경이라 비용을 세지 않습니다" });
  assert.deepEqual(targetPrice({ feasible: false, reason: null, projection: null }), { reason: "계산하지 못했습니다" });
});

test("지금보다: 화면에 보이는 평소 한 달끼리 뺀다 (서버 delta 는 정가끼리)", () => {
  const delta = monthlyChange({ projection: AWS }, { projection: GCP });
  assert.equal(delta, 103.57);
  assert.equal(changeText(delta!), "월 $103.57 아낌");
  assert.equal(changeText(monthlyChange({ projection: AWS }, { projection: ONPREM })!), "월 $87.54 더 듦");
  assert.equal(changeText(0.004), "지금과 같음");
  assert.equal(monthlyChange({ projection: null }, { projection: GCP }), null);
});

test("환경 목록 한 마디: 정상은 월 추산, 일부만 셌으면 주의, 계산 못 하면 짧은 이유, 404 는 말하지 않음", () => {
  assert.deepEqual(envCostCaption(env({})), { text: "월 $307.40 추산", warn: false });
  assert.deepEqual(envCostCaption(env({ status: "partial", reason: "일부 자원을 읽지 못해…" })), { text: "월 $307.40 추산 · 일부만 셈", warn: true });
  assert.deepEqual(envCostCaption(env({ status: "unavailable", reason: "실자원을 아직 읽지 않았습니다", projection: null })), { text: "비용 모름 · 실자원을 아직 읽지 않았습니다", warn: false });
  assert.equal(envCostCaption(null), null, "읽는 중이거나 404");
  assert.deepEqual(envCostCaption(null, true), { text: "월 비용을 읽지 못함", warn: false });
  // 늘 받는 할인이 있는 환경(GKE 무료 등급)은 할인 뒤 한 달
  assert.equal(envCostCaption(env({ provider: "gcp", projection: GCP }))?.text, "월 $203.83 추산");
});

test("월 비용 카드 머리줄 요약", () => {
  assert.equal(envCostSummary(null, true), "읽는 중");
  assert.equal(envCostSummary(null, false), "읽지 못함");
  assert.equal(envCostSummary(env({}), false), "$307.40/월");
  assert.equal(envCostSummary(env({ status: "partial" }), false), "$307.40/월 · 일부만");
  assert.equal(envCostSummary(env({ status: "unavailable", projection: null }), false), "계산 못 함");
});

const line = (id: string, group: CostLine["group"], monthlyUsd: number): CostLine => ({
  id, group, label: id, quantity: 1, quantityUnit: "개", hours: 730, monthlyUsd, formula: "f",
  basis: { kind: "inventory", text: "t", refs: [] },
  price: { item: "instance", sku: "s", unitUsd: 1, unit: "hour", evidence: "fact", sourceKind: "official_api", source: "src", sourceUrl: null, fetchedAt: "2026-11-06T02:36:04.833Z" },
});

test("줄 묶기: 묶음 순서는 고정, 묶음 안은 금액이 큰 줄부터, 소계는 센트로, 모르는 묶음은 끝에", () => {
  const groups = lineGroups([
    line("nat", "network", 43.07), line("disk", "storage", 3.65), line("eks", "cluster", 73), line("ip", "network", 10.95),
    line("dbs", "storage", 2.62), line("alb", "network", 16.43), line("x", "gpu" as CostLine["group"], 1),
  ]);
  assert.deepEqual(groups.map((g) => g.group), ["cluster", "storage", "network", "gpu"]);
  assert.deepEqual(groups.find((g) => g.group === "network")!.lines.map((l) => l.id), ["nat", "alb", "ip"]);
  assert.equal(groups.find((g) => g.group === "network")!.monthlyUsd, 70.45);
  assert.equal(groups.find((g) => g.group === "storage")!.monthlyUsd, 6.27);
  assert.equal(groups.at(-1)!.label, "gpu");
});

test("프로모션 나누기: 적용 / 조건부(금액 있음) / 신청 필요(금액 0) / 해당 없음", () => {
  const na = promo({ id: "na", status: "not_applicable", note: "이 견적과 상관없음" });
  const b = promoBuckets([...GCP.promotions, na]);
  assert.deepEqual(b.applied.map((p) => p.id), ["gcp-gke-free-tier"]);
  assert.deepEqual(b.conditional.map((p) => p.id), ["gcp-free-trial-300"]);
  assert.deepEqual(b.request.map((p) => p.id), ["gcp-startups-start", "aws-exit-data-transfer"]);
  assert.deepEqual(b.notApplicable.map((p) => p.id), ["na"]);
  assert.equal(promoAmount(FREE_TIER), "1년 -$876.00");
  assert.equal(promoAmount(TRIAL), "1년 -$300.00");
  assert.equal(promoAmount(STARTUPS), "금액에 넣지 않음");
  assert.equal(promoAmount(na), "금액 없음");
  assert.equal(promoSummary([...GCP.promotions, na]), "적용 1 · 조건부 3 · 해당 없음 1");
  assert.equal(promoSummary([]), "없음");
});

test("근거 표시: 가정한 수량만 꼬리표, 문장에 이미 있는 자원 이름은 다시 안 씀, 출처 날짜는 한 번만", () => {
  assert.equal(basisTag("inventory"), null);
  assert.equal(basisTag("assumption")?.label, "수량 가정");
  assert.deepEqual(extraRefs({ text: "실자원 조회에서 클러스터 1개", refs: ["shop-eks"] }), ["shop-eks"]);
  assert.deepEqual(extraRefs({ text: "shop-db 저장 공간", refs: ["shop-db"] }), []);
  assert.equal(sourceLine({ source: "AWS Price List Bulk AmazonEKS", fetchedAt: "2026-11-06T02:36:04.833Z" }), "AWS Price List Bulk AmazonEKS · 2026-11-06 확인");
  assert.equal(sourceLine({ source: "Google Cloud 공식 가격 페이지 (서울, 2026-11-06 확인)", fetchedAt: "2026-11-06T02:36:04.833Z" }), "Google Cloud 공식 가격 페이지 (서울, 2026-11-06 확인)");
});

test("POST /cost/move 본문: 도착은 겹치지 않게 10개까지, 빈 범위는 싣지 않음", () => {
  const ids = Array.from({ length: 12 }, (_, i) => `id-${i}`);
  assert.equal(moveCostBody([...ids, "id-0"], {}).targetEnvIds.length, 10);
  assert.deepEqual(moveCostBody(["a", "b", "a"], {}), { targetEnvIds: ["a", "b"] });
  assert.deepEqual(moveCostBody(["a"], { cluster: "shop-eks", namespaces: ["shop"] }), { targetEnvIds: ["a"], sourceScope: { cluster: "shop-eks", namespaces: ["shop"] } });
});

test("같은 환경 비용 요청을 잠깐 동안 하나로 묶고, 실패하면 잊는다", async () => {
  let now = 0;
  let calls = 0;
  let fail = false;
  const get = shareRecent(async (key: string) => {
    calls++;
    if (fail) throw new Error("down");
    return `${key}#${calls}`;
  }, 5000, () => now);
  const first = get("aws");
  assert.equal(get("aws"), first, "5초 안의 같은 열쇠는 같은 요청");
  assert.notEqual(get("gcp"), first, "다른 열쇠는 따로");
  assert.equal(await first, "aws#1");
  now = 6000;
  assert.equal(await get("aws"), "aws#3", "5초가 지나면 새로 묻는다");
  fail = true;
  now = 20_000;
  await assert.rejects(get("aws"));
  fail = false;
  assert.equal(await get("aws"), "aws#5", "실패한 요청은 묶어 두지 않는다");
});
