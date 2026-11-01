import type { Provider } from "@svc/contracts";
import { vendorRegion } from "./catalog.js";
import type { PriceSource } from "./adapters/types.js";
import { PriceCatalog, PriceRow } from "./schema.js";

export type RefreshReport = {
  vendor: Provider; ok: boolean; rows: number; error?: string;
};

// 하루 한 번 예약 작업이 부르는 함수 (설계 초안 4장, 11장).
// 벤더별로 받은 줄로 바꾸고, 실패한 벤더는 어제 줄을 그대로 둔다.
// 부작용 없음: 새 가격표를 돌려줄 뿐 DB에 쓰지 않는다. 저장은 부르는 쪽(worker)이 한다.
export async function refreshCatalog(
  prev: PriceCatalog, sources: PriceSource[], region: string, now: Date,
): Promise<{ catalog: PriceCatalog; report: RefreshReport[] }> {
  let rows = [...prev.rows];
  const report: RefreshReport[] = [];
  let anyOk = false;
  for (const src of sources) {
    const vr = vendorRegion(src.vendor, region);
    try {
      const fresh = (await src.fetchRows(vr, now)).map((r) => PriceRow.parse(r));
      if (fresh.length === 0) throw new Error("NO_ROWS");
      // 받은 item만 교체. 못 받은 item(예: DB)은 어제 값 유지
      const items = new Set(fresh.map((r) => `${r.item}/${r.sku}`));
      rows = rows.filter((r) => !(r.vendor === src.vendor && r.region === vr
        && items.has(`${r.item}/${r.sku}`)));
      rows.push(...fresh);
      report.push({ vendor: src.vendor, ok: true, rows: fresh.length });
      anyOk = true;
    } catch (e) {
      report.push({ vendor: src.vendor, ok: false, rows: 0, error: (e as Error).message });
    }
  }
  // DRAFT(ai): 한 벤더라도 받았으면 기준일을 오늘로. 벤더별 기준일은 각 줄의 fetchedAt에 남는다.
  const asOf = anyOk ? now.toISOString() : prev.asOf;
  return { catalog: PriceCatalog.parse({ asOf, rows }), report };
}
