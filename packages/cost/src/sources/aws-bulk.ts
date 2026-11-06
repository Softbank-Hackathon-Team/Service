import type { PriceItem, PriceRowInput } from "../schema.js";
import { httpLines, type LineSource, parseCsvLine } from "./csv.js";
import { type DetailedPriceSource, type FetchResult, type SourceRef, toPriceSource } from "./types.js";

// AWS Price List Bulk API (공개 파일, 인증 없음).
// 【사실】 주소 모양 https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/{서비스}/current/{리전}/index.csv
//   10/31 이 컨테이너에서 서울 파일 4개를 받음: EC2 약 204MB, RDS 약 13MB, EKS 약 0.3MB, ELB 약 6KB.
// 【사실】 CSV 앞 5줄은 머리말(FormatVersion, Disclaimer, Publication Date, Version, OfferCode), 6번째 줄이 열 이름.
// GetProducts(Query API)를 안 쓰는 이유: 서명(SigV4)과 자격 증명이 필요하고, 엔드포인트가 us-east-1 등 3곳뿐이다.
export const AWS_BULK_BASE = "https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws";

export type AwsService = "AmazonEC2" | "AmazonRDS" | "AmazonEKS" | "AWSELB" | "AmazonVPC";
export const awsBulkUrl = (service: AwsService, region: string) =>
  `${AWS_BULK_BASE}/${service}/current/${region}/index.csv`;

type Row = Record<string, string>;

export type AwsBulkRule = {
  service: AwsService;
  item: PriceItem;
  sku: string;
  match: (r: Row) => boolean;
  /** 한 규칙이 여러 줄을 낼 때 줄마다 SKU 이름 (없으면 sku 하나). 이런 규칙은 "못 찾음" 목록에서 뺀다 */
  skuOf?: (r: Row) => string;
};

const UNIT: Record<string, PriceRowInput["unit"]> = {
  Hrs: "hour", Hours: "hour", hours: "hour", "LCU-Hrs": "hour", "GB-Mo": "gb_month",
};

// 리전 접두어(APN2- 등)를 떼고 usageType 끝을 본다
const usage = (r: Row) => (r["usageType"] ?? "").replace(/^[A-Z0-9]+-/, "");
const inRegion = (r: Row) => r["Location Type"] === "AWS Region";

// 노드 후보. 기존 샘플 3종 + 비교용 4종. vCPU·메모리는 CSV 열에서 읽는다 (규칙에 손으로 적지 않음)
export const AWS_NODE_TYPES = [
  "t3.medium", "t3.large", "t3.xlarge", "m6i.large", "m6i.xlarge", "c6i.large", "c6i.xlarge",
];

const ec2Node = (type: string): AwsBulkRule => ({
  service: "AmazonEC2", item: "node", sku: type,
  match: (r) => r["Instance Type"] === type && r["Operating System"] === "Linux"
    && r["Tenancy"] === "Shared" && r["Pre Installed S/W"] === "NA"
    && r["CapacityStatus"] === "Used" && r["License Model"] === "No License required"
    && r["MarketOption"] === "OnDemand" && usage(r).startsWith("BoxUsage:"),
});

// 실자원 단가 찾기용 (item "instance"·"db_class"). 고객 계정에서 읽은 종류가 무엇이든 단가를 찾도록 계열·크기를 넓게 받는다.
// DRAFT(ai): 범용·컴퓨트·메모리·버스터블 계열의 흔한 크기만. 표에 없으면 비용 화면이 "단가 없음"으로 합계에서 뺀다 (지어내지 않음)
export const AWS_INSTANCE_FAMILIES = ["t3", "t3a", "t4g", "m5", "m5a", "m6i", "m6a", "m6g", "m7i", "m7g", "c5", "c6i", "c6a", "c6g", "c7i", "c7g", "r5", "r6i", "r6g", "r7i"];
export const AWS_INSTANCE_SIZES = ["nano", "micro", "small", "medium", "large", "xlarge", "2xlarge", "4xlarge"];
const familyOf = (type: string) => type.split(".")[0] ?? "";
const sizeOf = (type: string) => type.split(".")[1] ?? "";
const anyInstance: AwsBulkRule = {
  service: "AmazonEC2", item: "instance", sku: "ec2-*",
  match: (r) => {
    const type = r["Instance Type"] ?? "";
    return AWS_INSTANCE_FAMILIES.includes(familyOf(type)) && AWS_INSTANCE_SIZES.includes(sizeOf(type))
      && ec2Node(type).match(r);
  },
  skuOf: (r) => r["Instance Type"] ?? "",
};
// RDS PostgreSQL 등급. 단일 AZ 와 다중 AZ(대기 1대) 두 가지. "readable standbys"(다중 AZ 클러스터)는 뺀다
const RDS_DEPLOY: Record<string, string> = { "Single-AZ": "rds-pg-", "Multi-AZ": "rds-pg-maz-" };
const anyRdsClass: AwsBulkRule = {
  service: "AmazonRDS", item: "db_class", sku: "rds-pg-*",
  match: (r) => r["Database Engine"] === "PostgreSQL" && (r["Deployment Option"] ?? "") in RDS_DEPLOY
    && /^db\.(t3|t4g|m5|m6g|m6i|m7g|r5|r6g|r6i)\./.test(r["Instance Type"] ?? "")
    && /^(InstanceUsage|Multi-AZUsage):db\./.test(usage(r)),
  skuOf: (r) => `${RDS_DEPLOY[r["Deployment Option"] ?? ""]}${r["Instance Type"]}`,
};

export const AWS_BULK_RULES: AwsBulkRule[] = [
  ...AWS_NODE_TYPES.map(ec2Node),
  anyInstance,
  anyRdsClass,
  // NAT 게이트웨이 시간 요금. 처리 GB 요금은 사용량을 몰라 비용 화면 합계에 넣지 않는다
  { service: "AmazonEC2", item: "nat", sku: "nat-gateway",
    match: (r) => inRegion(r) && usage(r) === "NatGateway-Hours" },
  // 쓰는 공인 IPv4 (2024-02 부터 과금). 노드·NAT·로드 밸런서의 공인 주소 모두
  { service: "AmazonVPC", item: "public_ip", sku: "public-ipv4-in-use",
    match: (r) => inRegion(r) && usage(r) === "PublicIPv4:InUseAddress" },
  { service: "AmazonEC2", item: "volume", sku: "ebs-gp3",
    match: (r) => r["Product Family"] === "Storage" && r["Volume API Name"] === "gp3"
      && usage(r) === "EBS:VolumeUsage.gp3" },
  { service: "AmazonEKS", item: "cluster", sku: "eks-standard",
    match: (r) => inRegion(r) && usage(r) === "AmazonEKS-Hours:perCluster" },
  { service: "AmazonRDS", item: "db", sku: "rds-pg-db.t3.medium",
    match: (r) => r["Instance Type"] === "db.t3.medium" && r["Database Engine"] === "PostgreSQL"
      && r["Deployment Option"] === "Single-AZ" && usage(r) === "InstanceUsage:db.t3.medium" },
  { service: "AmazonRDS", item: "storage", sku: "rds-gp3",
    match: (r) => r["Database Engine"] === "PostgreSQL" && r["Deployment Option"] === "Single-AZ"
      && usage(r) === "RDS:GP3-Storage" },
  { service: "AWSELB", item: "lb", sku: "alb",
    match: (r) => inRegion(r) && r["Product Family"] === "Load Balancer-Application"
      && usage(r) === "LoadBalancerUsage" },
  { service: "AWSELB", item: "lb_capacity", sku: "alb-lcu",
    match: (r) => inRegion(r) && r["Product Family"] === "Load Balancer-Application"
      && usage(r) === "LCUUsage" },
];

export class AmbiguousPrice extends Error {
  readonly code = "AMBIGUOUS_PRICE";
}

const gib = (s: string | undefined) => Number((s ?? "").replace(/\s*GiB$/, "").replace(/,/g, ""));

// 순수에 가까운 함수: CSV 줄 묶음 -> 가격 줄. 같은 SKU에 값이 둘 이상이면 던진다 (규칙이 덜 좁다는 뜻).
export async function parseAwsBulkCsv(
  lines: AsyncIterable<string>, rules: AwsBulkRule[], region: string, fetchedAt: string,
): Promise<{ rows: PriceRowInput[]; publishedAt?: string | undefined }> {
  let header: string[] | null = null;
  let publishedAt: string | undefined;
  let n = 0;
  const found = new Map<string, PriceRowInput>();
  for await (const line of lines) {
    n++;
    if (!header) {
      const cells = parseCsvLine(line);
      if (cells[0] === "Publication Date") publishedAt = cells[1];
      if (cells[0] === "SKU") header = cells;
      if (n > 20 && !header) throw new Error("AWS_CSV_NO_HEADER");
      continue;
    }
    // 빠른 거르기: 온디맨드 줄만 (EC2 파일의 대부분은 예약·절약 플랜 줄)
    if (!line.includes('"OnDemand"')) continue;
    const cells = parseCsvLine(line);
    const r: Row = {};
    header.forEach((h, i) => { r[h] = cells[i] ?? ""; });
    if (r["TermType"] !== "OnDemand" || r["Currency"] !== "USD") continue;
    for (const rule of rules) {
      if (!rule.match(r)) continue;
      const unit = UNIT[r["Unit"] ?? ""];
      const usd = Number(r["PricePerUnit"]);
      if (!unit || !Number.isFinite(usd)) continue;
      const tierFrom = Number(r["StartingRange"] || 0);
      const attrs: PriceRowInput["attrs"] = {};
      if (rule.item === "node" || rule.item === "instance" || rule.item === "db_class") {
        attrs.vcpu = Number(r["vCPU"]);
        attrs.memGiB = gib(r["Memory"]);
      }
      if (rule.item === "db_class") attrs.multiAz = r["Deployment Option"] === "Multi-AZ";
      const sku = rule.skuOf ? rule.skuOf(r) : rule.sku;
      const key = `${rule.item}/${sku}/${tierFrom}`;
      const prev = found.get(key);
      if (prev && prev.usd !== usd) {
        throw new AmbiguousPrice(`${key}: ${prev.usd} vs ${usd} (${r["SKU"]})`);
      }
      found.set(key, {
        vendor: "aws", region, item: rule.item, sku, unit, usd, tierFrom, attrs,
        evidence: "fact",
        source: `AWS Price List Bulk ${rule.service} ${region} SKU ${r["SKU"]}`
          + (publishedAt ? ` (발행 ${publishedAt})` : ""),
        fetchedAt,
        sourceUrl: awsBulkUrl(rule.service, region),
        sourceKind: "official_api",
      });
    }
  }
  if (!header) throw new Error("AWS_CSV_NO_HEADER");
  return { rows: [...found.values()], publishedAt };
}

export function createAwsBulkSource(
  opts: { lines?: LineSource; rules?: AwsBulkRule[] } = {},
): DetailedPriceSource {
  const lines = opts.lines ?? httpLines;
  const rules = opts.rules ?? AWS_BULK_RULES;
  return toPriceSource({
    vendor: "aws",
    async fetchDetailed(region, now): Promise<FetchResult> {
      const services = [...new Set(rules.map((r) => r.service))];
      const rows: PriceRowInput[] = [];
      const sources: SourceRef[] = [];
      for (const svc of services) {
        const url = awsBulkUrl(svc, region);
        const res = await parseAwsBulkCsv(lines(url), rules.filter((r) => r.service === svc),
          region, now.toISOString());
        rows.push(...res.rows);
        sources.push({ url, publishedAt: res.publishedAt });
      }
      const got = new Set(rows.map((r) => `${r.item}/${r.sku}`));
      const missing = rules.filter((r) => !r.skuOf).map((r) => `${r.item}/${r.sku}`).filter((k) => !got.has(k));
      return { rows, sources, missing };
    },
  });
}
