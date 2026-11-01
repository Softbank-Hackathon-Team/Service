// Z70 DRAFT(ai): 진짜 terraform 길(Z89: 기본, MOCK_IAC=1 이면 흉내) 옆에서 쓰는 도구. destroy 말고는 클라우드 자원을 건드리는 명령이 없다
//   npm run tf:real -- check <aws|gcp|onprem>     자리표시가 다 채워지나만 본다 (terraform 안 부름, 어디서나 안전)
//   npm run tf:real -- plan  <aws|gcp|onprem>     데모 명세로 terraform init + plan 만 (자원 안 만듦, 클라우드 자격 필요)
//   npm run tf:real -- list                        작업 폴더 목록 + state 에 남은 자원 수
//   npm run tf:real -- destroy <이전 id>           그 이전이 만든 자원 파기 (사람이 직접 돌린다)
//   npm run tf:real -- export <aws|gcp> <폴더> [--no-identity]
//                                                  Z77 B': 모듈 *.tf + terraform.tfvars.json 을 폴더에 쓴다 (terraform 안 부름).
//                                                  사람이 그 폴더에서 terraform init/apply 를 직접 돌린다 (worker IaC 길을 안 씀).
//                                                  --no-identity: gcp 앱 신원(GSA·IAM 바인딩) 빼기. aws 는 클러스터 이름이 비면 저절로 빠진다
import { cpSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppSpec, Provider } from "@svc/contracts";
import { adapterFor, createRealTerraformRunner, DEFAULT_MODULE_ROOT, DEMO_INVENTORY, dbNetworkFromEnv, factEnvName, factsFromEnv, fillTfVars, REAL_MODULE_DIR, withDbNetwork } from "@svc/adapters";

const [cmd, arg, arg2] = process.argv.slice(2);

function demoVars(p: Provider) {
  const src = p === "azure_mock" ? "aws" : p;
  const spec = AppSpec.parse(adapterFor(src).normalize(DEMO_INVENTORY[src]).spec);
  // Z77: worker 와 같은 규칙으로 DB_PUBLIC·DB_DISPOSABLE 변수를 더한다
  const tf = withDbNetwork(adapterFor(p).toTerraform(spec, { envId: "33333333-3333-4333-8333-333333333333", provider: p, region: "default" }), p);
  const facts = factsFromEnv(process.env, { tenantId: "t-demo0000", migrationId: "dry-run",
    accountId: p === "aws" ? process.env.TF_FACT_ACCOUNT_ID : undefined, projectId: p === "gcp" ? process.env.TF_FACT_PROJECT_ID : undefined });
  return fillTfVars(tf.vars, facts);
}

async function main() {
  if (cmd === "check" || cmd === "plan") {
    const p = Provider.parse(arg);
    if (p === "azure_mock") throw new Error("azure_mock 은 Mock 실행기만 (진짜 terraform 없음)");
    const f = demoVars(p);
    if (f.missing.length) {
      console.log(`채워야 할 환경변수 ${f.missing.length}개: ${f.missing.map(factEnvName).join(" ")}`);
      process.exit(cmd === "check" ? 1 : 2);
    }
    console.log(`OK 자리표시 0개 (${p}, 변수 ${Object.keys(f.vars).length}개)`);
    const n = dbNetworkFromEnv(p);
    console.log(n ? `DB 네트워크: 공개=${n.summary.public} 허용=${n.summary.peerCidrs.length}개 파기쉬움=${n.summary.disposable}` : "DB 네트워크: 사설 (기본)");
    if (cmd === "check") return;
    const dir = mkdtempSync(join(tmpdir(), "svc-tf-plan-"));
    const r = createRealTerraformRunner({ workRoot: dir });
    const out = await r.planOnly(p, f.vars);
    for (const l of out.log) console.log(l);
    writeFileSync(join(dir, "README.txt"), "plan only. no state. safe to delete\n");
    console.log(out.ok ? `OK plan 끝 (자원 안 만듦) ${out.summary ?? ""}` : "plan 실패 (위 로그)");
    process.exit(out.ok ? 0 : 1);
  }
  if (cmd === "export") {
    const p = Provider.parse(arg);
    if (p !== "aws" && p !== "gcp") throw new Error("export 는 aws·gcp 만");
    if (!arg2) throw new Error("폴더가 필요하다: npm run tf:real -- export <aws|gcp> <폴더>");
    const f = demoVars(p);
    if (f.missing.length) {
      console.log(`채워야 할 환경변수 ${f.missing.length}개: ${f.missing.map(factEnvName).join(" ")}`);
      process.exit(1);
    }
    const vars: Record<string, string | number | boolean> = { ...f.vars, ...(p === "gcp" && process.argv.includes("--no-identity") ? { app_identity: false } : {}) };
    // Z38 R8-11: export 는 그날 지우는 데모용. 삭제 보호가 켜진 DB 를 내보내면 사람이 돌리는 terraform destroy 가 DB 에서 막혀
    //            Cloud SQL·RDS 가 남는다 (자원 0 규칙). DB_DISPOSABLE=1 을 요구한다
    if (vars.db_enabled === true && vars.db_deletion_protection !== false) {
      console.log("export 거부: DB 삭제 보호가 켜져 있음 → DB_DISPOSABLE=1 을 같이 줘야 한다 (그날 destroy 로 지울 데모 DB)");
      process.exit(1);
    }
    const src = join(DEFAULT_MODULE_ROOT, REAL_MODULE_DIR[p]!);
    mkdirSync(arg2, { recursive: true });
    for (const name of readdirSync(src)) if (name.endsWith(".tf")) cpSync(join(src, name), join(arg2, name));
    writeFileSync(join(arg2, "terraform.tfvars.json"), JSON.stringify(vars, null, 2));
    const n = dbNetworkFromEnv(p);
    console.log(`OK export ${p} → ${arg2} (변수 ${Object.keys(vars).length}개, 공개=${n?.summary.public ?? false}, 앱 신원=${vars.app_identity === false ? "끔" : vars.cluster_name === "" ? "끔(클러스터 없음)" : "켬"})`);
    return;
  }
  const r = createRealTerraformRunner();
  if (cmd === "list") {
    const rows = r.list();
    if (!rows.length) console.log(`작업 폴더 없음 (${r.workRoot})`);
    for (const x of rows) console.log(`${x.migrationId}  ${x.tenant ?? "-"}  ${x.provider}  state 자원 ${x.resources}개  ${x.workDir}`);
    return;
  }
  if (cmd === "destroy") {
    if (!arg) throw new Error("이전 id 가 필요하다");
    const d = await r.destroy(arg);
    for (const l of d.log) console.log(l);
    console.log(d.ok ? `OK destroy ${arg} (${d.elapsedMs}ms)` : `실패 destroy ${arg} → 클라우드 콘솔에서 남은 자원 확인`);
    process.exit(d.ok ? 0 : 1);
  }
  console.log("사용: npm run tf:real -- check|plan <aws|gcp|onprem> | export <aws|gcp> <폴더> [--no-identity] | list | destroy <이전 id>");
  process.exit(2);
}
main().catch((e) => { console.error((e as Error).message); process.exit(1); });
