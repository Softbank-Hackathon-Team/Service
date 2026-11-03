// RUNTIMEMAP v2: kinds/vm HCL ↔ VmTfVars 대조 (terraform 안 돌림). 정상 1(aws·gcp 모두 칸이 같음) + 거부 1(칸이 빠진/남는 HCL 은 걸림)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { VmTfVars, TF_KIND_VARS } from "../src/index.js";

const infra = join(dirname(fileURLToPath(import.meta.url)), "../../../infra/modules");
const read = (p: string, ...rest: string[]) => readFileSync(join(infra, p, ...rest), "utf8");
const declared = (src: string) => {
  const body = src.match(/variable "cfg" \{\s*type = object\(\{([\s\S]*?)\}\)/)?.[1] ?? "";
  return [...body.matchAll(/^\s*([a-z_]+)\s*=/gm)].map((m) => m[1]!).sort();
};
const used = (src: string) => [...new Set([...src.matchAll(/\bcfg\.([a-z_]+)/g)].map((m) => m[1]!))].sort();
const fields = () => Object.keys(VmTfVars.shape).sort();
const diff = (src: string) => ({
  missing: fields().filter((f) => !declared(src).includes(f)),
  extra: declared(src).filter((f) => !fields().includes(f)),
  unknownRead: used(src).filter((f) => !fields().includes(f)),
});

test("HCL 대조: vm kinds 의 cfg 선언 칸 = VmTfVars 칸, 읽는 칸 ⊂ VmTfVars (aws·gcp)", () => {
  assert.equal(TF_KIND_VARS.vm, VmTfVars);
  for (const p of ["aws", "gcp"]) {
    const d = diff(read(p, "kinds", "vm", "main.tf"));
    assert.deepEqual(d, { missing: [], extra: [], unknownRead: [] }, p);
  }
});

test("루트 연결: aws·gcp 루트가 vm_json 변수와 kinds/vm 모듈(for_each)을 가진다", () => {
  for (const p of ["aws", "gcp"]) {
    const root = read(p, "root", "main.tf");
    assert.match(root, /variable "vm_json"/, p);
    assert.match(root, /module "vm" \{[^}]*source\s*=\s*"\.\.\/kinds\/vm"[^}]*for_each\s*=\s*local\.vm_cfg/s, p);
    assert.match(root, /keys\(local\.vm\)/, `${p}: link_ids 에 vm id 가 없음 (종류 간 id 겹침 검사 빠짐)`);
  }
});

test("거부: 칸이 빠지거나 HCL 전용 칸이 남거나 계약에 없는 칸을 읽는 모듈은 대조가 잡는다", () => {
  const ok = read("aws", "kinds", "vm", "main.tf");
  const dropped = ok.replace(/^\s*health_path\s*=\s*optional\(string\)\n/m, "");
  assert.deepEqual(diff(dropped).missing, ["health_path"]);
  const extra = ok.replace(/(variable "cfg" \{\s*type = object\(\{\n)/, "$1    retries = optional(number)\n");
  assert.deepEqual(diff(extra).extra, ["retries"]);
  assert.deepEqual(diff(`${ok}\nlocals { x = var.cfg.nope }`).unknownRead, ["nope"]);
  // 계약 쪽: 모르는 칸·빠진 칸은 VmTfVars 가 거부
  assert.throws(() => VmTfVars.parse({ id: "x" }));
});
