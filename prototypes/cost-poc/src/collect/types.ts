// DRAFT(ai): 수집 결과의 한 줄. 줄마다 출처와 수집일을 남긴다.
// evidence: public = 벤더 공개 가격 원본, public-secondary = 벤더 데이터를 옮긴 2차 공개 자료, assumed = 가정
export type Evidence = "public" | "public-secondary" | "assumed";
export type VendorId = "aws" | "gcp" | "azure" | "onprem";

export type PriceLine = {
  vendor: VendorId;
  region: string;
  item: "cluster" | "node" | "db" | "storage" | "egress" | "disk" | "lb" | "nat";
  sku: string;
  unit: "hour" | "gb_month" | "gb" | "month";
  usd: number;
  // 계단 가격: 단가가 시작되는 월 사용량(GB). 계단 없으면 0
  tierFromGB?: number;
  attrs?: { vcpu?: number; memGiB?: number; family?: string; burstable?: boolean; sustainedVcpu?: number; note?: string };
  // 약정 1년 단가 (없으면 미수집)
  commit1yHourly?: number;
  evidence: Evidence;
  sourceUrl: string;
  sourceDetail: string;
  fetchedAt: string;
  publishedAt?: string;
};

export type PriceFile = {
  vendor: VendorId;
  region: string;
  fetchedAt: string;
  sources: { url: string; publishedAt?: string; note?: string }[];
  missing: string[];
  lines: PriceLine[];
};
