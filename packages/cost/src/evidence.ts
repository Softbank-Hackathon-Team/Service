import type {
  BillingFacts, CostBasis, CostBreakdown, CostGap, CostGroup, CostLine, CostMapping, CostPriceRef,
  EnvCostView, MoveCostTarget, MoveCostView, PriceCatalog, PriceItem, PriceRow, Provider, SourceScope,
} from "@svc/contracts";
import { HOURS_PER_MONTH } from "./catalog.js";
import { fill, usdText, type Lang, type TextKey } from "./evidence-text.js";
import { onpremLines, ONPREM_SERVER, serversFor } from "./onprem-model.js";
import { projectionOf, promotionsFor } from "./promotions.js";

// 근거 있는 비용 내역 (contracts cost-evidence.ts).
//   지금 비용   : 실자원 조회의 비용 사실(BillingFacts) → 자원 모양(Footprint) → 항목(수량 x 단가 x 730시간)
//   옮긴 뒤 비용: 출발 자원 모양 → 도착 상품으로 대응(같은 크기 이상 중 가장 싼 것) + 플랫폼 환경 층이 만드는 것 → 항목
// 원칙: 단가는 가격표 줄에서만 가져오고, 줄이 없거나 사용량을 모르면 합계에 넣지 않고 gaps 에 이유를 남긴다 (지어내지 않음)
// 순수 함수. 네트워크·DB 를 쓰지 않는다

/** 벤더별 기본 가격 리전 (가격표가 서울만 갖고 있다) */
export const PRICE_REGION: Record<Provider, string> = { aws: "ap-northeast-2", gcp: "asia-northeast3", onprem: "local", azure_mock: "koreacentral" };

const r2 = (x: number) => Math.round(x * 100) / 100;

// ---- 가격표 ----

type Prices = { region: string; fallbackFrom: string | null; row: (item: PriceItem, sku?: string) => PriceRow | undefined; rows: (item: PriceItem) => PriceRow[] };

function pricesFor(catalog: PriceCatalog, provider: Provider, region: string | null): Prices {
  const want = region ?? PRICE_REGION[provider];
  const has = catalog.rows.some((r) => r.vendor === provider && r.region === want);
  const reg = has ? want : PRICE_REGION[provider];
  const rows = (item: PriceItem) => catalog.rows.filter((r) => r.vendor === provider && r.region === reg && r.item === item);
  return {
    region: reg, fallbackFrom: !has && region && region !== reg ? region : null, rows,
    row: (item, sku) => rows(item).find((r) => sku === undefined || r.sku === sku),
  };
}

const sourceKindOf = (r: PriceRow): CostPriceRef["sourceKind"] =>
  r.sourceKind ?? (r.evidence === "assumed" || r.evidence === "mock" ? "assumption" : r.source.startsWith("AWS Price List") ? "official_api" : "secondary");

const VENDOR_NAME: Record<Provider, string> = { aws: "AWS", gcp: "Google Cloud", onprem: "On-prem", azure_mock: "Azure (mock)" };

/**
 * 단가 출처 한 줄을 화면 언어로. 가격표 파일(prices/*.json)의 출처 글은 한국어라, 영어·일본어 화면에는
 * 같은 정보(서비스·SKU·발행 시각·확인한 날)를 그 언어 문장으로 다시 만든다. 모르는 모양이면 SKU 와 날짜만
 */
export function sourceText(r: PriceRow, lang: Lang): string {
  if (lang === "ko") return r.source;
  const aws = /^AWS Price List Bulk (\S+) (\S+) SKU (\S+)(?: \(발행 ([^)]+)\))?$/.exec(r.source);
  if (aws) return fill(lang, "srcAws", { svc: aws[1]!, region: aws[2]!, sku: aws[3]! }) + (aws[4] ? fill(lang, "srcPublished", { pub: aws[4] }) : "");
  const cy = /^Cyclenerd pricing\.yml (\S+) \(공식 Cloud Billing Catalog 에서 생성, (.+)\)$/.exec(r.source);
  if (cy) return fill(lang, "srcCyclenerd", { key: cy[1]!, gen: cy[2]! });
  const date = /(\d{4}-\d{2}-\d{2}) 확인/.exec(r.source)?.[1] ?? r.fetchedAt.slice(0, 10);
  if (sourceKindOf(r) === "official_page") return fill(lang, "srcOfficialPage", { vendor: VENDOR_NAME[r.vendor], sku: r.sku, region: r.region, date });
  return fill(lang, "srcGeneric", { sku: r.sku, date });
}

export const priceRef = (r: PriceRow, lang: Lang = "ko"): CostPriceRef => ({
  item: r.item, sku: r.sku, unitUsd: r.usd, unit: r.unit, evidence: r.evidence, sourceKind: sourceKindOf(r),
  source: sourceText(r, lang), sourceUrl: r.sourceUrl ?? null, fetchedAt: r.fetchedAt,
});

type LineIn = { id: string; group: CostGroup; label: string; qty: number; unit: TextKey; row: PriceRow; basis: CostBasis; factor?: number };

function lineOf(lang: Lang, o: LineIn): CostLine {
  const f = o.factor ?? 1;
  const u = fill(lang, o.unit);
  const extra = f !== 1 ? ` x ${fill(lang, "haDouble")}` : "";
  if (o.row.unit === "hour") {
    return {
      id: o.id, group: o.group, label: o.label, quantity: o.qty, quantityUnit: u.trim(), hours: HOURS_PER_MONTH,
      monthlyUsd: r2(o.qty * o.row.usd * HOURS_PER_MONTH * f),
      formula: `${o.qty}${u} x ${usdText(o.row.usd)}${fill(lang, "perHour")} x ${fill(lang, "hours", { h: HOURS_PER_MONTH })}${extra}`,
      basis: o.basis, price: priceRef(o.row, lang),
    };
  }
  const per = o.row.unit === "gb_month" ? fill(lang, "perGbMonth") : fill(lang, "perMonth");
  return {
    id: o.id, group: o.group, label: o.label, quantity: o.qty, quantityUnit: o.row.unit === "gb_month" ? "GB" : u.trim(), hours: null,
    monthlyUsd: r2(o.qty * o.row.usd * f),
    formula: `${o.qty}${o.row.unit === "gb_month" ? " GB" : u} x ${usdText(o.row.usd)}${per}${extra}`,
    basis: o.basis, price: priceRef(o.row, lang),
  };
}

const basis = (kind: CostBasis["kind"], text: string, refs: string[] = []): CostBasis => ({ kind, text, refs });
const noPrice = (lang: Lang, id: string, what: string, sku: string): CostGap =>
  ({ id: `gap:${id}`, label: fill(lang, "gNoPrice", { what }), reason: fill(lang, "gNoPriceWhy", { sku }), estimateUsd: null });

// ---- 자원 모양 ----

export interface NodeGroup { type: string; count: number; names: string[]; cluster: string | null; spot: boolean; from: "instances" | "gkePool" }
export interface DbShape { name: string; cls: string | null; engine: string | null; storageGb: number | null; ha: boolean }
export interface Footprint {
  provider: Provider;
  clusters: { name: string; zonal: boolean | null; autopilot: boolean | null }[];
  nodes: NodeGroup[];
  dbs: DbShape[];
  albs: string[];
  otherLbs: string[];
  lbZoneIps: number;          // AWS 공개 LB 의 영역별 공인 주소 수
  nats: string[];
  natVms: number;             // GCP Cloud NAT 뒤 VM 수
  ipsInUse: string[];
  ipsIdle: string[];
}

function groupNodes(list: { name: string; type: string; spot: boolean; cluster: string | null }[]): NodeGroup[] {
  const m = new Map<string, NodeGroup>();
  for (const i of list) {
    const k = `${i.type}|${i.spot}|${i.cluster ?? ""}`;
    const g = m.get(k) ?? { type: i.type, count: 0, names: [], cluster: i.cluster, spot: i.spot, from: "instances" as const };
    g.count++; g.names.push(i.name);
    m.set(k, g);
  }
  return [...m.values()].sort((a, b) => `${a.cluster}${a.type}`.localeCompare(`${b.cluster}${b.type}`));
}

export function footprintOf(provider: Provider, f: BillingFacts): Footprint {
  const fp: Footprint = { provider, clusters: f.clusters.map((c) => ({ name: c.name, zonal: c.zonal, autopilot: c.autopilot })),
    nodes: groupNodes(f.instances), dbs: f.databases.map((d) => ({ name: d.name, cls: d.cls, engine: d.engine, storageGb: d.storageGb, ha: d.multiAz === true })),
    albs: [], otherLbs: [], lbZoneIps: 0, nats: f.natGateways.map((n) => n.name), natVms: 0, ipsInUse: [], ipsIdle: [] };
  if (provider === "aws") {
    for (const l of f.loadBalancers) {
      if (l.type === "application") fp.albs.push(l.name); else fp.otherLbs.push(l.name);
      if (l.internetFacing) fp.lbZoneIps += l.zones ?? 0;
    }
    const inUse = new Set<string>([...f.instances.map((i) => i.publicIp), ...f.natGateways.flatMap((n) => n.publicIps),
      ...f.addresses.filter((a) => a.inUse).map((a) => a.ip)].filter((x): x is string => !!x));
    fp.ipsInUse = [...inUse];
    // AWS 는 붙지 않은 EIP 도 같은 시간 요금 (Price List IdleAddress $0.005) → 사용 중과 같이 센다
    fp.ipsIdle = f.addresses.filter((a) => !a.inUse && a.ip && !inUse.has(a.ip)).map((a) => a.ip!);
  } else {
    fp.otherLbs = f.loadBalancers.map((l) => l.name);   // GCP 포워딩 규칙
    const instancesRead = !f.errors.some((e) => e.startsWith("compute instances list"));
    if (!instancesRead || f.instances.length === 0) {
      // 인스턴스 목록이 없으면 GKE 클러스터 정보(노드 수 x 노드 풀 머신)로 센다. 머신 종류가 하나일 때만 (여럿이면 나눌 수 없음)
      for (const c of f.clusters) if (c.nodeCount && c.machineTypes.length === 1)
        fp.nodes.push({ type: c.machineTypes[0]!, count: c.nodeCount, names: [], cluster: c.name, spot: false, from: "gkePool" });
    }
    fp.natVms = Math.min(32, f.instances.length || fp.nodes.reduce((a, n) => a + n.count, 0));
    const inUse = new Set<string>([...f.instances.map((i) => i.publicIp), ...f.addresses.filter((a) => a.inUse).map((a) => a.ip)].filter((x): x is string => !!x));
    fp.ipsInUse = [...inUse];
    fp.ipsIdle = f.addresses.filter((a) => !a.inUse).map((a) => a.ip ?? a.name);
  }
  return fp;
}

/** Cloud SQL 등급 이름 → vCPU·메모리. 공유 코어(db-f1-micro, db-g1-small)는 null (단가 미확인) */
export function cloudSqlShape(tier: string | null): { vcpu: number; memGiB: number } | null {
  if (!tier) return null;
  const custom = /^db-(?:custom|perf-optimized-N-\d+)-(\d+)-(\d+)$/.exec(tier);
  if (custom) return { vcpu: Number(custom[1]), memGiB: Number(custom[2]) / 1024 };
  const std = /^db-n1-(standard|highmem)-(\d+)$/.exec(tier);
  if (std) return { vcpu: Number(std[2]), memGiB: Number(std[2]) * (std[1] === "standard" ? 3.75 : 6.5) };
  return null;
}

const isPostgres = (engine: string | null) => engine === null || /postgres/i.test(engine);
const awsDbSku = (cls: string, ha: boolean) => `rds-pg-${ha ? "maz-" : ""}${cls}`;

function nodeShape(p: Prices, type: string): { vcpu: number; memGiB: number; row: PriceRow } | null {
  const row = p.row("instance", type) ?? p.row("node", type);
  return row?.attrs.vcpu && row.attrs.memGiB ? { vcpu: row.attrs.vcpu, memGiB: row.attrs.memGiB, row } : null;
}

function dbShape(p: Prices, provider: Provider, d: DbShape): { vcpu: number; memGiB: number } | null {
  if (!d.cls) return null;
  if (provider === "aws") {
    const row = p.row("db_class", awsDbSku(d.cls, false));
    return row?.attrs.vcpu && row.attrs.memGiB ? { vcpu: row.attrs.vcpu, memGiB: row.attrs.memGiB } : null;
  }
  return provider === "gcp" ? cloudSqlShape(d.cls) : null;
}

// ---- 공통 항목 ----

function egressGaps(lang: Lang, nat: boolean): CostGap[] {
  return [
    { id: "gap:egress", label: fill(lang, "gEgress"), reason: fill(lang, "gEgressWhy"), estimateUsd: null },
    ...(nat ? [{ id: "gap:nat-data", label: fill(lang, "gNatData"), reason: fill(lang, "gNatDataWhy"), estimateUsd: null }] : []),
  ];
}

function dbLines(lang: Lang, p: Prices, provider: Provider, d: { name: string; cls: string; storageGb: number | null; ha: boolean }, b: CostBasis, lines: CostLine[], gaps: CostGap[]) {
  if (provider === "aws") {
    const row = p.row("db_class", awsDbSku(d.cls, d.ha));
    if (row) lines.push(lineOf(lang, { id: `db:${d.name}`, group: "database", label: fill(lang, "db", { product: "RDS PostgreSQL", cls: d.cls, name: d.name }), qty: 1, unit: "uCount", row, basis: b }));
    else gaps.push(noPrice(lang, `db:${d.name}`, `RDS ${d.cls}`, awsDbSku(d.cls, d.ha)));
    const st = p.row("storage", "rds-gp3");
    // RDS 다중 AZ 는 대기 복제본 저장 공간도 내므로 GB 단가가 2배 (가격표 Multi-AZ gp3 = 단일 x 2)
    if (st && d.storageGb) lines.push(lineOf(lang, { id: `db:${d.name}:storage`, group: "storage", label: fill(lang, "dbStorage", { name: d.name }), qty: d.storageGb, unit: "uCount", row: st, basis: b, factor: d.ha ? 2 : 1 }));
    return;
  }
  // GCP Cloud SQL: vCPU·메모리 단가를 따로 곱한다. HA(지역)는 둘 다 2배 (공식 가격표)
  const shape = cloudSqlShape(d.cls);
  const cpu = p.row("db_vcpu"), mem = p.row("db_mem");
  if (shape && cpu && mem) {
    lines.push(lineOf(lang, { id: `db:${d.name}:vcpu`, group: "database", label: fill(lang, "dbVcpu", { product: "Cloud SQL", name: d.name }), qty: shape.vcpu, unit: "uVcpu", row: cpu, basis: b, factor: d.ha ? 2 : 1 }));
    lines.push(lineOf(lang, { id: `db:${d.name}:mem`, group: "database", label: fill(lang, "dbMem", { product: "Cloud SQL", name: d.name }), qty: r2(shape.memGiB), unit: "uGib", row: mem, basis: b, factor: d.ha ? 2 : 1 }));
  } else gaps.push(noPrice(lang, `db:${d.name}`, `Cloud SQL ${d.cls}`, d.cls));
  const st = p.row("storage", "cloudsql-ssd");
  if (st && d.storageGb) lines.push(lineOf(lang, { id: `db:${d.name}:storage`, group: "storage", label: fill(lang, "dbStorage", { name: d.name }), qty: d.storageGb, unit: "uCount", row: st, basis: b, factor: d.ha ? 2 : 1 }));
}

function finish(provider: Provider, p: Prices, lines: CostLine[], gaps: CostGap[], catalog: PriceCatalog, lang: Lang): CostBreakdown {
  if (p.fallbackFrom) gaps.push({ id: "gap:region", label: fill(lang, "gRegion", { region: p.fallbackFrom }), reason: fill(lang, "gRegionWhy", { region: p.fallbackFrom }), estimateUsd: null });
  return { provider, region: p.region, monthlyUsd: r2(lines.reduce((a, l) => a + l.monthlyUsd, 0)), lines, gaps, priceAsOf: catalog.asOf };
}

// ---- 지금 비용 ----

export function currentBreakdown(fp: Footprint, catalog: PriceCatalog, region: string | null, lang: Lang): CostBreakdown {
  const provider = fp.provider;
  const p = pricesFor(catalog, provider, region);
  const lines: CostLine[] = [];
  const gaps: CostGap[] = [];
  const cl = p.row("cluster");
  for (const c of fp.clusters) {
    const b = basis("inventory", fill(lang, "bClusters", { n: 1 }), [c.name]);
    if (cl) lines.push(lineOf(lang, { id: `cluster:${c.name}`, group: "cluster", label: fill(lang, provider === "aws" ? "eks" : "gke", { name: c.name }), qty: 1, unit: "uCount", row: cl, basis: b }));
    if (c.autopilot) gaps.push({ id: `gap:autopilot:${c.name}`, label: fill(lang, "gAutopilot", { name: c.name }), reason: fill(lang, "gAutopilotWhy"), estimateUsd: null });
  }
  let clusterNodes = 0, standalone = 0;
  for (const g of fp.nodes) {
    const shape = nodeShape(p, g.type);
    const text = g.from === "gkePool" ? fill(lang, "bGkePool", { cluster: g.cluster ?? "", n: g.count, type: g.type })
      : fill(lang, provider === "aws" ? "bInstances" : "bGceInstances", { type: g.type, n: g.count });
    const b = basis("inventory", text, g.names);
    if (g.cluster) clusterNodes += g.count; else standalone += g.count;
    if (!shape) { gaps.push(noPrice(lang, `node:${g.type}`, g.type, g.type)); continue; }
    if (g.spot) {
      gaps.push({ id: `gap:spot:${g.type}`, label: fill(lang, "gSpot", { type: g.type, n: g.count }), reason: fill(lang, "gSpotWhy", { usd: r2(g.count * shape.row.usd * HOURS_PER_MONTH) }), estimateUsd: r2(g.count * shape.row.usd * HOURS_PER_MONTH) });
      continue;
    }
    lines.push(lineOf(lang, { id: `node:${g.cluster ?? "-"}:${g.type}`, group: "compute",
      label: g.cluster ? fill(lang, "node", { cluster: g.cluster, type: g.type }) : fill(lang, "vm", { type: g.type }),
      qty: g.count, unit: "uMachines", row: shape.row, basis: b }));
  }
  nodeDiskLines(lang, p, provider, clusterNodes, "assumption", lines);
  if (standalone > 0) gaps.push({ id: "gap:standalone-disk", label: fill(lang, "gStandaloneDisk"), reason: fill(lang, "gStandaloneDiskWhy"), estimateUsd: null });

  for (const d of fp.dbs) {
    const b = basis("inventory", fill(lang, "bDb", { cls: d.cls ?? "?", gb: d.storageGb ?? "?", ha: d.ha ? fill(lang, "bDbHa") : "" }), [d.name]);
    if (!d.cls || !isPostgres(d.engine)) { gaps.push(noPrice(lang, `db:${d.name}`, `${d.engine ?? "DB"} ${d.cls ?? ""}`.trim(), `${d.engine ?? "?"} ${d.cls ?? "?"}`)); continue; }
    dbLines(lang, p, provider, { name: d.name, cls: d.cls, storageGb: d.storageGb, ha: d.ha }, b, lines, gaps);
  }

  if (provider === "aws") {
    const alb = p.row("lb", "alb");
    if (fp.albs.length && alb) {
      lines.push(lineOf(lang, { id: "lb:alb", group: "network", label: fill(lang, "alb"), qty: fp.albs.length, unit: "uCount", row: alb, basis: basis("inventory", fill(lang, "bLb", { n: fp.albs.length }), fp.albs) }));
      const lcu = p.row("lb_capacity");
      gaps.push({ id: "gap:lcu", label: fill(lang, "gLcu"), reason: fill(lang, "gLcuWhy"), estimateUsd: lcu ? r2(fp.albs.length * lcu.usd * HOURS_PER_MONTH) : null });
    }
    for (const n of fp.otherLbs) gaps.push(noPrice(lang, `lb:${n}`, n, "nlb"));
    const nat = p.row("nat");
    if (fp.nats.length && nat) lines.push(lineOf(lang, { id: "nat", group: "network", label: fill(lang, "natAws"), qty: fp.nats.length, unit: "uCount", row: nat, basis: basis("inventory", fill(lang, "bNat", { n: fp.nats.length }), fp.nats) }));
    const ip = p.row("public_ip");
    const ips = fp.ipsInUse.length + fp.lbZoneIps + fp.ipsIdle.length;
    if (ips && ip) lines.push(lineOf(lang, { id: "ip", group: "network", label: fill(lang, "ipInUse"), qty: ips, unit: "uCount", row: ip,
      basis: basis("inventory", fill(lang, "bIps", { a: fp.ipsInUse.length + fp.ipsIdle.length, b: fp.lbZoneIps }), [...fp.ipsInUse, ...fp.ipsIdle]) }));
  } else {
    const fwd = p.row("lb", "forwarding-rule-regional");
    if (fp.otherLbs.length && fwd) {
      // DRAFT(ai): 처음 5개 단가만 곱한다. 6개부터는 $0.015/시간이라 더 싸다 → 5개 넘으면 실제보다 조금 높다
      lines.push(lineOf(lang, { id: "lb:fwd", group: "network", label: fill(lang, "fwd"), qty: fp.otherLbs.length, unit: "uCount", row: fwd, basis: basis("inventory", fill(lang, "bLb", { n: fp.otherLbs.length }), fp.otherLbs) }));
    }
    const nat = p.row("nat");
    if (fp.nats.length && nat && fp.natVms > 0) lines.push(lineOf(lang, { id: "nat", group: "network", label: fill(lang, "natGcp"), qty: fp.nats.length * fp.natVms, unit: "uVm", row: nat,
      basis: basis("inventory", fill(lang, "bGcpNat", { nats: fp.nats.length, n: fp.natVms }), fp.nats) }));
    const ip = p.row("public_ip", "external-ipv4-in-use");
    if (fp.ipsInUse.length && ip) lines.push(lineOf(lang, { id: "ip", group: "network", label: fill(lang, "ipInUse"), qty: fp.ipsInUse.length, unit: "uCount", row: ip,
      basis: basis("inventory", fill(lang, "bIps", { a: fp.ipsInUse.length, b: 0 }), fp.ipsInUse) }));
    const idle = p.row("public_ip", "external-ipv4-unused");
    if (fp.ipsIdle.length && idle) lines.push(lineOf(lang, { id: "ip:idle", group: "network", label: fill(lang, "ipIdle"), qty: fp.ipsIdle.length, unit: "uCount", row: idle,
      basis: basis("inventory", fill(lang, "bIdle", { n: fp.ipsIdle.length }), fp.ipsIdle) }));
  }
  gaps.push(...egressGaps(lang, fp.nats.length > 0));
  return finish(provider, p, lines, gaps, catalog, lang);
}

function nodeDiskLines(lang: Lang, p: Prices, provider: Provider, nodes: number, kind: CostBasis["kind"], lines: CostLine[]) {
  if (nodes <= 0) return;
  // DRAFT(ai): 노드 디스크 크기는 읽지 않는다 → 문서 기본값. EKS 관리형 노드 그룹 20 GiB, GKE 노드 부팅 디스크 100 GB pd-balanced
  if (provider === "aws") {
    const v = p.row("volume", "ebs-gp3");
    if (v) lines.push(lineOf(lang, { id: "node-disk", group: "storage", label: fill(lang, "nodeDisk", { type: "EBS gp3" }), qty: nodes * 20, unit: "uCount", row: v, basis: basis(kind, fill(lang, "bNodeDiskAws", { n: nodes })) }));
  } else if (provider === "gcp") {
    const v = p.row("volume", "pd-balanced");
    if (v) lines.push(lineOf(lang, { id: "node-disk", group: "storage", label: fill(lang, "nodeDisk", { type: "pd-balanced" }), qty: nodes * 100, unit: "uCount", row: v, basis: basis(kind, fill(lang, "bNodeDiskGcp", { n: nodes })) }));
  }
}

// ---- 옮긴 뒤 비용 ----

/**
 * 범위로 줄이기: 클러스터·DB 이름으로 거르고, 클러스터 밖 VM 은 옮기지 않으니 뺀다.
 * LB·NAT·공인 주소는 남긴다 — 출발 쪽 "지금 내는 돈"에는 들어가고, 도착에서는 Cloudflare 터널·플랫폼 환경 층이 대신한다 (같은 기준 비교)
 */
export function scopeFootprint(fp: Footprint, scope: SourceScope | undefined, lang: Lang): { fp: Footprint; notes: string[] } {
  const last = (x: string) => x.split("/").pop()!;
  const notes: string[] = [];
  const clusters = scope?.cluster ? fp.clusters.filter((c) => last(c.name) === last(scope.cluster!)) : fp.clusters;
  const names = new Set(clusters.map((c) => c.name));
  const standalone = fp.nodes.filter((n) => !n.cluster).reduce((a, n) => a + n.count, 0);
  const nodes = fp.nodes.filter((n) => n.cluster && (!scope?.cluster || names.has(n.cluster) || last(n.cluster) === last(scope.cluster)));
  if (standalone > 0) notes.push(fill(lang, "sStandalone", { n: standalone }));
  if (scope?.namespaces?.length) notes.push(fill(lang, "sNamespaces"));
  const dbs = scope?.database ? fp.dbs.filter((d) => last(d.name) === last(scope.database!)) : fp.dbs;
  return { fp: { ...fp, clusters, nodes, dbs }, notes };
}

const ENV_LAYER: Record<"aws" | "gcp", { where: string; node: string; nodes: number; db: string | null }> = {
  // infra/modules/aws/env: NAT 1 + 노드 t3.medium 2대 / kinds/postgres 기본 db.t4g.micro
  aws: { where: "infra/modules/aws/env", node: "t3.medium", nodes: 2, db: "db.t4g.micro" },
  // infra/modules/gcp/env: 존 GKE + 사설 노드 e2-standard-2 2대 + Cloud NAT + 고정 주소 1개 / kinds/postgres 기본 db-f1-micro(공유 코어)
  gcp: { where: "infra/modules/gcp/env", node: "e2-standard-2", nodes: 2, db: null },
};

/** 같은 크기 이상 중 가장 싼 줄. 없으면 가장 큰 줄을 대수로 늘린다 */
function cheapestFit(rows: PriceRow[], vcpu: number, memGiB: number): { row: PriceRow; scale: number } | null {
  const ok = rows.filter((r) => r.attrs.vcpu && r.attrs.memGiB);
  const fit = ok.filter((r) => r.attrs.vcpu! >= vcpu && r.attrs.memGiB! >= memGiB).sort((a, b) => a.usd - b.usd || a.sku.localeCompare(b.sku));
  if (fit[0]) return { row: fit[0], scale: 1 };
  const big = [...ok].sort((a, b) => b.attrs.vcpu! * 1000 + b.attrs.memGiB! - (a.attrs.vcpu! * 1000 + a.attrs.memGiB!))[0];
  return big ? { row: big, scale: Math.ceil(Math.max(vcpu / big.attrs.vcpu!, memGiB / big.attrs.memGiB!)) } : null;
}

const shapeText = (vcpu: number, mem: number) => `${vcpu} vCPU · ${r2(mem)} GiB`;

export interface MoveResult { breakdown: CostBreakdown; mappings: CostMapping[]; feasible: boolean; reason: string | null; nodeVcpu: number; freeTierClusterLineIds: string[] }

export function targetBreakdown(src: Footprint, srcCatalogProvider: Provider, target: Provider, catalog: PriceCatalog, region: string | null, lang: Lang): MoveResult {
  const sp = pricesFor(catalog, srcCatalogProvider, null);
  const lines: CostLine[] = [];
  const gaps: CostGap[] = [];
  const mappings: CostMapping[] = [];
  // 출발 노드·DB 의 크기 (출발 가격표의 vCPU·메모리 열)
  const srcNodes = src.nodes.map((g) => ({ g, shape: nodeShape(sp, g.type) }));
  const srcDbs = src.dbs.map((d) => ({ d, shape: dbShape(sp, src.provider, d) }));

  if (target === "onprem") {
    const p = pricesFor(catalog, "onprem", null);
    const known = srcNodes.filter((x) => x.shape);
    let vcpu = known.reduce((a, x) => a + x.shape!.vcpu * x.g.count, 0) + srcDbs.reduce((a, x) => a + (x.shape?.vcpu ?? 0), 0);
    let mem = known.reduce((a, x) => a + x.shape!.memGiB * x.g.count, 0) + srcDbs.reduce((a, x) => a + (x.shape?.memGiB ?? 0), 0);
    if (vcpu === 0) { vcpu = 2 * 2; mem = 2 * 8; }   // 출발 크기를 모르면 플랫폼 기본 노드 2대(2 vCPU·8 GiB) 만큼
    const servers = serversFor(vcpu, mem);
    const b = basis("mapped", fill(lang, "mOnprem", { vcpu, mem: r2(mem), n: servers }), src.nodes.flatMap((g) => g.names));
    const on = onpremLines(lang, servers, b, catalog.asOf);
    lines.push(...on.lines); gaps.push(...on.gaps);
    mappings.push({ group: "compute", from: src.nodes.map((g) => `${g.type} x ${g.count}`).join(", ") || "-", to: `k3s · ${servers} x (${ONPREM_SERVER.vcpu} threads · ${ONPREM_SERVER.memGiB} GiB)`, why: b.text });
    for (const { d } of srcDbs) mappings.push({ group: "database", from: d.cls ?? d.name, to: "CloudNativePG", why: fill(lang, "mDbCnpg") });
    if (src.albs.length || src.otherLbs.length) mappings.push({ group: "network", from: [...src.albs, ...src.otherLbs].join(", "), to: null, why: fill(lang, "mLb") });
    return { breakdown: finish("onprem", p, lines, gaps, catalog, lang), mappings, feasible: true, reason: null, nodeVcpu: vcpu, freeTierClusterLineIds: [] };
  }
  if (target !== "aws" && target !== "gcp") {
    return { breakdown: finish(target, pricesFor(catalog, target, null), [], [], catalog, lang), mappings, feasible: false, reason: fill(lang, "rAzure"), nodeVcpu: 0, freeTierClusterLineIds: [] };
  }
  const p = pricesFor(catalog, target, region);
  const layer = ENV_LAYER[target];
  const freeTier: string[] = [];
  // 클러스터: 출발에 노드나 클러스터가 있으면 도착 관리형 클러스터 1개 (GKE 는 존 클러스터 → 무료 등급 대상)
  const cl = p.row("cluster");
  if (cl && (src.nodes.length || src.clusters.length || src.provider === "onprem")) {
    const id = "cluster:target";
    lines.push(lineOf(lang, { id, group: "cluster", label: fill(lang, target === "aws" ? "eks" : "gke", { name: target === "aws" ? "EKS" : "GKE (zonal)" }), qty: 1, unit: "uCount", row: cl,
      basis: basis("mapped", fill(lang, "mCluster", { where: layer.where }), src.clusters.map((c) => c.name)) }));
    if (target === "gcp") freeTier.push(id);
    mappings.push({ group: "cluster", from: src.clusters.map((c) => c.name).join(", ") || (src.provider === "onprem" ? "k3s" : "-"), to: target === "aws" ? "EKS" : "GKE (zonal)", why: fill(lang, "mCluster", { where: layer.where }) });
  }
  // 노드: 출발 노드 그룹마다 같은 크기 이상 중 가장 싼 도착 노드 (같은 대수)
  const candidates = p.rows("node");
  let nodeCount = 0, nodeVcpu = 0;
  const mapped = srcNodes.filter((x) => x.shape);
  if (mapped.length === 0) {
    const row = p.row("node", layer.node);
    if (row) {
      const why = fill(lang, "mNodeDefault", { to: layer.node, n: layer.nodes });
      lines.push(lineOf(lang, { id: `node:${layer.node}`, group: "compute", label: fill(lang, "node", { cluster: target === "aws" ? "EKS" : "GKE", type: layer.node }), qty: layer.nodes, unit: "uMachines", row, basis: basis("assumption", why) }));
      mappings.push({ group: "compute", from: src.nodes.map((g) => `${g.type} x ${g.count}`).join(", ") || "-", to: `${layer.node} x ${layer.nodes}`, why });
      nodeCount += layer.nodes; nodeVcpu += layer.nodes * (row.attrs.vcpu ?? 0);
    }
  }
  for (const { g, shape } of mapped) {
    const fit = cheapestFit(candidates, shape!.vcpu, shape!.memGiB);
    if (!fit) { gaps.push(noPrice(lang, `node:${g.type}`, g.type, "node")); continue; }
    const n = g.count * fit.scale;
    const why = fill(lang, "mNode", { from: g.type, n: g.count, vcpu: shape!.vcpu, mem: r2(shape!.memGiB), to: fit.row.sku });
    lines.push(lineOf(lang, { id: `node:${g.type}->${fit.row.sku}`, group: "compute", label: fill(lang, "node", { cluster: target === "aws" ? "EKS" : "GKE", type: fit.row.sku }), qty: n, unit: "uMachines", row: fit.row,
      basis: basis("mapped", why, g.names) }));
    mappings.push({ group: "compute", from: `${g.type} x ${g.count} (${shapeText(shape!.vcpu, shape!.memGiB)})`, to: `${fit.row.sku} x ${n} (${shapeText(fit.row.attrs.vcpu!, fit.row.attrs.memGiB!)})`, why });
    nodeCount += n; nodeVcpu += n * fit.row.attrs.vcpu!;
  }
  for (const { g } of srcNodes.filter((x) => !x.shape)) gaps.push(noPrice(lang, `node:${g.type}`, g.type, g.type));
  nodeDiskLines(lang, p, target, nodeCount, "assumption", lines);

  // DB: 같은 크기 이상 중 가장 싼 등급 (HA 는 그대로)
  for (const { d, shape } of srcDbs) {
    const storageGb = d.storageGb ?? 20;
    if (target === "aws") {
      const rows = p.rows("db_class").filter((r) => r.attrs.multiAz === d.ha);
      const fit = shape ? cheapestFit(rows, shape.vcpu, shape.memGiB) : null;
      const cls = fit && fit.scale === 1 ? fit.row.sku.replace(/^rds-pg-(maz-)?/, "") : ENV_LAYER.aws.db!;
      const why = shape && fit ? fill(lang, "mDb", { from: d.cls ?? d.name, vcpu: shape.vcpu, mem: r2(shape.memGiB), to: cls }) : fill(lang, "mDbDefault", { to: cls });
      dbLines(lang, p, "aws", { name: d.name, cls, storageGb, ha: d.ha }, basis(shape ? "mapped" : "assumption", why, [d.name]), lines, gaps);
      mappings.push({ group: "database", from: d.cls ?? d.name, to: `RDS ${cls}${d.ha ? " Multi-AZ" : ""}`, why });
    } else {
      // Cloud SQL 맞춤 등급: vCPU 1 또는 짝수, 메모리 vCPU 당 0.9~6.5 GiB 이고 3.75 GiB 이상 (Cloud SQL 맞춤 머신 규칙)
      let vcpu = shape ? Math.max(1, Math.ceil(shape.vcpu)) : 1;
      if (vcpu > 1 && vcpu % 2) vcpu++;
      let mem = shape ? Math.max(shape.memGiB, 0.9 * vcpu, 3.75) : 3.75;
      while (mem > 6.5 * vcpu) vcpu = vcpu === 1 ? 2 : vcpu + 2;
      mem = Math.ceil(mem * 4) / 4;
      const tier = `db-custom-${vcpu}-${Math.round(mem * 1024)}`;
      const why = shape ? fill(lang, "mDb", { from: d.cls ?? d.name, vcpu: shape.vcpu, mem: r2(shape.memGiB), to: tier }) : fill(lang, "mDbDefaultGcp");
      dbLines(lang, p, "gcp", { name: d.name, cls: tier, storageGb, ha: d.ha }, basis(shape ? "mapped" : "assumption", why, [d.name]), lines, gaps);
      mappings.push({ group: "database", from: d.cls ?? d.name, to: `Cloud SQL ${tier}${d.ha ? " HA" : ""}`, why });
    }
  }
  if (src.albs.length || src.otherLbs.length) mappings.push({ group: "network", from: [...src.albs, ...src.otherLbs].join(", "), to: null, why: fill(lang, "mLb") });

  // 플랫폼 환경 층이 만드는 NAT 1개 + 고정 공인 주소 1개 (노드는 사설)
  const nat = p.row("nat");
  const natWhy = fill(lang, "mNat", { where: layer.where });
  if (nat && nodeCount > 0) {
    lines.push(target === "aws"
      ? lineOf(lang, { id: "nat", group: "network", label: fill(lang, "natAws"), qty: 1, unit: "uCount", row: nat, basis: basis("mapped", natWhy) })
      : lineOf(lang, { id: "nat", group: "network", label: fill(lang, "natGcp"), qty: Math.min(32, nodeCount), unit: "uVm", row: nat, basis: basis("mapped", natWhy) }));
    const ip = target === "aws" ? p.row("public_ip") : p.row("public_ip", "external-ipv4-in-use");
    if (ip) lines.push(lineOf(lang, { id: "ip", group: "network", label: fill(lang, "ipInUse"), qty: 1, unit: "uCount", row: ip, basis: basis("mapped", natWhy) }));
  }
  gaps.push(...egressGaps(lang, nodeCount > 0));
  return { breakdown: finish(target, p, lines, gaps, catalog, lang), mappings, feasible: true, reason: null, nodeVcpu, freeTierClusterLineIds: freeTier };
}

// ---- API 가 부르는 두 함수 ----

/** 저장된 실자원 조회 결과 중 비용이 보는 칸 (adapters CloudInventory 와 같은 이름) */
export interface InventoryForCost {
  status: "ok" | "partial" | "unavailable";
  reason: string | null;
  checkedAt: string;
  groups: { service: string; error: string | null }[];
  billing?: BillingFacts | undefined;
}
export interface EnvForCost { id: string; name: string; provider: Provider; region: string | null }

const emptyFacts = (): BillingFacts => ({ clusters: [], instances: [], databases: [], loadBalancers: [], natGateways: [], addresses: [], errors: [] });

/** 출발 자원 모양. 온프레는 Agent 보고에 크기가 없어 빈 모양 (DB 이름만) */
function footprintFor(env: EnvForCost, inv: InventoryForCost | null): Footprint | null {
  if (env.provider === "onprem") {
    return { provider: "onprem", clusters: [{ name: "k3s", zonal: null, autopilot: null }], nodes: [], dbs: [], albs: [], otherLbs: [], lbZoneIps: 0, nats: [], natVms: 0, ipsInUse: [], ipsIdle: [] };
  }
  if (!inv?.billing) return null;
  return footprintOf(env.provider, inv.billing);
}

export function envCost(env: EnvForCost, inv: InventoryForCost | null, catalog: PriceCatalog, lang: Lang): EnvCostView {
  const head = { envId: env.id, name: env.name, provider: env.provider, inventoryCheckedAt: inv?.checkedAt ?? null };
  const none = (status: EnvCostView["status"], reason: string): EnvCostView => ({ ...head, status, reason, breakdown: null, projection: null });
  if (env.provider === "azure_mock") return none("unavailable", fill(lang, "rAzure"));
  if (env.provider === "onprem") {
    const p = pricesFor(catalog, "onprem", null);
    const on = onpremLines(lang, 1, basis("assumption", fill(lang, "bOnpremAgent")), catalog.asOf);
    const breakdown = finish("onprem", p, on.lines, on.gaps, catalog, lang);
    return { ...head, status: "ok", reason: null, breakdown, projection: projectionOf(breakdown, []) };
  }
  if (!inv || inv.status === "unavailable") return none("unavailable", inv?.reason ?? fill(lang, "rNoInventory"));
  if (!inv.billing) return none("unavailable", fill(lang, "rNoBilling"));
  const fp = footprintOf(env.provider, inv.billing);
  const breakdown = currentBreakdown(fp, catalog, env.region, lang);
  const freeTier = env.provider === "gcp" ? fp.clusters.filter((c) => c.zonal || c.autopilot).map((c) => `cluster:${c.name}`) : [];
  const promotions = promotionsFor({ target: env.provider, breakdown, freeTierClusterLineIds: freeTier, nodeVcpu: 0, lang, current: true });
  // 읽기 실패: 화면 묶음 실패(partial) 또는 비용 사실용 명령 실패 → 합계가 실제보다 낮을 수 있음
  const failed = [...inv.groups.filter((g) => g.error).map((g) => g.service), ...inv.billing.errors.map((e) => e.split(":")[0]!)];
  const partial = inv.status === "partial" || inv.billing.errors.length > 0;
  return { ...head, status: partial ? "partial" : "ok", reason: partial ? fill(lang, "rPartial", { what: failed.join(", ") }) : null,
    breakdown, projection: projectionOf(breakdown, promotions) };
}

export function moveCost(
  source: EnvForCost, inv: InventoryForCost | null, scope: SourceScope | undefined,
  targets: EnvForCost[], catalog: PriceCatalog, lang: Lang,
): MoveCostView {
  const current = envCost(source, inv, catalog, lang);
  const raw = footprintFor(source, inv);
  if (!raw) {
    return { source: current, scopeNote: null, targets: targets.map((t) => ({ envId: t.id, name: t.name, provider: t.provider, feasible: false,
      reason: current.reason ?? fill(lang, "rNoInventory"), breakdown: null, projection: null, mappings: [], deltaMonthlyUsd: null })) };
  }
  const scoped = scopeFootprint(raw, scope, lang);
  // 옮길 범위만 다시 센 출발 비용 (클러스터 밖 VM·범위 밖 클러스터·DB 를 뺀 것). 도착과 같은 기준으로 비교한다
  let sourceView = current;
  if (source.provider !== "onprem" && current.breakdown) {
    const b = currentBreakdown(scoped.fp, catalog, source.region, lang);
    const freeTier = source.provider === "gcp" ? scoped.fp.clusters.filter((c) => c.zonal || c.autopilot).map((c) => `cluster:${c.name}`) : [];
    sourceView = { ...current, breakdown: b, projection: projectionOf(b, promotionsFor({ target: source.provider, breakdown: b, freeTierClusterLineIds: freeTier, nodeVcpu: 0, lang, current: true })) };
  }
  const srcMonthly = sourceView.breakdown?.monthlyUsd ?? null;
  const out: MoveCostTarget[] = targets.map((t) => {
    const head = { envId: t.id, name: t.name, provider: t.provider };
    const m = targetBreakdown(scoped.fp, source.provider, t.provider, catalog, t.region, lang);
    if (!m.feasible) return { ...head, feasible: false, reason: m.reason, breakdown: null, projection: null, mappings: m.mappings, deltaMonthlyUsd: null };
    const promotions = promotionsFor({ target: t.provider, source: source.provider, breakdown: m.breakdown, freeTierClusterLineIds: m.freeTierClusterLineIds, nodeVcpu: m.nodeVcpu, lang });
    return { ...head, feasible: true, reason: null, breakdown: m.breakdown, projection: projectionOf(m.breakdown, promotions), mappings: m.mappings,
      deltaMonthlyUsd: srcMonthly === null ? null : r2(srcMonthly - m.breakdown.monthlyUsd) };
  });
  return { source: sourceView, scopeNote: scoped.notes.length ? scoped.notes.join(" ") : null, targets: out };
}
