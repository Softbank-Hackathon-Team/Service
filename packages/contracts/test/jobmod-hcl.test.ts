// JOBMOD: kinds/job HCL ↔ JobTfVars 대조 (terraform 안 돌림). 정상 1(aws·gcp 모두 칸이 같음) + 거부 1(칸이 빠진/남는 HCL 은 걸림)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { JobTfVars, TF_KIND_VARS } from "../src/index.js";

const infra = join(dirname(fileURLToPath(import.meta.url)), "../../../infra/modules");
const read = (p: string, ...rest: string[]) => readFileSync(join(infra, p, ...rest), "utf8");
const declared = (src: string) => {
  const body = src.match(/variable "cfg" \{\s*type = object\(\{([\s\S]*?)\}\)/)?.[1] ?? "";
  return [...body.matchAll(/^\s*([a-z_]+)\s*=/gm)].map((m) => m[1]!).sort();
};
const used = (src: string) => [...new Set([...src.matchAll(/\bcfg\.([a-z_]+)/g)].map((m) => m[1]!))].sort();
const fields = () => Object.keys(JobTfVars.shape).sort();
const diff = (src: string) => ({
  missing: fields().filter((f) => !declared(src).includes(f)),
  extra: declared(src).filter((f) => !fields().includes(f)),
  unknownRead: used(src).filter((f) => !fields().includes(f)),
});

test("HCL 대조: job kinds 의 cfg 선언 칸 = JobTfVars 칸, 읽는 칸 ⊂ JobTfVars (aws·gcp)", () => {
  assert.equal(TF_KIND_VARS.job, JobTfVars);
  for (const p of ["aws", "gcp"]) {
    const d = diff(read(p, "kinds", "job", "main.tf"));
    assert.deepEqual(d, { missing: [], extra: [], unknownRead: [] }, p);
  }
});

test("루트 연결: aws·gcp 루트가 job_json 변수와 kinds/job 모듈(for_each)을 가진다", () => {
  for (const p of ["aws", "gcp"]) {
    const root = read(p, "root", "main.tf");
    assert.match(root, /variable "job_json"/, p);
    assert.match(root, /module "job" \{[^}]*source\s*=\s*"\.\.\/kinds\/job"[^}]*for_each\s*=\s*local\.job_cfg/s, p);
    assert.match(root, /keys\(local\.job\)/, `${p}: link_ids 에 job id 가 없음 (종류 간 id 겹침 검사 빠짐)`);
  }
});

test("거부: 칸이 빠지거나 HCL 전용 칸이 남거나 계약에 없는 칸을 읽는 모듈은 대조가 잡는다", () => {
  const ok = read("aws", "kinds", "job", "main.tf");
  const dropped = ok.replace(/^\s*suspend\s*=\s*optional\(bool\)\n/m, "");
  assert.deepEqual(diff(dropped).missing, ["suspend"]);
  const extra = ok.replace(/(variable "cfg" \{\s*type = object\(\{\n)/, "$1    retries = optional(number)\n");
  assert.deepEqual(diff(extra).extra, ["retries"]);
  assert.deepEqual(diff(`${ok}\nlocals { x = var.cfg.nope }`).unknownRead, ["nope"]);
  // 계약 쪽: 모르는 칸·빠진 칸은 JobTfVars 가 거부
  assert.throws(() => JobTfVars.parse({ id: "x" }));
});
