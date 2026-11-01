import type { PriceFile, PriceLine } from "./types.js";

// DRAFT(ai): AWS Price List Bulk (공개 CSV, 자격 증명 없음). 서울 ap-northeast-2.
// EC2 CSV는 200MB 이상이라 스트리밍으로 필요한 줄만 고른다.
const BASE = "https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws";
const REGION = "ap-northeast-2";

// 매칭 규칙: x86, 온디맨드, Linux, 공유 테넌시. 범용 1:4(m6i), 컴퓨트 1:2(c6i), 메모리 1:8(r6i), 버스터블(t3)
export const AWS_NODES: Record<string, { family: string; burstable?: boolean; baselinePct?: number }> = {
  "m6i.large": { family: "general" }, "m6i.xlarge": { family: "general" },
  "m6i.2xlarge": { family: "general" }, "m6i.4xlarge": { family: "general" },
  "c6i.large": { family: "compute" }, "c6i.xlarge": { family: "compute" },
  "c6i.2xlarge": { family: "compute" }, "c6i.4xlarge": { family: "compute" },
  "r6i.large": { family: "memory" }, "r6i.xlarge": { family: "memory" }, "r6i.2xlarge": { family: "memory" },
  // 기준 CPU 비율: https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/burstable-credits-baseline-concepts.html
  "t3.medium": { family: "burstable", burstable: true, baselinePct: 20 },
  "t3.large": { family: "burstable", burstable: true, baselinePct: 30 },
  "t3.xlarge": { family: "burstable", burstable: true, baselinePct: 40 },
};
export const AWS_DB: string[] = ["db.t3.medium", "db.m6i.large", "db.m6i.xlarge", "db.m6i.2xlarge", "db.m6i.4xlarge", "db.m6i.8xlarge"];

export function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = ""; let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (q) {
      if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") { out.push(cur); cur = ""; } else cur += c;
  }
  out.push(cur);
  return out;
}

async function* lines(url: string): AsyncGenerator<string> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`HTTP_${res.status} ${url}`);
  const dec = new TextDecoder();
  let buf = "";
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buf += dec.decode(chunk, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) { yield buf.slice(0, i).replace(/\r$/, ""); buf = buf.slice(i + 1); }
  }
  if (buf) yield buf;
}

type Row = Record<string, string>;
async function scan(service: string, keep: (raw: string) => boolean, onRow: (r: Row) => void) {
  const url = `${BASE}/${service}/current/${REGION}/index.csv`;
  let header: string[] | null = null;
  let publishedAt: string | undefined;
  for await (const line of lines(url)) {
    if (!header) {
      const c = parseCsvLine(line);
      if (c[0] === "Publication Date") publishedAt = c[1];
      if (c[0] === "SKU") header = c;
      continue;
    }
    if (!keep(line)) continue;
    const cells = parseCsvLine(line);
    const r: Row = {};
    header.forEach((h, i) => { r[h] = cells[i] ?? ""; });
    onRow(r);
  }
  if (!header) throw new Error(`AWS_CSV_NO_HEADER ${service}`);
  return { url, publishedAt };
}

const usage = (r: Row) => (r["usageType"] ?? "").replace(/^[A-Z0-9]+-/, "");

export async function collectAws(now: Date): Promise<PriceFile> {
  const fetchedAt = now.toISOString();
  const out: PriceLine[] = [];
  const sources: PriceFile["sources"] = [];
  const add = (l: Omit<PriceLine, "vendor" | "region" | "evidence" | "fetchedAt" | "sourceUrl">, url: string, publishedAt?: string) =>
    out.push({ vendor: "aws", region: REGION, evidence: "public", fetchedAt, ...l, sourceUrl: url, ...(publishedAt ? { publishedAt } : {}) });

  // EC2 노드와 노드 디스크
  const nodeRows = new Map<string, Row>();
  const commit = new Map<string, number>();
  let gp3: Row | undefined;
  let natHour: Row | undefined; let natData: Row | undefined;
  const ec2Types = Object.keys(AWS_NODES);
  const ec2 = await scan("AmazonEC2",
    (raw) => ec2Types.some((t) => raw.includes(`"${t}"`)) || raw.includes("EBS:VolumeUsage.gp3") || raw.includes("NatGateway-"),
    (r) => {
      if (r["TermType"] === "OnDemand" && usage(r) === "NatGateway-Hours") natHour = r;
      if (r["TermType"] === "OnDemand" && usage(r) === "NatGateway-Bytes") natData = r;
      if (r["Product Family"] === "Storage" && r["Volume API Name"] === "gp3" && usage(r) === "EBS:VolumeUsage.gp3" && r["TermType"] === "OnDemand") gp3 = r;
      const t = r["Instance Type"] ?? "";
      if (!AWS_NODES[t]) return;
      if (!(r["Operating System"] === "Linux" && r["Tenancy"] === "Shared" && r["Pre Installed S/W"] === "NA"
        && r["License Model"] === "No License required" && usage(r).startsWith("BoxUsage:"))) return;
      if (r["TermType"] === "OnDemand" && r["CapacityStatus"] === "Used" && r["MarketOption"] === "OnDemand") nodeRows.set(t, r);
      // 약정: 1년, 선결제 없음, standard 예약 인스턴스
      if (r["TermType"] === "Reserved" && r["LeaseContractLength"] === "1yr" && r["PurchaseOption"] === "No Upfront"
        && r["OfferingClass"] === "standard" && r["Unit"] === "Hrs") commit.set(t, Number(r["PricePerUnit"]));
    });
  sources.push({ url: ec2.url, ...(ec2.publishedAt ? { publishedAt: ec2.publishedAt } : {}) });
  for (const [t, r] of nodeRows) {
    const meta = AWS_NODES[t]!;
    const vcpu = Number(r["vCPU"]);
    const memGiB = Number((r["Memory"] ?? "").replace(/\s*GiB$/, ""));
    const c1 = commit.get(t);
    add({
      item: "node", sku: t, unit: "hour", usd: Number(r["PricePerUnit"]),
      attrs: { vcpu, memGiB, family: meta.family, ...(meta.burstable ? { burstable: true, sustainedVcpu: vcpu * meta.baselinePct! / 100 } : {}) },
      ...(c1 !== undefined ? { commit1yHourly: c1 } : {}),
      sourceDetail: `AmazonEC2 SKU ${r["SKU"]} ${r["PriceDescription"]}`,
    }, ec2.url, ec2.publishedAt);
  }
  if (gp3) add({ item: "disk", sku: "ebs-gp3", unit: "gb_month", usd: Number(gp3["PricePerUnit"]), sourceDetail: `AmazonEC2 SKU ${gp3["SKU"]} ${gp3["PriceDescription"]}` }, ec2.url, ec2.publishedAt);

  // NAT: 비공개 서브넷 + cloudflared 터널이면 응답이 NAT를 지난다. 합계에는 기본 제외, 민감도용
  if (natHour) add({ item: "nat", sku: "nat-hour", unit: "hour", usd: Number(natHour["PricePerUnit"]), sourceDetail: `AmazonEC2 SKU ${natHour["SKU"]} ${natHour["PriceDescription"]}` }, ec2.url, ec2.publishedAt);
  if (natData) add({ item: "nat", sku: "nat-data", unit: "gb", usd: Number(natData["PricePerUnit"]), sourceDetail: `AmazonEC2 SKU ${natData["SKU"]} ${natData["PriceDescription"]}` }, ec2.url, ec2.publishedAt);

  // EKS 컨트롤 플레인
  let eks: Row | undefined;
  const eksScan = await scan("AmazonEKS", (raw) => raw.includes("perCluster"), (r) => {
    if (r["TermType"] === "OnDemand" && r["Location Type"] === "AWS Region" && usage(r) === "AmazonEKS-Hours:perCluster") eks = r;
  });
  sources.push({ url: eksScan.url, ...(eksScan.publishedAt ? { publishedAt: eksScan.publishedAt } : {}) });
  if (eks) add({ item: "cluster", sku: "eks-standard", unit: "hour", usd: Number(eks["PricePerUnit"]), sourceDetail: `AmazonEKS SKU ${eks["SKU"]} ${eks["PriceDescription"]}` }, eksScan.url, eksScan.publishedAt);

  // RDS for PostgreSQL 단일 AZ + gp3 스토리지 + 1년 약정
  const dbOd = new Map<string, Row>();
  const dbC = new Map<string, number>();
  let rdsGp3: Row | undefined;
  const rds = await scan("AmazonRDS", (raw) => raw.includes("PostgreSQL"), (r) => {
    if (r["Database Engine"] !== "PostgreSQL" || r["Deployment Option"] !== "Single-AZ") return;
    if (r["TermType"] === "OnDemand" && usage(r) === "RDS:GP3-Storage") rdsGp3 = r;
    const t = r["Instance Type"] ?? "";
    // usageType 표기는 db.m6i.xl처럼 줄여 쓰므로 접두어만 본다
    if (!AWS_DB.includes(t) || !usage(r).startsWith("InstanceUsage:db.")) return;
    if (r["TermType"] === "OnDemand") dbOd.set(t, r);
    if (r["TermType"] === "Reserved" && r["LeaseContractLength"] === "1yr" && r["PurchaseOption"] === "No Upfront" && r["Unit"] === "Hrs") dbC.set(t, Number(r["PricePerUnit"]));
  });
  sources.push({ url: rds.url, ...(rds.publishedAt ? { publishedAt: rds.publishedAt } : {}) });
  for (const [t, r] of dbOd) {
    const vcpu = Number(r["vCPU"]);
    const memGiB = Number((r["Memory"] ?? "").replace(/\s*GiB$/, ""));
    const c1 = dbC.get(t);
    add({
      item: "db", sku: t, unit: "hour", usd: Number(r["PricePerUnit"]),
      attrs: { vcpu, memGiB, family: t.includes(".t3.") ? "burstable" : "general", ...(t.includes(".t3.") ? { burstable: true, sustainedVcpu: vcpu * 0.2 } : {}) },
      ...(c1 !== undefined ? { commit1yHourly: c1 } : {}),
      sourceDetail: `AmazonRDS SKU ${r["SKU"]} ${r["PriceDescription"]}`,
    }, rds.url, rds.publishedAt);
  }
  if (rdsGp3) add({ item: "storage", sku: "rds-gp3", unit: "gb_month", usd: Number(rdsGp3["PricePerUnit"]), sourceDetail: `AmazonRDS SKU ${rdsGp3["SKU"]} ${rdsGp3["PriceDescription"]}` }, rds.url, rds.publishedAt);

  // 인터넷 송신 (계단, 전역 무료 100GB는 별도 줄)
  const dt = await scan("AWSDataTransfer", (raw) => raw.includes("APN2-DataTransfer-Out-Bytes") || raw.includes("DataTransfer-Out-Bytes"), (r) => {
    if (r["TermType"] !== "OnDemand" || r["usageType"] !== "APN2-DataTransfer-Out-Bytes" || r["Transfer Type"] !== "AWS Outbound") return;
    add({ item: "egress", sku: "internet-out", unit: "gb", usd: Number(r["PricePerUnit"]), tierFromGB: Number(r["StartingRange"] || 0), sourceDetail: `AWSDataTransfer SKU ${r["SKU"]} ${r["PriceDescription"]}` },
      `${BASE}/AWSDataTransfer/current/${REGION}/index.csv`);
  });
  sources.push({ url: dt.url, ...(dt.publishedAt ? { publishedAt: dt.publishedAt } : {}) });
  for (const l of out) if (l.item === "egress" && dt.publishedAt) l.publishedAt = dt.publishedAt;

  // ALB (합계에는 기본 제외, 민감도용)
  let alb: Row | undefined;
  const elb = await scan("AWSELB", (raw) => raw.includes("LoadBalancerUsage"), (r) => {
    if (r["TermType"] === "OnDemand" && r["Product Family"] === "Load Balancer-Application" && usage(r) === "LoadBalancerUsage") alb = r;
  });
  sources.push({ url: elb.url, ...(elb.publishedAt ? { publishedAt: elb.publishedAt } : {}) });
  if (alb) add({ item: "lb", sku: "alb", unit: "hour", usd: Number(alb["PricePerUnit"]), sourceDetail: `AWSELB SKU ${alb["SKU"]} ${alb["PriceDescription"]}` }, elb.url, elb.publishedAt);

  const want = [...Object.keys(AWS_NODES).map((t) => `node/${t}`), ...AWS_DB.map((t) => `db/${t}`), "cluster/eks-standard", "storage/rds-gp3", "disk/ebs-gp3", "egress/internet-out", "lb/alb", "nat/nat-hour", "nat/nat-data"];
  const got = new Set(out.map((l) => `${l.item}/${l.sku}`));
  return { vendor: "aws", region: REGION, fetchedAt, sources, missing: want.filter((k) => !got.has(k)), lines: out };
}
