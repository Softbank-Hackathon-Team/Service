// FM-CON-09 (실측): 연결 스택을 지우고 같은 이름으로 다시 만들면 EKS 접근 항목이 옛 역할에 묶여 관찰 역할 kubectl 401.
//   env:connect access-check 가 "항목 만든 시각 < 역할 만든 시각" 으로 찾고 --fix 면 같은 모양으로 다시 만든다.
//   가짜 aws(PATH 앞) 로만 돈다. 클라우드 호출 0
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

function run(fix: boolean) {
  const bin = mkdtempSync(join(tmpdir(), "acc-bin-"));
  const log = join(bin, "aws.log");
  writeFileSync(join(bin, "aws"), `#!/bin/sh
echo "$*" >> ${log}
case "$*" in
  "sts get-caller-identity"*) echo 111122223333 ;;
  "iam get-role --role-name svc-observe"*) echo 2026-11-04T01:00:00+00:00 ;;
  "iam get-role --role-name svc-operate"*) echo 2026-11-04T01:00:00+00:00 ;;
  "iam get-role --role-name svc-deploy"*) echo "NoSuchEntity" >&2; exit 254 ;;
  *"describe-access-entry"*"role/svc-observe"*) echo 2026-11-03T20:00:00+00:00 ;;
  *"describe-access-entry"*"role/svc-operate"*) echo 2026-11-04T01:05:00+00:00 ;;
  *) echo ok ;;
esac
`);
  chmodSync(join(bin, "aws"), 0o755);
  const r = spawnSync(process.execPath, ["--import", "tsx", "tools/env-connect.ts", "access-check", "--cluster", "shop", "--region", "ap-northeast-2", ...(fix ? ["--fix"] : [])],
    { cwd: ROOT, encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, DEV_AUTH: "1", DEMO_USER_PASSWORD: "", API_URL: "http://127.0.0.1:9" } });
  return { code: r.status, out: r.stdout + r.stderr, log: existsSync(log) ? readFileSync(log, "utf8") : "" };
}

test("--fix: 옛 항목(svc-observe)만 지우고 보기 정책·클러스터 범위로 다시 만듦, 정상(svc-operate)·없는 역할(svc-deploy)은 안 건드림", () => {
  const r = run(true);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /접근 항목 옛 역할에 묶임  svc-observe/);
  assert.match(r.out, /접근 항목 정상  svc-operate/);
  assert.match(r.out, /다시 만든 접근 항목  1/);
  assert.match(r.log, /eks delete-access-entry --cluster-name shop --principal-arn arn:aws:iam::111122223333:role\/svc-observe/);
  assert.match(r.log, /eks create-access-entry --cluster-name shop --principal-arn arn:aws:iam::111122223333:role\/svc-observe --type STANDARD --region/);
  assert.match(r.log, /eks associate-access-policy .*role\/svc-observe --policy-arn arn:aws:eks::aws:cluster-access-policy\/AmazonEKSViewPolicy --access-scope type=cluster/);
  assert.doesNotMatch(r.log, /delete-access-entry .*svc-operate/);
  assert.doesNotMatch(r.out, /111122223333/, "화면에 계정 번호 안 나옴");
});

test("거부(보기만): --fix 없으면 지우거나 만들지 않고 고칠 명령만 안내", () => {
  const r = run(false);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /접근 항목 옛 역할에 묶임  svc-observe/);
  assert.match(r.out, /다시 만든 접근 항목  0/);
  assert.doesNotMatch(r.log, /delete-access-entry|create-access-entry|associate-access-policy/);
});
