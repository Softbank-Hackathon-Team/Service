// tools/gcp-source.sh: Cloud Shell 의 가짜 terraform(안내만 찍고 0 으로 끝남)이면 클라우드에 쓰기 전에 멈춘다 (2026-11-07 실측).
//   gcloud·terraform 은 기록용 가짜. 진짜 클라우드 호출 0
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

function run(tfVersionOut: string) {
  const bin = mkdtempSync(join(tmpdir(), "gcp-src-bin-"));
  const calls = join(bin, "calls");
  writeFileSync(join(bin, "gcloud"), `#!/bin/sh\necho "gcloud $*" >> "${calls}"\nexit 9\n`);
  writeFileSync(join(bin, "terraform"), `#!/bin/sh\necho "terraform $*" >> "${calls}"\n[ "$1" = version ] && echo "${tfVersionOut}"\nexit 0\n`);
  for (const t of ["gcloud", "terraform"]) chmodSync(join(bin, t), 0o755);
  const home = mkdtempSync(join(tmpdir(), "gcp-src-home-"));
  const r = spawnSync("bash", ["tools/gcp-source.sh", "up"], { cwd: ROOT, encoding: "utf8",
    env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, GCP_PROJECT: "test-proj-1", GCP_SOURCE_STATE: join(home, "state") } });
  return { ...r, calls: existsSync(calls) ? readFileSync(calls, "utf8") : "" };
}

test("거부: 가짜 terraform(안내 글만) 이면 gcloud 를 부르기 전에 멈추고 설치 방법을 알려 준다", () => {
  const r = run("  Follow the instructions at https://developer.hashicorp.com/terraform/install to install terraform");
  assert.equal(r.status, 1);
  assert.match(r.stdout, /terraform 이 없다/);
  assert.match(r.stdout, /releases\.hashicorp\.com\/terraform\/1\.16\.4/);
  assert.ok(!r.calls.includes("gcloud"), "클라우드에 쓰기 전에 멈춘다");
});

test("진짜 terraform 이면 검사를 지나 up 을 시작한다 (가짜 gcloud 가 실패해 거기서 멈춤)", () => {
  const r = run("Terraform v1.16.4");
  assert.doesNotMatch(r.stdout, /terraform 이 없다/);
  assert.match(r.stdout, /up 시작/);
  assert.match(r.calls, /gcloud services enable/);
});
