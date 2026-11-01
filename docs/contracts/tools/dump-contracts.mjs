// contracts 패키지를 실제로 불러와 모양을 JSON으로 뽑는다.
// 실행: node --import tsx dump-contracts.mjs <뼈대 루트>
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const root = process.argv[2];
const req = createRequire(join(root, "packages/contracts/package.json"));
const { z } = await import(pathToFileURL(req.resolve("zod")).href);
const C = await import(pathToFileURL(join(root, "packages/contracts/src/index.ts")).href);

const isZod = (v) => v && typeof v === "object" && "_zod" in v;
const out = { schemas: {}, consts: {}, jobSchemas: {} };
const names = new Map();
for (const [k, v] of Object.entries(C)) {
  if (isZod(v)) {
    names.set(v, k);
    try { out.schemas[k] = z.toJSONSchema(v, { unrepresentable: "any" }); }
    catch (e) { out.schemas[k] = { error: String(e) }; }
  } else if (v && typeof v === "object") {
    out.consts[k] = v;
  }
}
if (C.JOB_SCHEMAS)
  for (const [q, s] of Object.entries(C.JOB_SCHEMAS))
    out.jobSchemas[q] = names.get(s) ?? "(이름 없는 스키마)";
delete out.consts.JOB_SCHEMAS;
process.stdout.write(JSON.stringify(out));
