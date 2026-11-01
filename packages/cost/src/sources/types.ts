import type { Provider } from "@svc/contracts";
import type { PriceSource } from "../adapters/types.js";
import type { PriceRowInput } from "../schema.js";

// 가격 소스가 어디서 무엇을 받았는지. 캐시 파일에 그대로 남겨 "이 숫자 어디서 왔나"에 답한다.
// url에는 API 키 같은 비밀값을 절대 넣지 않는다 (키는 요청할 때만 붙인다).
export type SourceRef = {
  url: string;
  publishedAt?: string | undefined; // 벤더가 밝힌 가격표 발행 시각 (AWS CSV 머리말 등)
};

export type FetchResult = {
  rows: PriceRowInput[];
  sources: SourceRef[];
  missing: string[]; // 규칙은 있는데 응답에서 못 찾은 항목 (item/sku)
};

// 수집 -> 정규화까지 하는 소스. fetchRows는 기존 refreshCatalog와 맞추려고 둔다.
export interface DetailedPriceSource extends PriceSource {
  vendor: Provider;
  fetchDetailed(region: string, now: Date): Promise<FetchResult>;
}

export function toPriceSource(src: Omit<DetailedPriceSource, "fetchRows">): DetailedPriceSource {
  return {
    ...src,
    async fetchRows(region, now) {
      return (await src.fetchDetailed(region, now)).rows;
    },
  };
}
