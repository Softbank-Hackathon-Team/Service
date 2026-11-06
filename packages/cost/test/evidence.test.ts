import { test } from "node:test";
import assert from "node:assert/strict";
import { EnvCostView, MoveCostView, type BillingFacts } from "@svc/contracts";
import { cloudSqlShape, envCost, footprintOf, loadCatalog, moveCost, usdText, type EnvForCost, type InventoryForCost } from "../src/index.js";

// 근거 있는 비용 (evidence.ts). 가격표는 저장된 캐시(packages/cost/prices) 그대로: AWS 11/05 발행 공개 파일, GCP 서울 공식 값
const cat = loadCatalog();
const AWS: EnvForCost = { id: "11111111-1111-4111-8111-111111111111", name: "customer-aws", provider: "aws", region: "ap-northeast-2" };
const GCP: EnvForCost = { id: "22222222-2222-4222-8222-222222222222", name: "customer-gcp", provider: "gcp", region: "asia-northeast3" };
const ONPREM: EnvForCost = { id: "33333333-3333-4333-8333-333333333333", name: "onprem", provider: "onprem", region: null };

const facts = (f: Partial<BillingFacts>): BillingFacts =>
  ({ clusters: [], instances: [], databases: [], loadBalancers: [], natGateways: [], addresses: [], errors: [], ...f });
const node = (name: string, type: string, cluster: string | null = "shop-eks", spot = false) =>
  ({ name, type, state: "running", spot, cluster, publicIp: null });

// 데모와 같은 모양: EKS 1 + t3.medium 2대 + RDS db.t3.medium 20GB + 공개 ALB(AZ 2) + NAT 1(EIP)
const awsFacts = facts({
  clusters: [{ name: "shop-eks", location: null, zonal: null, autopilot: null, nodeCount: null, machineTypes: [] }],
  instances: [node("ng-1", "t3.medium"), node("ng-2", "t3.medium")],
  databases: [{ name: "shop-db", engine: "postgres", cls: "db.t3.medium", storageGb: 20, storageType: "gp3", multiAz: false }],
  loadBalancers: [{ name: "shop-alb", type: "application", internetFacing: true, zones: 2 }],
  natGateways: [{ name: "nat-1", state: "available", publicIps: ["3.3.3.3"] }],
  addresses: [{ name: "eip-nat", ip: "3.3.3.3", inUse: true }],
});
const inv = (billing: BillingFacts | undefined, status: InventoryForCost["status"] = "ok"): InventoryForCost =>
  ({ status, reason: status === "unavailable" ? "확인 불가: AWS 자격 없음" : null, checkedAt: "2026-11-06T02:00:00.000Z", groups: [], billing });
const line = (v: EnvCostView | MoveCostView["targets"][number], id: string) => v.breakdown!.lines.find((l) => l.id === id);

test("지금 비용(AWS): 실자원 수량 x 공개 단가 x 730시간, 항마다 근거·출처가 붙고 계약을 통과", () => {
  const v = EnvCostView.parse(envCost(AWS, inv(awsFacts), cat, "ko"));
  assert.equal(v.status, "ok");
  const b = v.breakdown!;
  assert.equal(line(v, "cluster:shop-eks")?.monthlyUsd, 73);                 // 1 x 0.10 x 730
  const nodes = line(v, "node:shop-eks:t3.medium")!;
  assert.equal(nodes.monthlyUsd, 75.92);                                       // 2 x 0.052 x 730
  assert.equal(nodes.formula, "2대 x $0.052/시간 x 730시간");
  assert.deepEqual(nodes.basis.refs, ["ng-1", "ng-2"]);
  assert.equal(nodes.basis.kind, "inventory");
  assert.equal(nodes.price.sourceKind, "official_api");
  assert.match(nodes.price.source, /AWS Price List Bulk AmazonEC2 ap-northeast-2 SKU/);
  assert.equal(line(v, "db:shop-db")?.monthlyUsd, 81.76);                      // 0.112 x 730
  assert.equal(line(v, "db:shop-db:storage")?.monthlyUsd, 2.62);              // 20 x 0.131
  assert.equal(line(v, "nat")?.monthlyUsd, 43.07);                             // 0.059 x 730
  assert.equal(line(v, "ip")?.quantity, 3);                                    // NAT EIP 1 + 공개 ALB AZ 2
  assert.equal(line(v, "node-disk")?.basis.kind, "assumption");               // 디스크 크기는 문서 기본값 20 GiB
  assert.equal(b.monthlyUsd, 307.4);
  assert.equal(r2(b.lines.reduce((a, l) => a + l.monthlyUsd, 0)), b.monthlyUsd);
  // 사용량을 모르는 것은 합계 밖 + 이유
  assert.deepEqual(b.gaps.map((g) => g.id).sort(), ["gap:egress", "gap:lcu", "gap:nat-data"]);
  assert.equal(v.projection!.yearlyUsd, r2(307.4 * 12));
  assert.equal(v.projection!.promotions.length, 0);                            // 이미 쓰는 AWS 계정: 새 계정 크레딧은 안 보임
});

test("옮긴 뒤 비용(AWS → GCP): 같은 크기 이상 중 가장 싼 상품, GKE 무료 등급은 적용됨, 무료 체험은 조건부", () => {
  const mv = MoveCostView.parse(moveCost(AWS, inv(awsFacts), { cluster: "shop-eks" }, [GCP], cat, "ko"));
  const t = mv.targets[0]!;
  assert.ok(t.feasible);
  assert.equal(line(t, "node:t3.medium->e2-medium")?.monthlyUsd, 62.75);     // 2 x 0.04298286 x 730
  assert.equal(line(t, "db:shop-db:vcpu")?.monthlyUsd, 78.4);                 // 2 x 0.0537 x 730
  assert.equal(line(t, "db:shop-db:mem")?.monthlyUsd, 26.57);                 // 4 x 0.0091 x 730
  assert.equal(line(t, "nat")?.quantity, 2);                                   // Cloud NAT 뒤 VM 2대 x $0.0014
  assert.ok(t.mappings.some((m) => m.group === "network" && m.to === null));  // ALB → Cloudflare 터널 (도착에 LB 없음)
  assert.equal(t.breakdown!.monthlyUsd, 276.83);
  const p = t.projection!;
  const gke = p.promotions.find((x) => x.id === "gcp-gke-free-tier")!;
  assert.equal(gke.status, "applied");
  assert.equal(gke.firstYearUsd, 876);                                         // 관리비 73 x 12 (월 한도 74.40 안)
  const trial = p.promotions.find((x) => x.id === "gcp-free-trial-300")!;
  assert.equal(trial.status, "conditional");
  assert.equal(trial.firstYearUsd, 300);
  assert.deepEqual(trial.monthlyUsd.slice(3), Array(9).fill(0));              // 90일 = 첫 3개월 안
  assert.equal(p.appliedMonthlyUsd, 203.83);
  assert.equal(p.appliedYearlyUsd, r2(276.83 * 12 - 876));
  assert.equal(p.conditionalYearlyUsd, r2(276.83 * 12 - 876 - 300));
  // 신청·심사형은 금액 0 + 조건, 출발(AWS)을 떠날 때 전송료 면제도 알린다
  assert.equal(p.promotions.find((x) => x.id === "gcp-ramp")?.firstYearUsd, 0);
  assert.equal(p.promotions.find((x) => x.id === "aws-exit-data-transfer")?.status, "conditional");
  assert.equal(t.deltaMonthlyUsd, r2(307.4 - 276.83));
});

test("옮긴 뒤 비용(AWS → 온프레): 서버 감가·전기·상면은 출처 있는 가정, 회선·운영은 합계 밖", () => {
  const t = moveCost(AWS, inv(awsFacts), undefined, [ONPREM], cat, "ko").targets[0]!;
  assert.deepEqual(t.breakdown!.lines.map((l) => l.id), ["onprem:server", "onprem:power", "onprem:space"]);
  assert.ok(t.breakdown!.lines.every((l) => l.price.sourceKind === "assumption" && l.price.sourceUrl));
  assert.equal(line(t, "onprem:server")?.monthlyUsd, 250);                    // $15,000 / 60개월
  assert.deepEqual(t.breakdown!.gaps.map((g) => g.id), ["onprem:line", "onprem:ops"]);
  assert.equal(t.projection!.appliedYearlyUsd, t.projection!.yearlyUsd);      // 온프레는 프로모션 없음
});

test("범위: 고른 클러스터 밖 VM 은 빼고 알린다, 네임스페이스로는 노드를 못 나눈다고 알린다", () => {
  const f = facts({ ...awsFacts, instances: [...awsFacts.instances, node("bastion", "t3.micro", null), node("other-1", "m5.large", "other-eks")] });
  const mv = moveCost(AWS, inv(f), { cluster: "shop-eks", namespaces: ["shop"] }, [GCP], cat, "ko");
  assert.match(mv.scopeNote ?? "", /클러스터에 속하지 않은 VM 1대/);
  assert.match(mv.scopeNote ?? "", /네임스페이스/);
  assert.equal(mv.source.breakdown!.lines.filter((l) => l.group === "compute").length, 1);   // shop-eks 노드만
  assert.equal(line(mv.targets[0]!, "node:t3.medium->e2-medium")?.quantity, 2);
});

test("거부: 실자원을 못 읽음 → 금액 없이 이유, 도착도 계산 불가", () => {
  const v = envCost(AWS, inv(undefined, "unavailable"), cat, "ko");
  assert.equal(v.status, "unavailable");
  assert.equal(v.breakdown, null);
  assert.match(v.reason ?? "", /AWS 자격 없음/);
  const mv = MoveCostView.parse(moveCost(AWS, inv(undefined, "unavailable"), undefined, [GCP], cat, "ko"));
  assert.equal(mv.targets[0]!.feasible, false);
  assert.equal(mv.targets[0]!.breakdown, null);
});

test("거부: 비용 사실이 없는 예전 조회 결과, 스팟·단가 없는 종류는 합계에 넣지 않는다", () => {
  assert.match(envCost(AWS, inv(undefined), cat, "ko").reason ?? "", /예전 조회 결과/);
  const f = facts({ instances: [node("s-1", "t3.medium", "shop-eks", true), node("x-1", "x2iezn.12xlarge", null)] });
  const v = envCost(AWS, inv(f), cat, "ko");
  assert.equal(v.breakdown!.lines.filter((l) => l.group === "compute").length, 0);
  assert.ok(v.breakdown!.gaps.some((g) => g.id === "gap:spot:t3.medium" && g.estimateUsd === 37.96));   // 정가였다면 1 x 0.052 x 730
  assert.ok(v.breakdown!.gaps.some((g) => g.id === "gap:node:x2iezn.12xlarge"));
});

test("일부 읽기 실패 → partial 과 이유 (합계가 실제보다 낮을 수 있음)", () => {
  const f = facts({ ...awsFacts, errors: ["ec2 describe-instances: AccessDenied"] });
  const v = envCost(AWS, inv(f), cat, "ko");
  assert.equal(v.status, "partial");
  assert.match(v.reason ?? "", /ec2 describe-instances/);
});

test("GCP 지금 비용: 존 GKE 는 무료 등급 적용, 인스턴스 목록이 없으면 노드 풀로 세고, HA Cloud SQL 은 2배", () => {
  const f = facts({
    clusters: [{ name: "gke-1", location: "asia-northeast3-a", zonal: true, autopilot: false, nodeCount: 2, machineTypes: ["e2-standard-2"] }],
    databases: [{ name: "pg", engine: "POSTGRES_16", cls: "db-custom-2-7680", storageGb: 10, storageType: "PD_SSD", multiAz: true }],
    errors: ["compute instances list: PERMISSION_DENIED"],
  });
  const v = envCost(GCP, inv(f), cat, "en");
  const pool = v.breakdown!.lines.find((l) => l.group === "compute")!;
  assert.equal(pool.quantity, 2);
  assert.match(pool.basis.text, /counted from cluster info/);
  assert.equal(line(v, "db:pg:vcpu")?.monthlyUsd, r2(2 * 0.0537 * 730 * 2));
  assert.match(line(v, "db:pg:vcpu")!.formula, /x 2 \(multi-zone\)$/);
  assert.equal(line(v, "db:pg:storage")?.monthlyUsd, r2(10 * 0.221 * 2));
  const gke = v.projection!.promotions.find((p) => p.id === "gcp-gke-free-tier")!;
  assert.equal(gke.status, "applied");
  assert.equal(v.projection!.appliedMonthlyUsd, r2(v.breakdown!.monthlyUsd - 73));
  assert.equal(v.status, "partial");
});

test("거부: 지역 GKE 는 무료 등급 대상 아님, 노드 vCPU 8 넘으면 무료 체험 대상 아님", () => {
  const regional = facts({ clusters: [{ name: "gke-r", location: "asia-northeast3", zonal: false, autopilot: false, nodeCount: null, machineTypes: [] }] });
  const v = envCost(GCP, inv(regional), cat, "ko");
  assert.equal(v.projection!.promotions.find((p) => p.id === "gcp-gke-free-tier")?.status, "not_applicable");
  const big = facts({ ...awsFacts, instances: [node("n1", "m6i.xlarge"), node("n2", "m6i.xlarge"), node("n3", "m6i.xlarge")] });
  const t = moveCost(AWS, inv(big), undefined, [GCP], cat, "ko").targets[0]!;
  assert.equal(t.projection!.promotions.find((p) => p.id === "gcp-free-trial-300")?.status, "not_applicable");
});

test("언어: 같은 계산을 한국어·영어·일본어 문장으로", () => {
  const ko = envCost(AWS, inv(awsFacts), cat, "ko").breakdown!;
  const ja = envCost(AWS, inv(awsFacts), cat, "ja").breakdown!;
  const en = envCost(AWS, inv(awsFacts), cat, "en").breakdown!;
  assert.equal(ja.monthlyUsd, ko.monthlyUsd);
  assert.match(ja.lines[0]!.label, /EKS クラスター管理料金/);
  assert.match(en.lines[0]!.formula, /1 x \$0\.10\/h x 730 h/);
  // 단가 출처 줄도 화면 언어로 (가격표 파일의 한국어 출처 글이 일본어·영어 화면에 그대로 나오지 않게) — AWS·GCP·온프레 모두
  const hangul = /[가-힣]/;
  const mv = moveCost(AWS, inv(awsFacts), undefined, [GCP, ONPREM], cat, "ja");
  const all = [ja, en, ...mv.targets.map((t) => t.breakdown!)].flatMap((b) => b.lines);
  for (const l of all) assert.ok(!hangul.test(l.price.source), `${l.id}: ${l.price.source}`);
  assert.match(ja.lines[0]!.price.source, /AWS Price List Bulk AmazonEKS ap-northeast-2 SKU \S+ \(公開 /);
  assert.match(mv.targets[0]!.breakdown!.lines[0]!.price.source, /^Google Cloud 公式料金ページ · gke-management · asia-northeast3 \(2026-11-06 確認\)$/);
  assert.equal(ko.lines[0]!.price.source.includes("발행"), true);   // 한국어는 가격표 원문 그대로
  // 온프레 대응 근거는 노드와 DB 를 합친 값이라고 말한다 (t3.medium 2대 4 vCPU + db.t3.medium 2 vCPU = 6)
  assert.match(mv.targets[1]!.mappings[0]!.why, /出発ノードと DB の vCPU 合計 6/);
});

test("자원 모양 도우미: Cloud SQL 등급 이름, 금액 표기", () => {
  assert.deepEqual(cloudSqlShape("db-custom-2-7680"), { vcpu: 2, memGiB: 7.5 });
  assert.deepEqual(cloudSqlShape("db-n1-standard-1"), { vcpu: 1, memGiB: 3.75 });
  assert.equal(cloudSqlShape("db-f1-micro"), null);                           // 공유 코어: 서울 단가 미확인 → 합계 밖
  assert.equal(usdText(0.1), "$0.10");
  assert.equal(usdText(0.04298286), "$0.043");
  assert.equal(usdText(1234.5), "$1,234.50");
  const fp = footprintOf("aws", facts({ addresses: [{ name: "idle", ip: "9.9.9.9", inUse: false }] }));
  assert.deepEqual(fp.ipsIdle, ["9.9.9.9"]);
});

function r2(x: number) { return Math.round(x * 100) / 100; }
