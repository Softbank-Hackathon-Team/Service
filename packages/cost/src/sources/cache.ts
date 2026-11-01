import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { Provider, type PriceSourceSummary } from "@svc/contracts";
import { loadSampleCatalog, vendorRegion } from "../catalog.js";
import { PriceCatalog, PriceRow } from "../schema.js";
import type { DetailedPriceSource, FetchResult } from "./types.js";

// 캐시 파일 하나 = 벤더 하나: packages/cost/prices/{vendor}.json
// 수집 시각(fetchedAt)과 출처 URL(sources)을 같이 남긴다. 비밀값은 넣지 않는다.
export const PriceCacheFile = z.object({
  vendor: Provider,
  region: z.string(),
  fetchedAt: z.iso.datetime({ offset: true }),
  origin: z.enum(["live", "seed"]), // live: API에서 받음, seed: API를 못 불러 샘플값으로 채움
  note: z.string().optional(),
  sources: z.array(z.object({ url: z.string(), publishedAt: z.string().optional() }).strict()),
  missing: z.array(z.string()).default([]),
  rows: z.array(PriceRow),
}).strict();
export type PriceCacheFile = z.infer<typeof PriceCacheFile>;

export const DEFAULT_CACHE_DIR = new URL("../../prices/", import.meta.url);

const fileFor = (dir: URL, vendor: Provider) => new URL(`${vendor}.json`, dir);

export function readCache(vendor: Provider, dir: URL = DEFAULT_CACHE_DIR): PriceCacheFile | null {
  const f = fileFor(dir, vendor);
  if (!existsSync(f)) return null;
  return PriceCacheFile.parse(JSON.parse(readFileSync(f, "utf8")));
}

export function writeCache(c: PriceCacheFile, dir: URL = DEFAULT_CACHE_DIR): void {
  mkdirSync(dir, { recursive: true });
  const body = PriceCacheFile.parse(c);
  writeFileSync(fileFor(dir, c.vendor), `${JSON.stringify(body, null, 2)}\n`);
}

export type CachedFetch = FetchResult & {
  from: "live" | "cache"; error?: string | undefined; cache: PriceCacheFile;
};

// 받아 오기 -> 성공하면 캐시에 쓰기, 실패하면 캐시 읽기. 캐시도 없으면 원래 오류를 던진다.
export async function fetchWithCache(
  src: DetailedPriceSource, region: string, now: Date,
  opts: { dir?: URL; write?: boolean } = {},
): Promise<CachedFetch> {
  const dir = opts.dir ?? DEFAULT_CACHE_DIR;
  const vr = vendorRegion(src.vendor, region);
  try {
    const res = await src.fetchDetailed(vr, now);
    if (res.rows.length === 0) throw new Error("NO_ROWS");
    const cache: PriceCacheFile = {
      vendor: src.vendor, region: vr, fetchedAt: now.toISOString(), origin: "live",
      sources: res.sources, missing: res.missing,
      rows: res.rows.map((r) => PriceRow.parse(r))
        .sort((x, y) => `${x.item}/${x.sku}/${x.tierFrom}`.localeCompare(`${y.item}/${y.sku}/${y.tierFrom}`)),
    };
    if (opts.write !== false) writeCache(cache, dir);
    return { ...res, from: "live", cache };
  } catch (e) {
    const cache = readCache(src.vendor, dir);
    if (!cache) throw e;
    return {
      rows: cache.rows, sources: cache.sources, missing: cache.missing,
      from: "cache", error: (e as Error).message, cache,
    };
  }
}

// API가 쓰는 가격표: 샘플 위에 캐시 줄을 덮는다 (같은 vendor/region/item/sku는 캐시가 이긴다).
// 캐시에 없는 줄(예: GKE 무료 크레딧, Azure Mock)은 샘플 값 그대로. 네트워크는 쓰지 않는다.
export function loadCatalog(
  opts: { dir?: URL; base?: PriceCatalog; vendors?: Provider[] } = {},
): PriceCatalog {
  const base = opts.base ?? loadSampleCatalog();
  const vendors = opts.vendors ?? Provider.options;
  const caches = vendors.map((v) => readCache(v, opts.dir)).filter((c): c is PriceCacheFile => !!c);
  if (caches.length === 0) return base;
  const key = (r: PriceRow) => `${r.vendor}/${r.region}/${r.item}/${r.sku}`;
  const over = new Set(caches.flatMap((c) => c.rows.map(key)));
  const rows = [...base.rows.filter((r) => !over.has(key(r))), ...caches.flatMap((c) => c.rows)];
  // DRAFT(ai): 기준일 = API에서 받은(live) 캐시 중 가장 오래된 것. 한 벤더라도 7일 넘으면 priceStale 경고가 뜨게.
  // 온프레는 가정치라 매번 "받기"에 성공하므로 기준일 계산에서 뺀다. live가 없으면 샘플 기준일
  const live = caches.filter((c) => c.origin === "live" && c.vendor !== "onprem")
    .map((c) => c.fetchedAt).sort();
  const asOf = live[0] ?? base.asOf;
  return PriceCatalog.parse({ asOf, rows });
}

// 저장용 출처 요약 (contracts StoredCostEstimate.priceSources). 캐시가 없는 벤더는 sample로 적는다
export function summarizePriceSources(
  opts: { dir?: URL; vendors?: Provider[] } = {},
): PriceSourceSummary[] {
  const base = loadSampleCatalog();
  return (opts.vendors ?? Provider.options).map((v) => {
    const c = readCache(v, opts.dir);
    return c
      ? { vendor: v, origin: c.origin, fetchedAt: c.fetchedAt, urls: c.sources.map((s) => s.url) }
      : { vendor: v, origin: "sample" as const, fetchedAt: base.asOf, urls: [] };
  });
}
