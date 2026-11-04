// RV-22: tools/cloud-precheck.sh 의 전체 제한(PRECHECK_TOTAL_SEC)이 바깥(up-preflight tmo 60)보다 먼저 와서, 스스로 끝나며 어느 점검이 시간에 걸렸는지 남긴다.
//   가짜 gcloud(오래 멈춤)·aws(바로 답)를 PATH 앞에 둔다. 진짜 클라우드 안 봄
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
function run(gcloudBody: string, env: Record<string, string>) {
  const d = mkdtempSync(join(tmpdir(), "rv22-"));
  writeFileSync(join(d, "gcloud"), `#!/bin/sh\necho "gcloud $*" >> "${d}/calls"\n${gcloudBody}\n`);
  writeFileSync(join(d, "aws"), `#!/bin/sh\ncase "$*" in *get-caller-identity*) echo 000000000000 ;; *Quota.Value*) echo 50 ;; *) echo 0 ;; esac\n`);
  for (const f of ["gcloud", "aws"]) chmodSync(join(d, f), 0o755);
  const t0 = Date.now();
  const r = spawnSync("bash", ["tools/cloud-precheck.sh"], { cwd: ROOT, encoding: "utf8", timeout: 60_000,
    env: { ...process.env, PATH: `${d}:${process.env.PATH}`, TMPDIR: d, ...env } });
  let calls = ""; try { calls = readFileSync(join(d, "calls"), "utf8"); } catch { /* 없음 */ }
  return { rc: r.status, out: r.stdout + r.stderr, sec: (Date.now() - t0) / 1000, calls };
}

test("RV-22 gcloud 가 멈추면 총 제한 안에 스스로 끝나고, 걸린 점검(rc=124)과 '총 제한' 줄을 남긴다", () => {
  const r = run("sleep 30", { PRECHECK_TOTAL_SEC: "4", PRECHECK_CALL_SEC: "3" });
  assert.ok(r.sec < 12, `총 제한 4초인데 ${r.sec}초`);
  assert.equal(r.rc, 1);
  assert.match(r.out, /^FAIL gcp-auth .*rc=124/m);
  assert.match(r.out, /^참고 총 제한 4초에 걸림/m);
  assert.match(r.out, /총 제한 4초를 다 씀 → 안 부름: gcloud/);   // 뒤 gcloud 점검은 부르지 않고 시간 초과로 표시
  assert.match(r.out, /^판정 FAIL /m);
  assert.ok((r.calls.match(/^gcloud /gm) ?? []).length <= 2, "총 제한 뒤에도 gcloud 를 계속 부름");
});

test("RV-22 거부 아님: 제때 답하면 총 제한 줄이 없다, 숫자가 아닌 값은 기본 50초", () => {
  const r = run(`case "$*" in *billing*) echo True ;; *services*) echo serviceusage.googleapis.com ;; *) echo '{}' ;; esac`, { PRECHECK_TOTAL_SEC: "abc" });
  assert.ok(r.sec < 30);
  assert.doesNotMatch(r.out, /총 제한/);
  assert.match(r.out, /^OK gcp-auth/m);
});

test("RV-22 up-preflight: 안쪽 제한(50)이 바깥 tmo 60 보다 짧게 넘어간다", () => {
  const s = readFileSync(join(ROOT, "tools/up-preflight.sh"), "utf8");
  const m = /tmo (\d+) env PRECHECK_TOTAL_SEC="\$\{PRECHECK_TOTAL_SEC:-(\d+)\}" bash tools\/cloud-precheck\.sh/.exec(s);
  assert.ok(m, "cloud-precheck 줄 모양이 바뀜");
  assert.ok(Number(m![2]) + 5 <= Number(m![1]), `안쪽 ${m![2]} / 바깥 ${m![1]}`);
});
