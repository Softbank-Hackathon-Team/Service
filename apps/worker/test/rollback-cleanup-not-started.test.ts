// 복제를 시작하기 전(syncing 에 들어간 적 없음)에 멈춘 이전의 롤백: DB 걷기 접속 실패로 중계기·배달 정리를 건너뛰지 않는다.
//   2026-11-07 실플랫폼 59b17ae8 (AWS→온프레, 배포에서 멈춤): 걷기가 중계 IP:5432 ECONNREFUSED → ok=false →
//   중계 EC2·보안 그룹·RDS 보안 그룹 규칙이 "replication_leftovers" 로 남아 손으로 지웠다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { cleanupAfterRollback, notStartedCleanup } from "../src/jobs/rollback-cleanup.js";

const refused = { teardown: async () => { throw new Error("connect ECONNREFUSED 16.184.51.212:5432"); },
                  leftovers: async () => { throw new Error("connect ECONNREFUSED 16.184.51.212:5432"); } };

test("동기화 전 롤백: 걷기 접속 실패여도 ok + notStarted (경고 문구는 남긴다)", async () => {
  const c = notStartedCleanup(await cleanupAfterRollback(refused), false);
  assert.equal(c.ok, true);
  assert.equal(c.notStarted, true);
  assert.match(c.warning ?? "", /ECONNREFUSED/);
});

test("거부: 동기화에 들어갔던 이전은 걷기 실패를 그대로 실패로 둔다 (슬롯·구독이 남았을 수 있다)", async () => {
  const c = notStartedCleanup(await cleanupAfterRollback(refused), true);
  assert.equal(c.ok, false);
  assert.equal(c.notStarted, undefined);
});

test("걷기가 성공했으면 동기화 여부와 상관없이 그대로 ok (notStarted 표시 없음)", async () => {
  const fine = { teardown: async () => ({ removed: ["slot:x"] }), leftovers: async () => [] };
  for (const entered of [true, false]) {
    const c = notStartedCleanup(await cleanupAfterRollback(fine), entered);
    assert.equal(c.ok, true);
    assert.equal(c.notStarted, undefined);
  }
});

test("롤백 작업이 걷기 결과에 이 판정을 씌운 뒤에 중계기·배달 정리를 고른다 (구조)", () => {
  const src = readFileSync(new URL("../src/jobs/rollback.ts", import.meta.url), "utf8");
  const judged = src.indexOf("notStartedCleanup(cleanup0");
  const relay = src.indexOf("cleanup.ok ? await teardownRelayStep(j, m)");
  const gitops = src.indexOf("cleanup.ok ? await commitReplicationCleanup(replBundle)");
  assert.ok(judged > 0 && relay > 0 && gitops > 0, "찾을 글자가 바뀌었으면 이 시험도 같이 고친다");
  assert.ok(judged < gitops && judged < relay, "판정 → 배달 정리·중계기 지우기");
  assert.ok(src.includes("detail->>'to' = 'syncing'"), "동기화 진입은 감사 전이 줄로 본다");
});
