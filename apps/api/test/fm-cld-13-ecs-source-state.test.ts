// FM-CLD-13: ecs-source.sh 가 terraform 상태를 레포 밖 STATE 폴더에 두고(-state), 예전에 레포 모듈 폴더에 생긴 상태는 한 번 옮긴다.
//   가짜 terraform·aws 로만 돈다 (클라우드 호출 0). ECS_IMAGE 는 digest 로 줘서 docker 를 안 부름
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const MOD_STATE = join(ROOT, "infra/modules/aws/ecs-source/terraform.tfstate");
const had = existsSync(MOD_STATE);   // 사람이 진짜 상태를 둔 레포면 건드리지 않는다
after(() => { if (!had) rmSync(MOD_STATE, { force: true }); });

function run(cmd: string) {
  const bin = mkdtempSync(join(tmpdir(), "ecs-bin-")), state = mkdtempSync(join(tmpdir(), "ecs-state-"));
  const log = join(bin, "tf.log");
  writeFileSync(join(bin, "terraform"), `#!/bin/sh\necho "$*" >> ${log}\nexit 0\n`); chmodSync(join(bin, "terraform"), 0o755);
  writeFileSync(join(bin, "aws"), "#!/bin/sh\necho 0\n"); chmodSync(join(bin, "aws"), 0o755);
  const r = spawnSync("bash", ["tools/ecs-source.sh", cmd], { cwd: ROOT, encoding: "utf8",
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: state, ECS_SOURCE_STATE: state, ECS_IMAGE: "r/x@sha256:" + "a".repeat(64) } });
  return { code: r.status, out: r.stdout + r.stderr, tf: existsSync(log) ? readFileSync(log, "utf8") : "", state };
}

test("apply·destroy 에 -state=<STATE>/terraform.tfstate (레포 안에 상태가 안 생김)", { skip: had ? "레포에 진짜 상태 파일 있음" : false }, () => {
  const r = run("down");
  assert.match(r.tf, new RegExp(`destroy .*-state=${r.state}/terraform\\.tfstate`), r.tf);
  assert.match(r.out, /상태 파일 없음/);
});

test("거부(잃지 않기): 예전 실행이 레포 모듈 폴더에 남긴 상태는 STATE 로 옮겨서 destroy 가 그것을 씀", { skip: had ? "레포에 진짜 상태 파일 있음" : false }, () => {
  writeFileSync(MOD_STATE, '{"version":4,"resources":[{"type":"aws_ecs_cluster"}]}');
  const r = run("down");
  assert.equal(existsSync(MOD_STATE), false);
  assert.match(readFileSync(join(r.state, "terraform.tfstate"), "utf8"), /aws_ecs_cluster/);
  assert.match(r.out, /예전 상태 파일을 .* 로 옮김/);
});
