// tools/cloud-zero.sh R7-4: 태그 조회에만 남은 지운 자원(stale ARN)은 직접 조회로 빼고, 진짜 남은 것만 센다.
// 가짜 aws 로만 돈다 (클라우드 호출 없음)
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../../../tools/cloud-zero.sh", import.meta.url));
const ACC = "arn:aws:ec2:ap-northeast-2:111122223333";
const FAKE = `#!/bin/sh
case "$*" in
  *resourcegroupstaggingapi*) [ -n "\${FAKE_TAG_DENY:-}" ] && { echo "AccessDeniedException" >&2; exit 254; }; printf '%s' "\${FAKE_TAGGED:-}" | tr ' ' '\\t'; echo ;;
  *"--instance-ids i-gone"*) echo "An error occurred (InvalidInstanceID.NotFound)" >&2; exit 254 ;;
  *"--instance-ids i-dead"*) echo "terminated" ;;
  *"--instance-ids i-live"*) echo "running" ;;
  *"--nat-gateway-ids"*) echo "deleted" ;;
  *"--network-interface-ids"*) echo "An error occurred (InvalidNetworkInterfaceID.NotFound)" >&2; exit 254 ;;
  *"--subnet-ids"*) echo "An error occurred (InvalidSubnetID.NotFound)" >&2; exit 254 ;;
  *"describe-cluster"*) echo "An error occurred (ResourceNotFoundException)" >&2; exit 254 ;;
  *"--db-instance-identifier shop"*) echo "available" ;;
  *"--db-instance-identifier gone"*) echo "An error occurred (DBInstanceNotFound)" >&2; exit 254 ;;
  *"describe-secret"*) case "$*" in *pending*) echo "2026-10-31T21:00:00+00:00" ;; *) echo "None" ;; esac ;;
  *) echo "" ;;
esac
`;

function run(env: Record<string, string>) {
  const bin = mkdtempSync(join(tmpdir(), "cz-"));
  writeFileSync(join(bin, "aws"), FAKE); chmodSync(join(bin, "aws"), 0o755);
  const r = spawnSync("bash", [SCRIPT, "aws"], { encoding: "utf8", env: { PATH: `${bin}:${process.env.PATH}`, ...env } });
  return { code: r.status, out: r.stdout };
}

test("cloud-zero: stale ARN(NotFound·terminated·deleted, 지운 클러스터의 pod)은 빼고 0 → OK zero", () => {
  const stale = [`${ACC}:instance/i-gone`, `${ACC}:instance/i-dead`, `${ACC}:natgateway/nat-1`, `${ACC}:network-interface/eni-1`,
    `${ACC}:subnet/subnet-1`, "arn:aws:eks:ap-northeast-2:111122223333:podidentityassociation/demo/a-1"];
  const r = run({ FAKE_TAGGED: stale.join(" ") });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /stale 6개 제외/);
  assert.match(r.out, /OK zero/);
});

test("cloud-zero: 살아 있는 인스턴스·모르는 종류는 남은 것으로 센다 → 끝 코드 1", () => {
  // Z38 R8-6: rds:db 는 이제 직접 조회하는 종류라 "모르는 종류" 예로 sns 주제를 쓴다
  const r = run({ FAKE_TAGGED: `${ACC}:instance/i-live ${ACC}:instance/i-gone arn:aws:sns:ap-northeast-2:111122223333:alerts` });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /태그 붙은 자원\(get-resources\): +2/);
  assert.match(r.out, /stale 1개 제외/);
  assert.match(r.out, /i-live/);
  assert.doesNotMatch(r.out.split("남은 것:")[1] ?? "", /i-gone/);
});

test("cloud-zero: 태그 조회 권한 없음은 여전히 끝 코드 2 (R7-1)", () => {
  assert.equal(run({ FAKE_TAG_DENY: "1" }).code, 2);
});

test("Z38 R8-6: rds·비밀(콜론 모양 ARN)도 직접 조회 — 지운 DB·삭제 예약 비밀은 빼고, 살아 있는 DB·보통 비밀은 센다", () => {
  const R = "arn:aws:rds:ap-northeast-2:111122223333", SM = "arn:aws:secretsmanager:ap-northeast-2:111122223333:secret";
  const gone = run({ FAKE_TAGGED: `${R}:db:gone ${SM}:platform/t/app/pending-AbCdEf` });
  assert.equal(gone.code, 0, gone.out);
  assert.match(gone.out, /stale 2개 제외: rds:db 1, secretsmanager:secret 1/);
  const live = run({ FAKE_TAGGED: `${R}:db:shop ${SM}:platform/t/app/live-AbCdEf` });
  assert.equal(live.code, 1, live.out);
  assert.match(live.out, /태그 붙은 자원\(get-resources\): +2/);
});

test("Z38 R8-10: GKE 를 LB Service 보다 먼저 지워 남은 대상 풀·k8s 방화벽도 센다 (gcp)", () => {
  const bin = mkdtempSync(join(tmpdir(), "czg-"));
  writeFileSync(join(bin, "gcloud"), `#!/bin/sh
case "$*" in
  config*) echo proj ;;
  *target-pools*) [ -z "\${FAKE_LEAK:-}" ] || echo a1b2c3 ;;
  *firewall-rules*) case "$*" in *"name~^k8s"*) [ -z "\${FAKE_LEAK:-}" ] || echo k8s-fw-a1b2c3 ;; esac ;;
  *) echo "" ;;
esac
`); chmodSync(join(bin, "gcloud"), 0o755);
  const go = (env: Record<string, string>) => spawnSync("bash", [SCRIPT, "gcp"], { encoding: "utf8", env: { PATH: `${bin}:${process.env.PATH}`, ...env } });
  assert.equal(go({}).status, 0);
  const leak = go({ FAKE_LEAK: "1" });
  assert.equal(leak.status, 1, leak.stdout);
  assert.match(leak.stdout, /k8s-fw-a1b2c3/);
  assert.match(leak.stdout, /대상 풀\(LB 뒤\): +1/);
});
