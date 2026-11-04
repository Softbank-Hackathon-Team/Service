// tools/cloud-zero.sh: 결정 3번 A안(GCP 이전 전용 프로젝트도 센다) + FM-SEC-hunt-cloud-22(출력에서 계정 번호 12자리 가림). 가짜 aws·gcloud 로만
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../../../tools/cloud-zero.sh", import.meta.url));
function bin(files: Record<string, string>) {
  const d = mkdtempSync(join(tmpdir(), "czt-"));
  for (const [n, body] of Object.entries(files)) { writeFileSync(join(d, n), body); chmodSync(join(d, n), 0o755); }
  return d;
}
const run = (what: string, b: string, env: Record<string, string> = {}) => {
  const r = spawnSync("bash", [SCRIPT, what], { encoding: "utf8", env: { PATH: `${b}:${process.env.PATH}`, CLOUD_ZERO_WAIT_SEC: "0", ...env } });
  return { code: r.status, out: r.stdout + r.stderr };
};
// 전용 프로젝트에만 GKE 클러스터가 남은 상황
const GCLOUD = `#!/bin/sh
case "$*" in *"--project mig-prj container clusters list"*) echo "shop-gke" ;; esac
exit 0
`;

test("A안 정상: GCP_TARGET_PROJECT 가 있으면 전용 프로젝트도 세서, 거기만 남은 GKE 도 잡는다 (끝 코드 1)", () => {
  const b = bin({ gcloud: GCLOUD });
  const only = run("gcp", b, { GCP_PROJECT: "orig-prj" });
  assert.equal(only.code, 0, only.out);   // 예전처럼 원래 프로젝트만 보면 0 (= 놓침)
  const both = run("gcp", b, { GCP_PROJECT: "orig-prj", GCP_TARGET_PROJECT: "mig-prj" });
  assert.equal(both.code, 1, both.out);
  assert.match(both.out, /== GCP \(project mig-prj\)/);
  assert.match(both.out, /shop-gke/);
});

test("FM-SEC-22: 남은 것 ARN·조회 실패 오류의 계정 번호 12자리는 <계정> 으로, 다른 숫자(11·13자리)는 그대로", () => {
  const AWS = `#!/bin/sh
case "$*" in
  *get-resources*) echo "arn:aws:ec2:ap-northeast-2:123456789012:vpc/vpc-0abc" ;;
  *describe-vpcs*) echo "vpc-0abc" ;;
  *list-roles*) echo "User: arn:aws:sts::123456789012:assumed-role/x/y is not authorized" >&2; exit 254 ;;
esac
exit 0
`;
  const r = run("aws", bin({ aws: AWS }));
  assert.doesNotMatch(r.out, /123456789012/);
  assert.match(r.out, /arn:aws:sts::<계정>:assumed-role/);
  const keep = spawnSync("bash", ["-c", `source <(sed -n '/^redact()/p' "${SCRIPT}"); printf '%s\\n' "a 12345678901 b 1234567890123 c 111122223333:444455556666" | redact`], { encoding: "utf8" }).stdout;
  assert.equal(keep.trim(), "a 12345678901 b 1234567890123 c <계정>:<계정>");
});
