// TA3 비용: 계획서의 비용 요약·확인 항목은 v2 명세로 센다. 가격표에 없는 구성요소는 unknownFields 와 고지 문구에 이름으로
import { test } from "node:test";
import assert from "node:assert/strict";
import { AppSpecV2, PlanDoc, type PlanCostSummary, type Provider } from "@svc/contracts";
import { loadSampleCatalog } from "@svc/cost";
import { buildAcknowledgements, buildPlanDoc, estimatePlanCost } from "../src/jobs/plan.js";

type Raw = Record<string, any>;
const catalog = loadSampleCatalog();   // 금액을 고정하려고 샘플 가격표 (진짜 계획은 loadCatalog)
// 데모 명세 (shop 서비스 1개 + postgres 1개)
const BASE: AppSpecV2 = AppSpecV2.parse({"schemaVersion":"2","app":{"name":"shop"},"components":[{"id":"shop","kind":"service","props":{"runtime":"k8s","origin":{"runtime":"k8s","product":"unknown"},"image":{"source":"registry","repository":"r/shop","digest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"ports":[{"port":8080,"protocol":"TCP"}],"probes":{"readiness":{"type":"http","path":"/healthz","port":8080}},"replicas":{"min":1,"max":1},"serviceAccount":"default","resources":{"request":{"cpuMilli":500,"memMiB":1024}},"env":[]}},{"id":"db","kind":"postgres","props":{"majorVersion":"16","storageGb":20}}],"links":[{"from":"shop","to":"db","intent":"connect"}],"entry":{"via":"cloudflare-lb","hosts":[{"hostnames":["s.example.com"],"routes":[{"matches":[{"path":{"type":"PathPrefix","value":"/"}}],"backends":[{"to":"shop","port":8080,"weight":1}]}]}]},"posture":{"permissions":[],"network":[]}});
const v2 = (mut: (s: Raw) => void = () => {}): AppSpecV2 => {
  const s: Raw = structuredClone(BASE);
  mut(s);
  return AppSpecV2.parse(s);
};
const svc = (s: Raw) => s.components.find((c: Raw) => c.kind === "service");
const base = {
  planId: "7f000000-0000-4000-8000-0000000000c2", migrationId: "4a8c0000-0000-4000-8000-0000000000c2", spec: BASE,
  precheck: [], now: new Date("2026-11-07T00:00:00Z"), source: { provider: "aws" as const }, specVersion: 3,
};
const tgt = (provider: Provider) => ({ envId: "33333333-3333-4333-8333-333333333333", provider, region: "default" });
const planV2 = (spec: AppSpecV2, to: Provider, costSummary: PlanCostSummary) =>
  buildPlanDoc({ ...base, spec, target: tgt(to), costSummary }, {});
const HEAD = "도착 자원은 고객 클라우드 계정에 만들어지고 요금도 고객 계정에 청구됩니다";

// 빠뜨림 없음: v2 Terraform 루트가 만드는 매트릭스 줄은 금액에 들어갔거나(postgres) 이름이 남았거나 요금 없는 줄(namespace·identity)이다
function assertNoSilentOmission(p: PlanDoc): number {
  let checked = 0;
  for (const i of p.instances ?? []) {
    if (i.kind === "postgres" || i.kind === "namespace" || i.kind === "identity") continue;
    const label = `${i.kind === "vm" ? "service" : i.kind}:${i.id}`;
    assert.ok(p.costSummary!.unknownFields.includes(label), `${label} 이 비용에도 unknownFields 에도 없음`);
    checked++;
  }
  return checked;
}

test("캐시·큐·버킷: 합계는 같은 서비스·DB 판과 같고, unknownFields 와 고지 문구에 <종류>:<id> 로 남는다", () => {
  const spec = v2((s) => {
    s.components.push(
      { id: "shop-cache", kind: "cache", props: { engine: "redis", memoryMiB: 1024, tls: true, auth: false, ha: true } },
      { id: "shop-assets", kind: "objectStore", props: { versioning: false, public: false, sizeGb: 50 } },
      { id: "orders", kind: "queue", props: { model: "queue" } });
    for (const to of ["shop-cache", "shop-assets", "orders"]) s.links.push({ from: "shop", to, intent: "connect" });
  });
  const c = estimatePlanCost(spec, "aws", "gcp", catalog);
  assert.deepEqual(c, { currency: "USD", monthlyTarget: 146.9, monthlySource: 227.5, deltaMonthly: -80.6,
    unknownFields: ["cache:shop-cache", "objectStore:shop-assets", "queue:orders"], priceAsOf: catalog.asOf });
  assert.equal(c.monthlyTarget, estimatePlanCost(v2(), "aws", "gcp", catalog).monthlyTarget);
  const p = planV2(spec, "gcp", c);
  assert.equal(PlanDoc.safeParse(p).success, true);
  assert.equal(p.acknowledgements![0]!.text, `예상 월 비용(USD): 도착 gcp $146.9 / 출발 aws $227.5 / 차이 $-80.6. ${HEAD}`
    + ". 일부 자원·설정은 위 금액에 포함되지 않았습니다: cache:shop-cache, objectStore:shop-assets, queue:orders");
  assert.equal(assertNoSilentOmission(p), 3);
});

test("관리형 컨테이너: 서비스는 금액에 없고(ECS Fargate·Cloud Run 가격 없음) 이름으로 남는다, 클러스터·노드는 안 센다", () => {
  const spec = v2((s) => { svc(s).props.runtime = "managedContainer"; svc(s).props.origin = { runtime: "managedContainer", product: "ecs" }; });
  const c = estimatePlanCost(spec, "aws", "gcp", catalog);
  assert.deepEqual([c.monthlySource, c.monthlyTarget, c.deltaMonthly], [78.6, 84.1, 5.5]);   // DB + 스토리지만
  assert.deepEqual(c.unknownFields, ["service:shop"]);
  for (const to of ["aws", "gcp"] as const) {
    const p = planV2(spec, to, c);
    assert.ok(p.instances!.some((i) => i.kind === "service" && i.id === "shop"), to);
    assert.match(p.acknowledgements![0]!.text, /일부 자원·설정은 위 금액에 포함되지 않았습니다: service:shop$/);
    assert.equal(assertNoSilentOmission(p), 1, to);
  }
});

test("서비스 두 개: 둘 다 노드 수에 들어가고, 다 셌으면 '포함되지 않았습니다' 문장이 없다", () => {
  const spec = v2((s) => s.components.push({ id: "worker", kind: "service",
    props: { ...structuredClone(svc(s).props), replicas: { min: 2, max: 2 }, resources: { request: { cpuMilli: 1000, memMiB: 2048 } } } }));
  const c = estimatePlanCost(spec, "aws", "gcp", catalog);
  assert.deepEqual([c.monthlySource, c.monthlyTarget, c.deltaMonthly, c.unknownFields], [265.5, 178.3, -87.2, []]);
  const one = estimatePlanCost(v2(), "aws", "gcp", catalog);
  assert.ok(c.monthlyTarget! > one.monthlyTarget! && c.monthlySource! > one.monthlySource!);
  const p = planV2(spec, "gcp", c);
  assert.equal(p.acknowledgements![0]!.text, `예상 월 비용(USD): 도착 gcp $178.3 / 출발 aws $265.5 / 차이 $-87.2. ${HEAD}`);
  // 비용이 바뀌면 지문도 바뀐다 (본 비용 = 승인한 비용)
  assert.notEqual(p.planHash, planV2(spec, "gcp", one).planHash);
});

test("고지 문구: 계산 못 한 칸·가짜 고정값 표시는 글자 그대로", () => {
  const cost = (unknownFields: string[], stub?: boolean): PlanCostSummary =>
    ({ currency: "USD", monthlyTarget: 80, monthlySource: null, deltaMonthly: null, unknownFields, ...(stub ? { stub } : {}) });
  const text = (c: PlanCostSummary) => buildAcknowledgements({ cost: c, from: "aws", to: "gcp", precheck: [], env: {} })[0]!.text;
  const head = `예상 월 비용(USD): 도착 gcp $80 / 출발 aws 계산 못 함 / 차이 계산 못 함. ${HEAD}`;
  assert.equal(text(cost([])), head);
  assert.equal(text(cost(["monthlySource"])), `${head} (계산 못 한 칸: monthlySource)`);
  assert.equal(text(cost(["monthlySource", "monthlyTarget"], true)), `${head} (계산 못 한 칸: monthlySource, monthlyTarget) (가짜 고정값)`);
  assert.equal(text(cost(["*"])), `${head} (계산 못 한 칸: *)`);
});

test("거부: v2 비용 계산이 실패해도 던지지 않고 unknownFields=['*'] (계획을 막지 않음), 섞인 칸은 따로 적는다", () => {
  const broken = { ...v2(), components: [] } as unknown as AppSpecV2;   // components 최소 1개 위반
  assert.deepEqual(estimatePlanCost(broken, "aws", "gcp", catalog),
    { currency: "USD", monthlyTarget: null, monthlySource: null, deltaMonthly: null, unknownFields: ["*"] });
  const t = buildAcknowledgements({ cost: { currency: "USD", monthlyTarget: null, monthlySource: 1, deltaMonthly: null,
    unknownFields: ["monthlyTarget", "queue:q"] }, from: "aws", to: "gcp", precheck: [], env: {} })[0]!.text;
  assert.match(t, /\(계산 못 한 칸: monthlyTarget\)\. 일부 자원·설정은 위 금액에 포함되지 않았습니다: queue:q$/);
});
