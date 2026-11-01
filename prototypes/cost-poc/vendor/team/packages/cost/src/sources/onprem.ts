import type { PriceRowInput } from "../schema.js";
import { type DetailedPriceSource, toPriceSource } from "./types.js";

// 온프레는 가격 API가 없다. 고정 가정치를 가격 줄 모양으로 낸다 (evidence: assumed).
// TODO(human): 데모 서버의 실제 감가·전기·회선비로 바꾸기. 지금 값은 기존 샘플과 같다.
export type OnpremAssumption = {
  monthlyUsd: number;  // 서버 1대 월 고정비
  capVcpu: number;     // 서버 안에서 쓸 수 있는 vCPU
  node: { sku: string; vcpu: number; memGiB: number };
};

export const DEFAULT_ONPREM: OnpremAssumption = {
  monthlyUsd: 250, capVcpu: 16, node: { sku: "k3s-vm-2c8g", vcpu: 2, memGiB: 8 },
};

export function createOnpremSource(a: OnpremAssumption = DEFAULT_ONPREM): DetailedPriceSource {
  return toPriceSource({
    vendor: "onprem",
    async fetchDetailed(region, now) {
      const fetchedAt = now.toISOString();
      const rows: PriceRowInput[] = [
        { vendor: "onprem", region, item: "fixed", sku: "server-1", unit: "month", usd: a.monthlyUsd,
          attrs: { capVcpu: a.capVcpu }, evidence: "assumed",
          source: "고정 가정치 (서버 감가+전기+회선), packages/cost/src/sources/onprem.ts", fetchedAt },
        { vendor: "onprem", region, item: "node", sku: a.node.sku, unit: "hour", usd: 0,
          attrs: { vcpu: a.node.vcpu, memGiB: a.node.memGiB }, evidence: "assumed",
          source: "서버 안 가상 노드, 고정비에 포함", fetchedAt },
      ];
      return { rows, sources: [{ url: "assumption:onprem" }], missing: [] };
    },
  });
}
