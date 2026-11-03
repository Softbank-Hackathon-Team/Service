// G5-2: 초안 표시(field_meta._draft)에 기준 판 번호가 남는다
import { test } from "node:test";
import assert from "node:assert/strict";
import { draftMarker } from "../src/index.js";

test("정상: 기준 판 번호를 넘기면 baseVersion 칸이 생긴다", () => {
  assert.equal(draftMarker("m", 7).baseVersion, 7);
  assert.equal(draftMarker("m", 7).needs_review, true);
});
test("거부: 번호를 안 넘기면 칸을 지어내지 않는다", () => {
  assert.equal("baseVersion" in draftMarker("m"), false);
});
