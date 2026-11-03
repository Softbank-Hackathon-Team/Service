import { AppSpecV2, type ComponentV2, type Provider } from "@svc/contracts";
import { HOURS_PER_MONTH, rowsFor, tieredCost } from "./catalog.js";
import { monthly, type EnvCalc } from "./estimate.js";
import { nodesFor } from "./load.js";
import {
  CostEstimateRequest, type CostParts, type EnvEstimate, type LoadParams, type PriceCatalog, type PriceItem, type PriceRow,
} from "./schema.js";

// DRAFT(ai): 공통 명세 v2 → 환경별 월 비용 (PLAN_IR=v2 계획서의 비용 고지용).
//   원칙: 가격표(PriceItem)에 줄이 있는 덩어리만 합계에 넣는다. 단가를 지어내지 않고, 못 넣은 구성요소·칸은 unknown 에 이름을 남긴다.
//   넣는 것   = k8s 서비스(노드 수 + 클러스터 관리비·크레딧), postgres(DB 단가 + 스토리지 GB), 온프레 고정비
//   못 넣는 것 = cache·objectStore·queue·job·관리형 컨테이너(ECS Fargate·Cloud Run)·VM 서비스 → "<종류>:<id>"
//               postgres ha·readReplicas·compute, 요청량을 모르는 k8s 서비스 → "<종류>:<id>.<칸>"
//   식은 v1 estimateEnv 와 같다 → upconvertV1 판은 v1 과 같은 금액

type Svc = Extract<ComponentV2, { kind: "service" }>;
type Pg = Extract<ComponentV2, { kind: "postgres" }>;
type Amount = { cpuMilli: number | null; memMiB: number | null };
type Res = { request?: Amount; limit?: Amount };

export type EnvCtxV2 = { catalog: PriceCatalog; region: string; load: LoadParams; applyCredits: boolean };

/** 합계에 안 들어간 구성요소·칸 이름. "<종류>:<id>" 또는 "<종류>:<id>.<칸>" (가격표 덩어리 이름 cluster·node 등과 달리 콜론이 있다) */
export const unpricedLabel = (kind: string, id: string, field?: string) => `${kind}:${id}${field ? `.${field}` : ""}`;

const r1 = (x: number) => Math.round(x * 10) / 10;
const sumParts = (p: CostParts) => p.cluster + p.nodes + p.db + p.storage + p.fixed;

// k8s 규칙: request 가 없으면 limit 이 request 가 된다 (칸마다 따로). 둘 다 없으면 모름
const requested = (r: Res, k: keyof Amount) => r.request?.[k] ?? r.limit?.[k] ?? null;

// k8s 서비스 하나가 노드에 잡는 양 = 복제 수 x (주 컨테이너 + 주입 아닌 사이드카). 모르는 칸이 있으면 known=false (아는 몫만 더함)
// DRAFT(ai): 복제 수는 min (평상시). 자동 확장으로 늘어나는 몫은 피크 rps 부하식이 대신 본다. init 컨테이너는 시작 때만 돌아 뺀다.
//   주입 사이드카(injected)는 도착 메시가 다시 넣으므로 이 앱 몫으로 안 센다 (Helm 값도 안 넣음)
function podDemand(s: Svc): { cpuMilli: number; memMiB: number; known: boolean } {
  const containers: Res[] = [s.props.resources, ...(s.props.sidecars ?? []).filter((c) => !c.injected).map((c) => c.resources)];
  let cpu = 0, mem = 0, known = true;
  for (const r of containers) {
    const c = requested(r, "cpuMilli"), m = requested(r, "memMiB");
    if (c === null || m === null) known = false;
    cpu += c ?? 0;
    mem += m ?? 0;
  }
  const n = s.props.replicas.min;
  return { cpuMilli: cpu * n, memMiB: mem * n, known };
}

// 환경 하나. v1 estimateEnv 와 같은 순서·같은 식 (노드 종류 전수 탐색, 온프레 용량, 크레딧)
export function estimateEnvV2(provider: Provider, spec: AppSpecV2, rps: number, c: EnvCtxV2): EnvCalc {
  const unknown = new Set<string>();
  const unverified = new Set<string>();
  const pick = (item: PriceItem) => rowsFor(c.catalog, provider, c.region, item);
  // 실제로 쓴 줄의 근거만 본다 (v1 과 같음)
  const used = (r: PriceRow | undefined) => {
    if (r && r.evidence !== "fact") unverified.add(r.item);
    return r;
  };

  // DRAFT(ai): 출발도 같은 명세·같은 실행 방식(props.runtime)으로 센다. v1 과 같은 "같은 앱을 두 환경에 놓으면" 비교이고,
  //   출발의 실제 실행 방식(origin)으로 따로 세지 않는다 → 두 환경의 못 넣은 목록이 같아 고지 한 줄로 합칠 수 있다
  const k8s: Svc[] = [];
  const pgs: Pg[] = [];
  for (const x of spec.components) {
    if (x.kind === "service" && x.props.runtime === "k8s") k8s.push(x);
    else if (x.kind === "postgres") pgs.push(x);
    else unknown.add(unpricedLabel(x.kind, x.id));   // 가격표에 줄 없음 (k8s CronJob 도 노드 수에 안 넣으니 여기)
  }

  // k8s 수요 = v1 requiredVcpu·requiredMemGiB 를 서비스 합으로. 부하식은 앱 전체에 한 번 (들어오는 트래픽은 하나)
  let cpuMilli = 0, memMiB = 0;
  for (const s of k8s) {
    const d = podDemand(s);
    if (!d.known) unknown.add(unpricedLabel("service", s.id, "resources"));
    cpuMilli += d.cpuMilli;
    memMiB += d.memMiB;
  }
  const needVcpu = Math.max(c.load.baseVcpu + c.load.vcpuPerRps * rps, cpuMilli / 1000);
  const needMem = memMiB / 1024;

  // 가격표 DB 줄은 크기 하나뿐이고 배수(다중 영역·읽기 복제)가 없다 → 그 칸은 금액에 반영 안 됨
  for (const p of pgs) {
    if (p.props.ha === true) unknown.add(unpricedLabel("postgres", p.id, "ha"));
    if ((p.props.readReplicas ?? 0) > 0) unknown.add(unpricedLabel("postgres", p.id, "readReplicas"));
    if (p.props.compute && (p.props.compute.cpuMilli !== null || p.props.compute.memMiB !== null))
      unknown.add(unpricedLabel("postgres", p.id, "compute"));
  }

  const empty: CostParts = { cluster: 0, nodes: 0, db: 0, storage: 0, fixed: 0 };
  const fail = (reason: string, extra: string[], evaluated: number): EnvCalc => ({
    provider, feasible: false, reason, nodeSku: null, nodes: 0,
    monthlyUsd: Infinity, monthlyUsdNoCredit: Infinity, creditUsd: 0, parts: empty,
    unknown: [...new Set([...unknown, ...extra])].sort(), unverified: [...unverified].sort(), candidatesEvaluated: evaluated,
  });
  const nodeRows = k8s.length ? pick("node").filter((r) => r.attrs.vcpu && r.attrs.memGiB) : [];
  if (k8s.length && nodeRows.length === 0) return fail("PRICE_MISSING", ["node"], 0);

  const fixedRow = pick("fixed")[0];
  const capVcpu = fixedRow?.attrs.capVcpu;
  const base: Omit<CostParts, "nodes"> = { cluster: 0, db: 0, storage: 0, fixed: 0 };
  let credit = 0;
  if (provider === "onprem") {
    // 온프레: 고정비에 클러스터·DB(CloudNativePG)·스토리지가 다 들어 있다 【추정】 (v1 과 같음)
    if (used(fixedRow)) base.fixed = fixedRow!.usd; else unknown.add("fixed");
  } else {
    // k8s 워크로드가 없으면(관리형·VM 만) 클러스터·노드를 안 쓴다 → 관리비도 안 센다
    if (k8s.length) {
      const cl = used(pick("cluster")[0]);
      if (cl) base.cluster = monthly(cl); else unknown.add("cluster");
      const cr = used(pick("cluster_credit")[0]);
      if (cr) credit = Math.min(cr.usd, base.cluster);
    }
    const db = pick("db")[0];
    const st = pick("storage");
    for (const p of pgs) {
      if (used(db)) base.db += monthly(db!); else unknown.add(unpricedLabel("postgres", p.id));
      if (p.props.storageGb === null || !st.length) unknown.add(unpricedLabel("postgres", p.id, "storageGb"));
      else { st.forEach(used); base.storage += tieredCost(st, p.props.storageGb); }
    }
  }

  let best: { row: PriceRow; nodes: number; nodeCost: number } | null = null;
  let evaluated = 0;
  for (const r of nodeRows) {
    evaluated++;
    const node = { vcpu: r.attrs.vcpu!, memGiB: r.attrs.memGiB! };
    const n = nodesFor(needVcpu, needMem, node, c.load);
    if (n > c.load.maxNodes) continue;
    if (capVcpu !== undefined && n * node.vcpu > capVcpu) continue; // 서버 증설 필요
    const nodeCost = n * r.usd * HOURS_PER_MONTH;
    if (!best || nodeCost < best.nodeCost) best = { row: r, nodes: n, nodeCost };
  }
  if (k8s.length && !best) return fail(capVcpu !== undefined ? "ONPREM_CAPACITY_EXCEEDED" : "NODE_LIMIT_EXCEEDED", [], evaluated);
  if (best) used(best.row);

  const parts: CostParts = { ...base, nodes: best?.nodeCost ?? 0 };
  const noCredit = sumParts(parts);
  const applied = c.applyCredits ? credit : 0;
  return {
    provider, feasible: true, nodeSku: best?.row.sku ?? null, nodes: best?.nodes ?? 0,
    monthlyUsd: noCredit - applied, monthlyUsdNoCredit: noCredit, creditUsd: applied,
    parts: { ...parts, cluster: parts.cluster - applied },
    unknown: [...unknown].sort(), unverified: [...unverified].sort(), candidatesEvaluated: evaluated,
  };
}

// 리전·크레딧·부하 계수는 비용 API(CostEstimateRequest)의 기본값을 그대로 쓴다
const DEFAULTS = CostEstimateRequest.pick({ region: true, applyCredits: true, load: true }).parse({});

/** 공개 진입점: v2 명세 + 피크 rps → 환경별 월 비용. 반올림은 estimateCost 와 같다 (금액·덩어리 소수 첫째 자리, 불가능하면 null) */
export function estimateCostV2(
  input: { spec: AppSpecV2; providers: Provider[]; peakRps: number }, catalog: PriceCatalog,
): { priceAsOf: string; peakRps: number; envs: EnvEstimate[] } {
  const spec = AppSpecV2.parse(input.spec);
  const ctx: EnvCtxV2 = { catalog, ...DEFAULTS };
  const envs = [...new Set(input.providers)].map((p) => estimateEnvV2(p, spec, input.peakRps, ctx)).map((e) => ({
    ...e,
    monthlyUsd: Number.isFinite(e.monthlyUsd) ? r1(e.monthlyUsd) : null,
    monthlyUsdNoCredit: Number.isFinite(e.monthlyUsdNoCredit) ? r1(e.monthlyUsdNoCredit) : null,
    creditUsd: r1(e.creditUsd),
    parts: Object.fromEntries(Object.entries(e.parts).map(([k, v]) => [k, r1(v)])) as CostParts,
  }));
  return { priceAsOf: catalog.asOf, peakRps: r1(input.peakRps), envs };
}
