// VTA2: 진짜 terraform 바이너리로 v2 작업 폴더 모양 확인 (클라우드 호출 0: terraform_data + 빈 provider 없음).
//   확인하는 것: -chdir=root 에서 backend "local" path="../terraform.tfstate" 가 작업 폴더 바로 아래에 state 를 쓰는지,
//   outputs 파싱, list()/destroy() 가 그 state 를 보는지. terraform 이 없으면(TF_BIN 도 PATH 도 없음) 이 시험은 환경 때문에 건너뜀
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRealTerraformRunner } from "../src/index.js";

const TF = process.env.TF_BIN ?? "terraform";
const hasTf = spawnSync(TF, ["version"], { stdio: "ignore" }).status === 0;
const MID = "4a8c0000-0000-4000-8000-0000000000dd";
const TEN = "t-0a1b2c3d";

function fakeModules() {
  const m = mkdtempSync(join(tmpdir(), "vta2-mod-"));
  mkdirSync(join(m, "aws/root"), { recursive: true });
  mkdirSync(join(m, "aws/kinds/postgres"), { recursive: true });
  writeFileSync(join(m, "aws/kinds/postgres/main.tf"), `
variable "cfg" { type = any }
resource "terraform_data" "db" { input = var.cfg.id }
output "link" { value = { host = "h-\${var.cfg.id}" } }
`);
  writeFileSync(join(m, "aws/root/main.tf"), `
terraform {
  backend "local" { path = "../terraform.tfstate" }
}
variable "postgres_json" { type = string }
locals { postgres = { for p in jsondecode(var.postgres_json) : p.id => p } }
module "postgres" {
  source   = "../kinds/postgres"
  for_each = local.postgres
  cfg      = each.value
}
output "link_outputs" { value = { for id, x in module.postgres : id => x.link } }
output "db_address" { value = "shop.example" }
`);
  return m;
}

test("진짜 terraform: v2 apply 가 작업 폴더 바로 아래 state 를 만들고, list·destroy 가 그걸 보고 지운다", { skip: !hasTf && "terraform 실행 파일 없음" }, async () => {
  const work = mkdtempSync(join(tmpdir(), "vta2-work-"));
  const r = createRealTerraformRunner({ workRoot: work, moduleRoot: fakeModules(), terraformBin: TF, env: { PATH: process.env.PATH, HOME: process.env.HOME, TF_FETCH_DB_SECRET: "0" } });
  const res = await r.apply("aws", MID, { postgres_json: JSON.stringify([{ id: "shop-db" }]) }, undefined, TEN);
  assert.equal(res.ok, true, res.log.join("\n"));
  const dir = join(work, TEN, MID);
  assert.ok(existsSync(join(dir, "terraform.tfstate")), "state 가 작업 폴더 바로 아래에 있어야 함");
  assert.equal(existsSync(join(dir, "root", "terraform.tfstate")), false);
  assert.deepEqual(JSON.parse(res.tfOutputs.link_outputs!), { "shop-db": { host: "h-shop-db" } });
  assert.equal(JSON.parse(readFileSync(join(dir, "outputs.json"), "utf8")).db_address, "shop.example");
  assert.deepEqual(r.list().map((x) => [x.migrationId, x.resources]), [[MID, 1]]);
  const d = await r.destroy(MID);
  assert.equal(d.ok, true, d.log.join("\n"));
  assert.equal(r.list()[0]!.resources, 0);
});

test("진짜 terraform: 변수 검증 실패(postgres_json 빠짐)는 plan 에서 실패 → failedStep=plan, state 없음", { skip: !hasTf && "terraform 실행 파일 없음" }, async () => {
  const work = mkdtempSync(join(tmpdir(), "vta2-work-"));
  const r = createRealTerraformRunner({ workRoot: work, moduleRoot: fakeModules(), terraformBin: TF, env: { PATH: process.env.PATH, HOME: process.env.HOME, TF_DESTROY_ON_FAIL: "0" } });
  const res = await r.apply("aws", MID, {}, undefined, TEN);
  assert.equal(res.ok, false);
  assert.equal(res.failedStep, "plan");
  assert.equal(existsSync(join(work, TEN, MID, "terraform.tfstate")), false);
});
