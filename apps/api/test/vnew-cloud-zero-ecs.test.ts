// VNEW (상태: AI 초안): tools/cloud-zero.sh REALECS 줄 — UPREV-B(여러 리전·기다리기) 병합 뒤에도 ECS 서비스·태스크를 클러스터마다 세고,
//   조회가 실패하면 "0" 이 아니라 조회 실패(끝 코드 2). 가짜 aws 로만 돈다 (클라우드 호출 0)
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../../../tools/cloud-zero.sh", import.meta.url));
const C = (r: string, n: string) => `arn:aws:ecs:${r}:111122223333:cluster/${n}`;
// 리전마다 클러스터 목록이 다름. FAKE_ECS_<리전 밑줄> · 서비스·태스크는 클러스터 이름으로
const FAKE = `#!/bin/sh
reg=""; prev=""
for a in "$@"; do [ "$prev" = "--region" ] && reg=$a; prev=$a; done
key=$(printf '%s' "$reg" | tr '-' '_')
case "$*" in
  *"ecs list-clusters"*) [ -n "\${FAKE_ECS_DENY:-}" ] && { echo "AccessDeniedException: ecs:ListClusters" >&2; exit 254; }
     eval "printf '%s' \\"\\\${FAKE_ECS_$key:-}\\"" | tr ' ' '\\t'; echo ;;
  *"ecs list-services"*"cluster/broken"*) echo "AccessDeniedException: ecs:ListServices" >&2; exit 254 ;;
  *"ecs list-services"*"cluster/c-a"*) printf 'arn:svc/a1\\tarn:svc/a2\\n' ;;
  *"ecs list-services"*"cluster/c-b"*) printf 'arn:svc/b1\\n' ;;
  *"ecs list-services"*) echo "" ;;
  *"ecs list-tasks"*"cluster/c-a"*) printf 'arn:task/a1\\n' ;;
  *"ecs list-tasks"*) echo "" ;;
  *) echo "" ;;
esac
`;
function run(env: Record<string, string>) {
  const bin = mkdtempSync(join(tmpdir(), "czv-"));
  writeFileSync(join(bin, "aws"), FAKE); chmodSync(join(bin, "aws"), 0o755);
  const r = spawnSync("bash", [SCRIPT, "aws"], { encoding: "utf8", env: { PATH: `${bin}:${process.env.PATH}`, ...env } });
  return { code: r.status, out: r.stdout };
}

test("정상: 여러 리전(CLOUD_ZERO_REGIONS)에서 클러스터마다 서비스·태스크를 다 센다 (탭 구분 여러 개 포함)", () => {
  const r = run({ CLOUD_ZERO_REGIONS: "ap-northeast-2 us-east-1", FAKE_ECS_ap_northeast_2: `${C("ap-northeast-2", "c-a")} ${C("ap-northeast-2", "c-b")}`, FAKE_ECS_us_east_1: "" });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /ap-northeast-2 ECS 클러스터: +2/);
  assert.match(r.out, /ap-northeast-2 ECS 서비스: +3/);
  assert.match(r.out, /ap-northeast-2 ECS 태스크: +1/);
  assert.match(r.out, /us-east-1 ECS 서비스: +0/);
  const zero = run({ CLOUD_ZERO_REGIONS: "ap-northeast-2,us-east-1" });
  assert.equal(zero.code, 0, zero.out);
  assert.match(zero.out, /OK zero/);
});

test("거부: 클러스터 목록 조회 실패는 서비스·태스크 줄도 '0' 이 아니라 조회 실패 → 끝 코드 2", () => {
  const r = run({ FAKE_ECS_DENY: "1" });
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /ECS 서비스: +조회 실패/);
  assert.match(r.out, /ECS 태스크: +조회 실패/);
  assert.doesNotMatch(r.out, /OK zero/);
});

test("거부: 한 클러스터의 서비스 조회가 실패하면 (마지막 클러스터가 아니어도) 조회 실패 → 끝 코드 2", () => {
  const r = run({ FAKE_ECS_ap_northeast_2: `${C("ap-northeast-2", "broken")} ${C("ap-northeast-2", "c-b")}` });
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /ECS 서비스: +조회 실패 \(AccessDeniedException/);
});
