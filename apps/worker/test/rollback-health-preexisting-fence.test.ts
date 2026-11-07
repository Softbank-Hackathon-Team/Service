// 롤백 뒤 출발 DB 건강: 출발이 이 이전 전부터 쓰기 막혀 있었으면(앞선 이전 완료의 울타리) 롤백을 막지 않는다.
//   2026-11-07 실플랫폼 59b17ae8: f6c08ef2 완료로 출발 RDS 의 shop_app INSERT 가 막힌 채 새 이전을 배포 전에 롤백 → "source not healthy" 로 failed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sourceDbHealth } from "../src/jobs/rollback-health.js";

test("앱 계정이 쓸 수 있으면 건강", () => {
  for (const kind of ["before_cutover", "after_cutover", "noop"] as const)
    assert.deepEqual(sourceDbHealth({ appWritable: true, kind, enteredCutover: true }), { healthy: true, appWrite: "ok" });
});

test("컷오버에 들어간 적 없는 이전의 롤백: 원래부터 막힌 출발은 이 이전 탓이 아니다 → 롤백을 막지 않는다", () => {
  assert.deepEqual(sourceDbHealth({ appWritable: false, kind: "before_cutover", enteredCutover: false }), { healthy: true, appWrite: "blocked_before_migration" });
  assert.deepEqual(sourceDbHealth({ appWritable: false, kind: "noop", enteredCutover: false }), { healthy: true, appWrite: "blocked_before_migration" });
});

test("거부: 컷오버에 들어갔으면(울타리를 쳤을 수 있음) 쓰기 막힘은 건강하지 않음", () => {
  assert.deepEqual(sourceDbHealth({ appWritable: false, kind: "before_cutover", enteredCutover: true }), { healthy: false, appWrite: "blocked" });
});

test("거부: 컷오버 뒤 롤백인데 출발이 못 쓰면 건강하지 않음 (되돌림이 쓰기를 돌려줘야 했다)", () => {
  assert.deepEqual(sourceDbHealth({ appWritable: false, kind: "after_cutover", enteredCutover: false }), { healthy: false, appWrite: "blocked" });
});

test("롤백 작업이 이 판정을 쓰고 결과에 남긴다 (구조)", () => {
  const src = readFileSync(new URL("../src/jobs/rollback.ts", import.meta.url), "utf8");
  assert.ok(src.includes("sourceDbHealth({ appWritable, kind: r.kind"), "판정 연결");
  assert.ok(src.includes("const sourceHealthy = sourceDb.healthy"), "증거 sourceHealthy 가 판정을 따른다");
  assert.ok(src.includes("sourceDb: { appWrite: sourceDb.appWrite }"), "결과 detail 에 남긴다");
});
