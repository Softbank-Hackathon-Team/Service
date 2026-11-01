// DRAFT(ai): AppSpec + 대상 3곳 → G 어댑터의 toTerraform / toHelmValues 결과를 파일로 쓴다.
// Service 레포 루트에서: npx tsx <이 파일> <sample-app/spec 경로> <출력 폴더>
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { AppSpec } from "@svc/contracts";
import { adapterFor } from "@svc/adapters";

const [specDir, outDir] = process.argv.slice(2);
if (!specDir || !outDir) throw new Error("사용: tsx gen-values.ts <spec 폴더> <출력 폴더>");
const spec = AppSpec.parse(JSON.parse(readFileSync(join(specDir, "appspec.shop.json"), "utf8")));
mkdirSync(outDir, { recursive: true });

for (const f of readdirSync(join(specDir, "targets")).filter((x) => x.endsWith(".json")).sort()) {
  const target = JSON.parse(readFileSync(join(specDir, "targets", f), "utf8"));
  const a = adapterFor(target.provider);
  const base = f.replace(/\.json$/, "");
  const tf = a.toTerraform(spec, target);
  const planned = a.toHelmValues(spec, {}, target);
  writeFileSync(join(outDir, `${base}.values.json`), JSON.stringify(planned, null, 2) + "\n");
  writeFileSync(join(outDir, `${base}.tfvars.json`), JSON.stringify(tf, null, 2) + "\n");
  console.log(`${base}: image=${(planned as { image: { ref: string } }).image.ref}`);
}
