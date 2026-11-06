// 롤백: 출발 헬스(앱 계정 쓰기 가능)는 출발 계정 중계기를 지우기 전에 본다.
//   AWS→온프레 이전은 워커가 출발 DB 에 중계기(공인 IP:15432)로만 닿는다. 중계기를 먼저 지우면 헬스 접속이 timeout expired 로
//   롤백이 실패하고, 재시도 때는 중계기가 없어 복제 걷기·헬스가 모두 실패해 ROLLBACK_FAILED 로 끝난다 (2026-11-06 실제 플랫폼).
// 순서 계약만 본다(구조 시험). 실제 동작은 중계기를 흉내 내는 통합 시험이 없어 실제 플랫폼 롤백으로 확인한다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../src/jobs/rollback.ts", import.meta.url), "utf8");

test("롤백은 출발 헬스를 본 뒤에 중계기를 지운다", () => {
  const health = src.indexOf("appCanWrite(c, repl.cfg.source");
  const relay = src.indexOf("await teardownRelayStep(j, m)");
  const cleanup = src.indexOf("await cleanupAfterRollback(repl)");
  assert.ok(health > 0 && relay > 0 && cleanup > 0, "찾을 글자가 바뀌었으면 이 시험도 같이 고친다");
  assert.ok(cleanup < health, "복제 걷기 → 헬스");
  assert.ok(health < relay, "헬스 → 중계기 지우기 (거꾸로면 중계기 경로가 사라진 뒤 출발에 붙는다)");
  assert.equal(src.split("appCanWrite(c, repl.cfg.source").length - 1, 1, "헬스는 한 번만");
});
