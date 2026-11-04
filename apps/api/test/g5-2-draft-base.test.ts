// G5-2: AI 초안을 받아들일 때 "어느 판을 보고 만든 초안인지"를 본다 (순수 함수, DB 없음)
import { test } from "node:test";
import assert from "node:assert/strict";
import { draftStale } from "../src/routes/spec.js";

test("정상: 기준 판이 지금 받아들인 최신 판이면 받아들일 수 있다 ", () => {
  assert.equal(draftStale(1, 2, 1), null);
  assert.equal(draftStale(null, 2, 1), null);
});

test("거부: 기준 v1 → 사람이 고쳐 v2 → 초안 저장 v3 이면 v3 이 더 새 번호여도 막는다 (사람 값을 조용히 덮지 않게)", () => {
  assert.match(String(draftStale(2, 3, 1)), /made from version 1.*latest accepted version is 2/);
  // 기준 판 번호 없는 옛 초안은 예전 규칙 그대로
  assert.equal(draftStale(2, 3, undefined), null);
  assert.match(String(draftStale(4, 3, undefined)), /older than accepted 4/);
});
