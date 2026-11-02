// TA2: 실행기 v2 (고정 루트 + 종류 모듈). terraform·aws·gcloud 는 절대 부르지 않는다 (가짜 exec 가 받은 명령만 적는다)
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRealTerraformRunner, DEFAULT_MODULE_ROOT, isV2WorkDir, type Exec, type ExecResult } from "../src/index.js";
import { MODULE_DIGEST } from "../src/module-digests.js";
import { MODULES } from "../scripts/module-digest.js";
import { LINK_OUTPUTS } from "@svc/contracts";

const MID = "4a8c0000-0000-4000-8000-0000000000bb";
const TEN = "t-0a1b2c3d";
const OUTPUTS = JSON.stringify({
  link_outputs: { value: { "shop-db": { host: "h", port: "5432", url: "u", user: "app" } }, sensitive: false },
  db_address: { value: "shop.abc.rds.amazonaws.com", sensitive: false },
  db_master_secret_arn: { value: "arn:aws:secretsmanager:ap-northeast-2:111122223333:secret:rds!x", sensitive: false },
});
function fakeExec() {
  const calls: { cmd: string; args: string[]; cwd: string }[] = [];
  const exec: Exec = async (cmd, args, o) => {
    calls.push({ cmd, args, cwd: o.cwd });
    const r = (code: number, stdout = ""): ExecResult => ({ code, stdout, stderr: "", ms: 1 });
    const sub = args.find((a) => !a.startsWith("-chdir")) ?? "";
    if (sub === "output") return r(0, OUTPUTS);
    if (sub === "secretsmanager") return r(0, JSON.stringify({ username: "postgres", password: "pw" }));
    return r(0, "ok");
  };
  return { exec, calls };
}
const tmp = () => mkdtempSync(join(tmpdir(), "ta2-"));
const sorted = (d: string) => readdirSync(d).sort();

test("v2 apply: root/·kinds/ 복사(tests/ 제외), -chdir=root, tfvars·outputs·secret·tfplan 은 작업 폴더 바로 아래", async () => {
  const root = tmp(); const { exec, calls } = fakeExec();
  const r = createRealTerraformRunner({ exec, workRoot: root, env: {} });
  const res = await r.apply("aws", MID, { app_name: "shop" }, undefined, TEN, "v2");
  assert.equal(res.ok, true);
  const dir = join(root, TEN, MID);
  assert.equal(res.workDir, dir);
  assert.ok(calls.every((c) => c.cwd === dir));
  assert.deepEqual(calls.filter((c) => c.cmd === "terraform").map((c) => c.args.slice(0, 2)),
    [["-chdir=root", "init"], ["-chdir=root", "plan"], ["-chdir=root", "apply"], ["-chdir=root", "output"]]);
  const plan = calls.find((c) => c.args[1] === "plan")!.args;
  assert.ok(plan.includes("-var-file=../terraform.tfvars.json") && plan.includes("-out=../tfplan"));
  assert.equal(calls.find((c) => c.args[1] === "apply")!.args.at(-1), "../tfplan");
  // 복사: root/main.tf + kinds 6폴더, tests/ 없음, 작업 폴더 맨 위엔 *.tf 없음
  assert.ok(existsSync(join(dir, "root", "main.tf")));
  assert.equal(existsSync(join(dir, "root", "tests")), false);
  // I9: service-ecs(카탈로그, 루트 미연결)도 같이 복사된다
  assert.deepEqual(sorted(join(dir, "kinds")), ["cache", "identity", "namespace", "object-store", "postgres", "queue", "service-ecs"]);
  assert.ok(existsSync(join(dir, "kinds", "postgres", "main.tf")));
  assert.equal(existsSync(join(dir, "main.tf")), false);
  assert.ok(isV2WorkDir(dir));
  // tfvars·outputs·db-secret 는 바로 아래 (v1 과 같은 자리)
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "terraform.tfvars.json"), "utf8")), { app_name: "shop" });
  assert.ok(existsSync(join(dir, "outputs.json")) && existsSync(join(dir, "db-secret.json")));
  assert.equal(res.secretFetched, true);
  // link_outputs 는 JSON 문자열, v1 평평한 이름도 같이
  assert.deepEqual(JSON.parse(res.tfOutputs.link_outputs!), { "shop-db": { host: "h", port: "5432", url: "u", user: "app" } });
  assert.equal(res.tfOutputs.db_address, "shop.abc.rds.amazonaws.com");
});

test("v2 onprem: kinds 2폴더(namespace·netpol)만", async () => {
  const root = tmp(); const { exec } = fakeExec();
  const res = await createRealTerraformRunner({ exec, workRoot: root, env: {} }).apply("onprem", MID, {}, undefined, TEN, "v2");
  assert.deepEqual(sorted(join(res.workDir, "kinds")), ["namespace", "netpol"]);
});

test("v2 destroy·list: 작업 폴더 모양을 보고 -chdir=root 로 지운다. v1 폴더는 그대로 v1", async () => {
  const root = tmp(); const { exec, calls } = fakeExec();
  const r = createRealTerraformRunner({ exec, workRoot: root, env: {} });
  const V1 = "4a8c0000-0000-4000-8000-0000000000cc";
  await r.apply("gcp", MID, {}, undefined, TEN, "v2");
  await r.apply("gcp", V1, {}, undefined, TEN);   // v1 (layout 안 줌)
  writeFileSync(join(root, TEN, MID, "terraform.tfstate"), JSON.stringify({ resources: [{}, {}] }));
  assert.deepEqual(r.list().map((x) => [x.migrationId, x.provider, x.resources]).sort(), [[V1, "gcp", 0], [MID, "gcp", 2]].sort());
  calls.length = 0;
  assert.equal((await r.destroy(MID)).ok, true);
  assert.deepEqual(calls.map((c) => c.args.slice(0, 2)), [["-chdir=root", "init"], ["-chdir=root", "destroy"]]);
  assert.ok(calls[1]!.args.includes("-var-file=../terraform.tfvars.json"));
  calls.length = 0;
  assert.equal((await r.destroy(V1)).ok, true);
  assert.deepEqual(calls.map((c) => c.args[0]), ["init", "destroy"]);   // v1: -chdir 없음
  assert.ok(calls[1]!.args.includes("-var-file=terraform.tfvars.json"));
});

test("v2 planOnly: 전용 작업 폴더에서 -chdir=root plan", async () => {
  const { exec, calls } = fakeExec();
  const res = await createRealTerraformRunner({ exec, workRoot: tmp(), env: {} }).planOnly("aws", { a: 1 }, undefined, "v2");
  assert.equal(res.ok, true);
  assert.deepEqual(calls.map((c) => c.args.slice(0, 2)), [["-chdir=root", "init"], ["-chdir=root", "plan"]]);
});

test("v1 기본 동작 그대로: layout 안 주면 -chdir 없고 root/ 안 만든다", async () => {
  const root = tmp(); const { exec, calls } = fakeExec();
  const res = await createRealTerraformRunner({ exec, workRoot: root, env: {} }).apply("aws", MID, {});
  assert.equal(calls[0]!.args[0], "init");
  assert.equal(existsSync(join(res.workDir, "root")), false);
  assert.equal(isV2WorkDir(res.workDir), false);
});

test("거부: v2 루트가 없는 환경(azure_mock)·모듈 폴더에 root 가 없으면 에러, 나쁜 이전 id", async () => {
  const r = createRealTerraformRunner({ exec: fakeExec().exec, workRoot: tmp(), env: {} });
  await assert.rejects(r.apply("azure_mock", MID, {}, undefined, TEN, "v2"), /no real terraform module/);
  const r2 = createRealTerraformRunner({ exec: fakeExec().exec, workRoot: tmp(), moduleRoot: tmp(), env: {} });
  await assert.rejects(r2.apply("aws", MID, {}, undefined, TEN, "v2"), /no v2 root/);
  await assert.rejects(r.apply("aws", "../../etc", {}, undefined, TEN, "v2"), /bad migration id/);
});

test("지문: MODULES 가 infra 의 모든 root·kinds 폴더를 덮고, 지문 표 키와 같다", () => {
  const infra = DEFAULT_MODULE_ROOT;
  const found: string[] = [];
  for (const p of ["aws", "gcp", "onprem"]) {
    if (existsSync(join(infra, p, "root"))) found.push(`${p}/root`);
    const k = join(infra, p, "kinds");
    if (existsSync(k)) for (const d of readdirSync(k, { withFileTypes: true })) if (d.isDirectory()) found.push(`${p}/kinds/${d.name}`);
  }
  for (const f of found) assert.ok((MODULES as readonly string[]).includes(f), `MODULES 에 ${f} 없음`);
  assert.deepEqual([...MODULES].sort(), Object.keys(MODULE_DIGEST).sort());
});

// 정적 대조(terraform 안 돌림): 각 kinds 모듈의 output "link" 키가 IR LINK_OUTPUTS 와 같다
test("kinds 모듈 link 출력 키 = LINK_OUTPUTS (postgres·cache·objectStore·queue, aws·gcp)", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const infra = resolve(here, "../../../infra/modules");
  const map = { postgres: "postgres", cache: "cache", objectStore: "object-store", queue: "queue" } as const;
  for (const p of ["aws", "gcp"]) for (const [kind, dir] of Object.entries(map)) {
    const src = readFileSync(join(infra, p, "kinds", dir, "main.tf"), "utf8");
    const m = src.match(/output "link" \{\s*value = \{([\s\S]*?)\n  \}\n\}/);
    assert.ok(m, `${p}/${dir}: output "link" 없음`);
    const keys = [...m![1]!.matchAll(/^\s{4}(\w+)\s*=/gm)].map((x) => x[1]!).sort();
    assert.deepEqual(keys, [...(LINK_OUTPUTS as Record<string, readonly string[]>)[kind]!].sort(), `${p}/${dir}`);
  }
  // 루트 link_outputs 는 위 4종을 합치고 service 는 없음 (service 값은 TS 가 계산)
  for (const p of ["aws", "gcp"]) {
    const root = readFileSync(join(infra, p, "root", "main.tf"), "utf8");
    for (const m of ["postgres", "cache", "object_store", "queue"]) assert.match(root, new RegExp(`module\\.${m}`));
  }
});
