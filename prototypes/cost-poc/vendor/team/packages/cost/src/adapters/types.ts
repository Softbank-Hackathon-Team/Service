import type { Provider } from "@svc/contracts";
import type { PriceItem, PriceRowInput } from "../schema.js";

// 가격 API에서 받은 한 줄을 우리 덩어리(item)로 분류하는 규칙.
// 우리가 쓰는 SKU만 남기려고 둔다 (설계 초안 4장 "모든 SKU를 저장하지 않는다").
export type SkuRule = {
  item: PriceItem;
  sku: string;                                  // 우리 쪽 이름 (예: t3.medium)
  attrs?: PriceRowInput["attrs"];
  match: (raw: Record<string, string>) => boolean; // 벤더 응답의 속성으로 판별
};

// 가격 소스 하나 = 벤더 하나. 네트워크는 fetchPage에만 있다 (CLAUDE.md §5-4와 같은 모양).
export interface PriceSource {
  vendor: Provider;
  fetchRows(region: string, now: Date): Promise<PriceRowInput[]>;
}

// HTTP 호출을 밖에서 넣는다. 테스트는 고정 응답(fixture)을 넣는다.
export type PageFetcher = (pageToken: string | null) => Promise<unknown>;

export class PriceSourceNotConfigured extends Error {
  readonly code = "PRICE_SOURCE_NOT_CONFIGURED";
}

// STUB: 진짜 HTTP 호출. 스켈레톤에선 부르지 않는다.
export const stubFetcher = (name: string): PageFetcher => async () => {
  throw new PriceSourceNotConfigured(`${name}: 실제 가격 API 호출은 아직 없음 (STUB)`);
};
