// 실측 run·import 앞 단계(tools/real/real-session.sh): TRF-21 cf:check --register 를 shift 전에, ORC-26 DB 마이그레이션 pending 0 확인.
//   본체는 tools/real/test-run-steps.sh (가짜 npm·npx·마이그레이터, 클라우드·DB 호출 0) — 시나리오 5개 (정상 2 + 거부 2 + 끄기 1)
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

test("real-session: LB 등록이 real-flow 앞, 실패면 멈춤·끄기 됨, pending 마이그레이션이 있으면 가져오기 전에 멈춤", () => {
  const r = spawnSync("bash", ["tools/real/test-run-steps.sh"], { cwd: ROOT, encoding: "utf8", timeout: 120_000 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /결과: 통과 5 \/ 실패 0/);
});
