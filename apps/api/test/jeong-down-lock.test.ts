// tools/jeong-down.sh UPREV-B: 이미 도는 down 이 있으면 두 번째를 띄우지 않는다. 클라우드·terraform 호출 없음 (잠금 분기에서 끝남)
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../../../tools/jeong-down.sh", import.meta.url));

test("jeong-down: 살아 있는 jeong-down 이 잠금을 쥐고 있으면 '이미 내리는 중' 으로 끝, 새로 안 띄움", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jd-"));
  const fake = join(dir, "jeong-down-fake.sh");
  writeFileSync(fake, "#!/bin/sh\nsleep 30\n"); chmodSync(fake, 0o755);
  const p = spawn("sh", [fake], { stdio: "ignore" });
  try {
    writeFileSync(join(dir, "down.lock"), String(p.pid));
    const r = spawnSync("sh", [SCRIPT], { encoding: "utf8", env: { PATH: process.env.PATH ?? "", DEMO_DAY_STATE: dir } });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /이미 내리는 중/);
    assert.equal(existsSync(join(dir, "jeong-progress.log")), false, "새 down 이 시작되면 안 된다");
  } finally { p.kill(); }
});

test("jeong-down: 잠금의 pid 가 다른 프로그램(pid 재사용)이면 낡은 잠금으로 보고, 터미널이 아니면 거부(exit 2)", () => {
  const dir = mkdtempSync(join(tmpdir(), "jd-"));
  const other = spawn("sleep", ["30"], { stdio: "ignore" });   // 살아 있지만 jeong-down 이 아님
  writeFileSync(join(dir, "down.lock"), String(other.pid));
  const r = spawnSync("sh", [SCRIPT], { encoding: "utf8", env: { PATH: process.env.PATH ?? "", DEMO_DAY_STATE: dir } });
  other.kill();
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.doesNotMatch(r.stdout, /이미 내리는 중/);
  assert.match(r.stdout, /Jeong 터미널에서만/);
});
