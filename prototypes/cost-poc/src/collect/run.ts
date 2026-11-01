import { writeFileSync } from "node:fs";
import { collectAws } from "./aws.js";
import { collectAzure } from "./azure.js";
import { collectGcp } from "./gcp.js";
import { collectOnprem, DEFAULT_ONPREM } from "./onprem.js";
import type { PriceFile } from "./types.js";

// DRAFT(ai): 네트워크를 쓰는 유일한 진입점. 계산 코어는 이 결과 파일만 읽는다.
const dir = new URL("../../data/prices/", import.meta.url);
const now = new Date();
const only = process.argv.slice(2);
const want = (v: string) => only.length === 0 || only.includes(v);

function save(f: PriceFile) {
  writeFileSync(new URL(`${f.vendor}.json`, dir), `${JSON.stringify(f, null, 2)}\n`);
  console.log(`${f.vendor}: ${f.lines.length}줄, 빠짐 ${f.missing.length}개 ${f.missing.join(" ")}`);
}
if (want("onprem")) save(collectOnprem(DEFAULT_ONPREM, now));
if (want("gcp")) save(await collectGcp(now, new URL("gcp-official-transcript.json", dir)));
if (want("azure")) save(await collectAzure(now));
if (want("aws")) save(await collectAws(now));
