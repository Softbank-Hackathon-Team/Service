// 실측 connect 단계(tools/real/real-session.sh): 연결 스택 이어 쓰기·충돌 정리(CONNREUSE) + CON-01 GCP 도착 연결.
//   본체는 tools/real/test-connect-reuse.sh (가짜 npm·aws·gcloud, 클라우드 호출 0) — 셸 쪽 시나리오 9개 (정상 4 + 거부 4 + 끄기 1; FM-INT-11 GCP verify disconnected 거부 포함)
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

test("real-session connect: 충돌 정리·이미 있음·이미 connected·GCP 도착 연결, 거부 4개 (셸 시나리오 전부 통과)", () => {
  const r = spawnSync("bash", ["tools/real/test-connect-reuse.sh"], { cwd: ROOT, encoding: "utf8", timeout: 120_000 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /결과: 통과 9 \/ 실패 0/);
});

test("실측 가림(tools/real/mask.sh): 가짜 계정·키·토큰 0개 남고 해시·시각은 그대로 (mask-test.sh 전부 통과)", () => {
  const r = spawnSync("sh", ["tools/real/mask-test.sh"], { cwd: ROOT, encoding: "utf8", timeout: 60_000 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /실패 0$/m);
});
