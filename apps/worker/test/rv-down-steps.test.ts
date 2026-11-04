// RV-04·RV-05: demo-day.sh down 단계 함수(d_connect_stack, d_ecs_source)를 떼어 가짜 aws·bash 로 돌린다 (클라우드 호출 0)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const src = readFileSync(new URL("../../../tools/demo-day.sh", import.meta.url), "utf8").split("\n");
function fn(name: string): string {
  const a = src.findIndex((l) => l.startsWith(`${name}() {`));
  assert.ok(a >= 0, `${name} 없음`);
  const b = src.findIndex((l, i) => i > a && l === "}");
  return src.slice(a, b + 1).join("\n");
}

function sandbox(awsScript: string) {
  const dir = mkdtempSync(join(tmpdir(), "rv-down-"));
  const bin = join(dir, "bin"); mkdirSync(bin);
  writeFileSync(join(bin, "aws"), `#!/bin/sh\necho "aws $*" >> "${dir}/calls"\n${awsScript}\n`); chmodSync(join(bin, "aws"), 0o755);
  // ecs-source.sh down 은 호출 여부만 본다
  mkdirSync(join(dir, "tools")); writeFileSync(join(dir, "tools", "ecs-source.sh"), `echo "ecs-source $*" >> "${dir}/calls"\n`);
  return { dir, env: { PATH: `${bin}:${process.env.PATH}`, HOME: dir, DRY: "0", PROGRESS: join(dir, "progress") } };
}
const calls = (dir: string) => { try { return readFileSync(join(dir, "calls"), "utf8"); } catch { return ""; } };
const run = (dir: string, env: NodeJS.ProcessEnv, body: string) =>
  execFileSync("bash", ["-c", body], { cwd: dir, env, encoding: "utf8" });

test("RV-04 역할 없이 되돌려진 연결 스택도 이름(svc-connect-*)으로 찾아 지운다", () => {
  const { dir, env } = sandbox(`case "$*" in
  *describe-stack-resources*) exit 254 ;;
  *describe-stacks*) echo "svc-connect-ab12cd34" ;;
  *) exit 0 ;;
esac`);
  const out = run(dir, env, `${fn("d_connect_stack")}\nd_connect_stack; echo rc=$?`);
  assert.match(out, /연결 스택 지움: svc-connect-ab12cd34/);
  assert.match(calls(dir), /delete-stack --stack-name svc-connect-ab12cd34/);
  assert.match(out, /rc=0/);
});

test("RV-04 역할로 찾은 스택과 이름으로 찾은 스택이 같으면 한 번만 지운다, 없으면 '없음'", () => {
  const a = sandbox(`case "$*" in *describe-stack-resources*) echo "svc-connect-x1" ;; *describe-stacks*) echo "svc-connect-x1" ;; esac`);
  run(a.dir, a.env, `${fn("d_connect_stack")}\nd_connect_stack`);
  assert.equal((calls(a.dir).match(/delete-stack /g) ?? []).length, 1);
  const b = sandbox(`case "$*" in *describe-stack-resources*) exit 254 ;; *describe-stacks*) echo "" ;; esac`);
  assert.match(run(b.dir, b.env, `${fn("d_connect_stack")}\nd_connect_stack`), /연결 스택 없음/);
  assert.doesNotMatch(calls(b.dir), /delete-stack/);
});

test("RV-05 ECS 출발 샘플 상태에 자원이 있으면 down 이 ecs-source.sh down 을 부른다", () => {
  const { dir, env } = sandbox("exit 0");
  mkdirSync(join(dir, "infra/modules/aws/ecs-source"), { recursive: true });
  writeFileSync(join(dir, "infra/modules/aws/ecs-source/terraform.tfstate"), JSON.stringify({ resources: [{ type: "aws_ecs_service", name: "api" }] }, null, 2));
  const out = run(dir, env, `${fn("d_ecs_source")}\nd_ecs_source; echo rc=$?`);
  assert.match(calls(dir), /ecs-source down/);
  assert.match(out, /rc=0/);
});

test("PF FM-CLD-hunt-cloud-24: 클러스터 전에 실패해 보안 그룹·IAM 역할·로그 그룹만 남은 상태도 down 을 부른다", () => {
  const { dir, env } = sandbox("exit 0");
  mkdirSync(join(dir, "infra/modules/aws/ecs-source"), { recursive: true });
  writeFileSync(join(dir, "infra/modules/aws/ecs-source/terraform.tfstate"), JSON.stringify({ resources: [
    { mode: "managed", type: "aws_security_group", name: "svc" }, { mode: "managed", type: "aws_iam_role", name: "exec" },
    { mode: "managed", type: "aws_cloudwatch_log_group", name: "svc" }] }, null, 2));
  run(dir, env, `${fn("d_ecs_source")}\nd_ecs_source`);
  assert.match(calls(dir), /ecs-source down/);
});

test("RV-05 상태가 없거나 비었거나 DEMO_DAY_ECS_DOWN=0 이면 안 부른다", () => {
  const a = sandbox("exit 0");
  assert.match(run(a.dir, a.env, `${fn("d_ecs_source")}\nd_ecs_source`), /건너뜀/);
  mkdirSync(join(a.dir, "infra/modules/aws/ecs-source"), { recursive: true });
  writeFileSync(join(a.dir, "infra/modules/aws/ecs-source/terraform.tfstate"), JSON.stringify({ resources: [] }));
  assert.match(run(a.dir, a.env, `${fn("d_ecs_source")}\nd_ecs_source`), /건너뜀/);
  writeFileSync(join(a.dir, "infra/modules/aws/ecs-source/terraform.tfstate"), JSON.stringify({ resources: [{ type: "aws_ecs_cluster" }] }, null, 2));
  assert.match(run(a.dir, { ...a.env, DEMO_DAY_ECS_DOWN: "0" }, `${fn("d_ecs_source")}\nd_ecs_source`), /안 지움/);
  assert.doesNotMatch(calls(a.dir), /ecs-source/);
});
