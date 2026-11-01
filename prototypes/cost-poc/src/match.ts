import { readFileSync } from "node:fs";
import type { PriceFile, PriceLine, VendorId } from "./collect/types.js";
import type { DbClass, NodeTypeInput, VendorPricingInput } from "./core/types.js";

// DRAFT(ai): 수집한 가격 줄을 계산 코어 입력(VendorPricing)으로 바꾼다. 네트워크 없음.
//
// 비슷한 사양 매칭 규칙
//  1. 온디맨드, Linux, x86, 공유 테넌시만. ARM(Graviton, Tau T2A, Dpsv5)은 이미지 호환을 따로 봐야 해서 뺐다.
//  2. 벤더별로 범용(1:4), 컴퓨트(1:2 또는 1:1), 메모리(1:8), 버스터블 계열을 모두 후보로 두고 C_v의 min이 고른다.
//     즉 "같은 이름의 상품"이 아니라 "필요한 자원을 담는 가장 싼 조합"을 비교한다.
//  3. vCPU는 벤더 표기를 그대로 비교한다. x86 vCPU는 모두 하이퍼스레드 1개지만 세대와 클럭이 달라 성능이 같지 않다.
//     이 차이는 cpuPerf로 보정할 수 있고, 기본은 1(가정)이다.
//  4. 버스터블은 사용량 기준 용량을 기준선(sustained)으로 낮춘다. t3.medium의 지속 용량은 2가 아니라 0.4 vCPU다.
//     스케줄러가 보는 요청량(cpuRequested)만 전체 vCPU로 담는다.
//  5. a_{v,k}는 노드 전체가 아니라 할당 가능량이다 (벤더 문서의 예약 공식 적용).
//  한계: 네트워크·디스크 성능, 메모리 대역폭, 관리형 DB의 내부 오버헤드와 IOPS 차이는 맞추지 못한다.

const mibToGib = (m: number) => m / 1024;

// GKE·EKS 공통 CPU 예약 표 (https://docs.cloud.google.com/kubernetes-engine/docs/concepts/plan-node-sizes)
export function reservedCpuTiered(vcpu: number): number {
  let r = 0.06 * Math.min(vcpu, 1);
  if (vcpu > 1) r += 0.01 * (Math.min(vcpu, 2) - 1);
  if (vcpu > 2) r += 0.005 * (Math.min(vcpu, 4) - 2);
  if (vcpu > 4) r += 0.0025 * (vcpu - 4);
  return r;
}

// GKE 메모리 예약 (같은 문서, 1.36 이하 표. 1.37 이상은 이보다 작을 수 있어 보수적)
export function reservedMemGke(mem: number): number {
  let r = 0.25 * Math.min(mem, 4);
  if (mem > 4) r += 0.2 * (Math.min(mem, 8) - 4);
  if (mem > 8) r += 0.1 * (Math.min(mem, 16) - 8);
  if (mem > 16) r += 0.06 * (Math.min(mem, 128) - 16);
  if (mem > 128) r += 0.02 * (mem - 128);
  return r + mibToGib(100);
}

// EKS AMI 기본: 11MiB x maxPods + 255MiB, 축출 100MiB
const EKS_MAX_PODS: Record<string, number> = {
  large: 29, xlarge: 58, "2xlarge": 58, "4xlarge": 234, medium: 17,
};
export function reservedMemEks(sku: string): number {
  const size = sku.split(".")[1] ?? "large";
  const maxPods = sku === "t3.large" ? 35 : EKS_MAX_PODS[size] ?? 29;
  return mibToGib(11 * maxPods + 255 + 100);
}

// AKS 1.29+ (https://learn.microsoft.com/azure/aks/node-resource-reservations): min(20MB x maxPods + 50MB, 25%) + 축출 100Mi. maxPods 30 가정
export function reservedMemAks(mem: number): number {
  return Math.min((20 * 30 + 50) / 1000, 0.25 * mem) + mibToGib(100);
}
const AKS_CPU: [number, number][] = [[1, 0.06], [2, 0.1], [4, 0.14], [8, 0.18], [16, 0.26], [32, 0.42], [64, 0.74]];
export function reservedCpuAks(vcpu: number): number {
  for (const [c, r] of AKS_CPU) if (vcpu <= c) return r;
  return 0.74;
}

export type MatchOptions = {
  nodeDiskGB?: number;              // 노드 부팅 디스크 (가정). p_v에 더한다
  cpuPerf?: Partial<Record<VendorId, number>> | undefined;  // 벤더별 CPU 성능 배수 (기본 1, 가정)
  includeLb?: boolean;              // 로드 밸런서를 F_v에 넣을지 (기본 제외: AppSpec ingress가 cloudflare-lb)
  useCommit1y?: boolean;            // 1년 약정 단가 사용 (가격 수집된 줄만)
  applyGkeCredit?: boolean;         // 기본 제외: 결제 계정당 클러스터 1개에만 적용되는 무료 등급
  awsFreeEgressGB?: number;         // AWS 전역 무료 100GB (공개 블로그)
  onpremMinServers?: number;
  onpremMaxEgressGBh?: number;
  excludeBurstable?: boolean;
  gcpFreeTierMonthlyCredit?: number;
  includeNat?: boolean;             // 비공개 서브넷 + cloudflared 터널: 응답이 NAT를 지난다
};

const need = (c: PriceFile, item: PriceLine["item"]) => c.lines.filter((l) => l.item === item);

export function fileToPricing(f: PriceFile, o: MatchOptions = {}): VendorPricingInput {
  const v = f.vendor;
  const diskGB = o.nodeDiskGB ?? 50;
  const perf = o.cpuPerf?.[v] ?? 1;
  const disk = need(f, "disk")[0];
  const diskHourly = disk ? (disk.usd * diskGB) / 730 : 0;
  const cluster = need(f, "cluster");
  const lb = need(f, "lb")[0];
  const fixedItems = cluster.map((c) => ({ name: c.sku, hourly: c.usd }));
  if (o.includeLb && lb) fixedItems.push({ name: lb.sku, hourly: lb.usd });

  const natH = need(f, "nat").find((n) => n.sku === "nat-hour");
  const natD = need(f, "nat").find((n) => n.sku === "nat-data");
  if (o.includeNat && natH) fixedItems.push({ name: "nat", hourly: natH.usd });
  const natPerGB = o.includeNat ? (natD?.usd ?? 0) : 0;

  const nodeLines = need(f, "node").filter((l) => !(o.excludeBurstable && l.attrs?.burstable));
  const nodeTypes: NodeTypeInput[] = nodeLines.map((l) => {
    const vcpu = l.attrs!.vcpu!; const mem = l.attrs!.memGiB!;
    let resCpu = 0; let resMem = 0;
    if (v === "gcp") { resCpu = reservedCpuTiered(vcpu); resMem = reservedMemGke(mem); }
    if (v === "aws") { resCpu = reservedCpuTiered(vcpu); resMem = reservedMemEks(l.sku); }
    if (v === "azure") { resCpu = reservedCpuAks(vcpu); resMem = reservedMemAks(mem); }
    if (v === "onprem") { resCpu = 2; resMem = 8; } // 가정: 서버당 OS·k3s 몫
    const alloc = vcpu - resCpu;
    const sustained = l.attrs!.burstable ? Math.min(l.attrs!.sustainedVcpu!, alloc) : alloc;
    const price = o.useCommit1y && l.commit1yHourly !== undefined ? l.commit1yHourly : l.usd;
    return {
      sku: l.sku, hourly: price + diskHourly,
      ...(l.commit1yHourly !== undefined ? { commit1yHourly: l.commit1yHourly + diskHourly } : {}),
      capacity: { cpu: sustained * perf, cpuRequested: alloc, mem: mem - resMem, gpu: 0 },
      ...(l.attrs!.family ? { family: l.attrs!.family } : {}),
    };
  });

  const dbClasses: DbClass[] = need(f, "db").filter((l) => !(o.excludeBurstable && l.attrs?.burstable)).map((l) => ({
    sku: l.sku, hourly: o.useCommit1y && l.commit1yHourly !== undefined ? l.commit1yHourly : l.usd,
    ...(l.commit1yHourly !== undefined ? { commit1yHourly: l.commit1yHourly } : {}),
    capacity: { cpu: l.attrs!.burstable ? l.attrs!.sustainedVcpu! : l.attrs!.vcpu!, mem: l.attrs!.memGiB! },
  }));

  const egress = need(f, "egress");
  const paid = egress.filter((e) => e.usd > 0).sort((a, b) => (a.tierFromGB ?? 0) - (b.tierFromGB ?? 0));
  let tiers = egress.map((e) => ({ fromGB: e.tierFromGB ?? 0, usdPerGB: e.usd })).sort((a, b) => a.fromGB - b.fromGB);
  // AWS 전역 무료 100GB는 계단표 밖에 있다: 앞에 무료 칸을 끼운다
  const free = v === "aws" ? (o.awsFreeEgressGB ?? 100) : 0;
  if (free > 0) tiers = [{ fromGB: 0, usdPerGB: 0 }, ...tiers.map((t) => ({ fromGB: t.fromGB + free, usdPerGB: t.usdPerGB }))];

  const evidenceOf = (ls: PriceLine[]) => [...new Set(ls.map((l) => l.evidence))].join("+") || "missing";
  const out: VendorPricingInput = {
    vendor: v,
    region: f.region,
    residency: "KR",
    fixedHourly: fixedItems.reduce((a, b) => a + b.hourly, 0),
    fixedItems,
    monthlyCreditUsd: v === "gcp" && o.applyGkeCredit ? (o.gcpFreeTierMonthlyCredit ?? 74.4) : 0,
    nodeTypes,
    dbClasses,
    dbOnNodes: v === "onprem",
    dbReplicasOnNodes: v === "onprem" ? 2 : 1,
    storagePerGBMonth: need(f, "storage")[0]?.usd ?? 0,
    egressPerGB: (paid[0]?.usd ?? 0) + natPerGB,
    egressTiers: tiers.map((t) => ({ ...t, usdPerGB: t.usdPerGB + natPerGB })),
    minNodes: v === "onprem" ? (o.onpremMinServers ?? 2) : 2,
    ...(v === "onprem" ? { maxEgressGBh: o.onpremMaxEgressGBh ?? 450 } : {}),
    unknownItems: [],
    evidence: {
      node: evidenceOf(nodeLines), db: evidenceOf(need(f, "db")), storage: evidenceOf(need(f, "storage")),
      egress: evidenceOf(egress), fixed: evidenceOf(cluster),
    },
  };
  return out;
}

export function loadPriceFiles(dir: URL = new URL("../data/prices/", import.meta.url)): PriceFile[] {
  return (["aws", "gcp", "azure", "onprem"] as const).map((v) => JSON.parse(readFileSync(new URL(`${v}.json`, dir), "utf8")) as PriceFile);
}

export function loadPricing(o: MatchOptions = {}, dir?: URL): VendorPricingInput[] {
  return loadPriceFiles(dir).map((f) => fileToPricing(f, o));
}
