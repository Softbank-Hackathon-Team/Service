// PF02 FM-CLD-16: cloud-zero 가 앱 apply 가 남긴 IAM 역할(app-*)·연결 정책(svc-operate-policy)·배포 역할(svc-deploy)을 이름으로 센다.
//   태그 조회는 서울만 봐서 전역 IAM 을 못 볼 수 있음. us-east-1 IAM 태그 줄은 참고(합계 제외). 가짜 aws 로만 돈다
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../../../tools/cloud-zero.sh", import.meta.url));
const FAKE = `#!/bin/sh
case "$*" in
  *"--region us-east-1"*resourcegroupstaggingapi*) printf '%s\\n' "\${FAKE_USE1:-}" ;;
  *"starts_with(RoleName,'app-')"*) printf '%s\\n' "\${FAKE_APP_ROLES:-}" ;;
  *"svc-operate-policy"*) printf '%s\\n' "\${FAKE_OP_POLICY:-}" ;;
  *"svc-deploy"*) printf '%s\\n' "\${FAKE_SVC_ROLES:-}" ;;
  *) echo "" ;;
esac
`;
function run(env: Record<string, string>) {
  const bin = mkdtempSync(join(tmpdir(), "cz-pf02-"));
  writeFileSync(join(bin, "aws"), FAKE); chmodSync(join(bin, "aws"), 0o755);
  const r = spawnSync("bash", [SCRIPT, "aws"], { encoding: "utf8", env: { PATH: `${bin}:${process.env.PATH}`, ...env } });
  return { code: r.status, out: r.stdout };
}

test("아무것도 없으면 zero (새 줄들도 0), us-east-1 줄은 참고로 찍힘", () => {
  const r = run({});
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /IAM 역할\(app-\*/);
  assert.match(r.out, /us-east-1 조회.*참고, 합계 제외/);
});

test("거부: 남은 앱 역할 app-*·svc-operate-policy·svc-deploy 는 0 이 아니라 실패", () => {
  for (const env of [{ FAKE_APP_ROLES: "app-shop-a1b2c3-task" }, { FAKE_OP_POLICY: "svc-operate-policy" }, { FAKE_SVC_ROLES: "svc-deploy" }] as Record<string, string>[]) {
    const r = run(env);
    assert.notEqual(r.code, 0, `${JSON.stringify(env)}\n${r.out}`);
  }
});

test("us-east-1 태그 줄만 남아 있으면(지운 직후 태그 조회 지연) 합계에 안 넣음 → zero 그대로", () => {
  const r = run({ FAKE_USE1: "arn:aws:iam::111122223333:role/app-gone" });
  assert.equal(r.code, 0, r.out);
});
