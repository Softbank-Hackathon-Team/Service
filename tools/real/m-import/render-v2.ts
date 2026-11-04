// M-import Builder v2 산출물 (상태: AI 초안). 가져온 IR v2 → 도착 Builder(aws·gcp·onprem) → 도착별 terraform.tfvars.json·values.json·call.json
// 순수 함수만 (클라우드·DB 호출 0). <env:키> 자리표시는 TF_FACT_* 가 있으면 채우고, 남은 키는 missing.txt 로 (plan 가능 여부 판단용)
// 사용 (worktree 안 .m-import/ 로 복사해서): npx tsx .m-import/render-v2.ts <spec.json> <출력 폴더> <tenantId>
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AppSpecV2, type Provider } from "@svc/contracts";
import { factsFromEnv, fillTfVars, targetBuilderFor } from "@svc/adapters";

export interface RenderRow { provider: Provider; result: "PASS" | "FAIL"; note: string; missing: string[] }

export function renderAll(specV2: unknown, out: string, tenantId: string, env: NodeJS.ProcessEnv = process.env): RenderRow[] {
  const spec = AppSpecV2.parse(specV2);
  const rows: RenderRow[] = [];
  for (const p of ["aws", "gcp", "onprem"] as Provider[]) {
    const dir = join(out, p);
    mkdirSync(dir, { recursive: true });
    // DRAFT(ai): envId·migrationId 는 결정적 고정값 (이름 해시가 실행마다 안 바뀌게). 실제 계획은 API 계획서 쪽을 본다
    const t = { envId: "00000000-0000-4000-8000-0000000000aa", provider: p, region: "default", tenantId, migrationId: "00000000-0000-4000-8000-0000000000bb" };
    try {
      const b = targetBuilderFor(p);
      const tf = b.toTerraformV2(spec, t as never);
      const values = b.toWorkloadValues(spec, {}, t as never);
      const filled = fillTfVars(tf.vars, factsFromEnv(env));
      writeFileSync(join(dir, "terraform.tfvars.json"), JSON.stringify(filled.vars, null, 2) + "\n");
      writeFileSync(join(dir, "values.json"), JSON.stringify(values, null, 2) + "\n");
      writeFileSync(join(dir, "call.json"), JSON.stringify({ root: tf.root, modules: tf.modules, instances: tf.instances }, null, 2) + "\n");
      writeFileSync(join(dir, "missing.txt"), filled.missing.sort().join("\n") + (filled.missing.length ? "\n" : ""));
      const wl = Array.isArray(values.workloads) ? values.workloads.length : 0;
      rows.push({ provider: p, result: "PASS", missing: filled.missing.sort(),
        note: `모듈 ${tf.instances.map((i) => `${i.kind}:${i.id}`).join(",")} · Helm 워크로드 ${wl}${filled.missing.length ? ` · 못 채운 사실 ${filled.missing.join(",")}` : ""}` });
    } catch (e) {
      const err = e as { code?: string; message?: string };
      writeFileSync(join(dir, "error.txt"), `${err.code ?? ""} ${err.message ?? String(e)}\n`);
      rows.push({ provider: p, result: "FAIL", missing: [], note: `${err.code ?? "ERROR"}: ${(err.message ?? "").slice(0, 300)}` });
    }
  }
  return rows;
}

if (process.argv[1]?.endsWith("render-v2.ts")) {
  const [file, out, tenant] = process.argv.slice(2);
  if (!file || !out || !tenant) { console.error("사용: render-v2.ts <spec.json> <출력 폴더> <tenantId>"); process.exit(2); }
  const view = JSON.parse(readFileSync(file, "utf8"));
  const rows = renderAll(view.specV2 ?? view, out, tenant);
  // 한 줄 = provider<TAB>결과<TAB>비고 (m-import.sh 가 읽음)
  for (const r of rows) console.log(`${r.provider}\t${r.result}\t${r.note.replace(/\t|\n/g, " ")}`);
  process.exit(rows.some((r) => r.result === "FAIL") ? 1 : 0);
}
