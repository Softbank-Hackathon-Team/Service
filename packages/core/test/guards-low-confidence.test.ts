import { test } from "node:test";
import assert from "node:assert/strict";
import { checkGuard, specMinConfidence, type GuardFacts } from "../src/guards.js";

const base: GuardFacts = {
  status: "spec_review", pausedFrom: null, failedAtStatus: null, rollbackWindowOver: false,
  sourceEnvId: "s", targetEnvId: "t", sourceConn: "connected", targetConn: "connected",
  specVersion: 1, specNeedsReview: 0,
  plan: null, locks: { total: 0, live: 0, reservedLive: 0 },
};
const t04 = (o: Partial<GuardFacts>) => checkGuard("spec_review", "prechecking", { facts: { ...base, ...o }, ev: {} });

test("T04 신뢰도: 칸 수가 없거나 0이면 지금과 같이 통과", () => {
  assert.equal(t04({}), null);
  assert.equal(t04({ specLowConfidenceOpen: 0 }), null);
});

test("T04 신뢰도: 문턱값 미만 칸이 열려 있으면 막는다", () => {
  assert.match(t04({ specLowConfidenceOpen: 2 })!, /2 field\(s\) below min confidence/);
});

test("문턱값 읽기: 비어 있음·글자·범위 밖은 꺼짐(0), 0~1 숫자만 켜짐", () => {
  assert.equal(specMinConfidence({}), 0);
  assert.equal(specMinConfidence({ SPEC_MIN_CONFIDENCE: " " }), 0);
  assert.equal(specMinConfidence({ SPEC_MIN_CONFIDENCE: "abc" }), 0);
  assert.equal(specMinConfidence({ SPEC_MIN_CONFIDENCE: "-0.5" }), 0);
  assert.equal(specMinConfidence({ SPEC_MIN_CONFIDENCE: "7" }), 0);
  assert.equal(specMinConfidence({ SPEC_MIN_CONFIDENCE: "0.7" }), 0.7);
});

// VPA3: 문턱값 경계 (정확히 1 은 켜짐, 1 초과는 꺼짐, 공백 둘린 숫자도 숫자)
test("문턱값 읽기 경계: 1 은 켜짐, 1.0001 은 꺼짐, ' 0.5 ' 는 0.5", () => {
  assert.equal(specMinConfidence({ SPEC_MIN_CONFIDENCE: "1" }), 1);
  assert.equal(specMinConfidence({ SPEC_MIN_CONFIDENCE: "1.0001" }), 0);
  assert.equal(specMinConfidence({ SPEC_MIN_CONFIDENCE: " 0.5 " }), 0.5);
});

test("applySpecPatch(VPA3): service.env 를 다시 쓰면 service.env.<이름> 표시도 사람 처리, 다른 칸은 그대로", async () => {
  const { applySpecPatch } = await import("../src/specs.js");
  const out = applySpecPatch({ spec: {}, fieldMeta: {
    "service.env.TOKEN": { source: "source.env", confidence: 0.6, needs_review: true },
    "service.envx": { source: "x", confidence: 0.6, needs_review: true } } },
  { changes: [{ path: "service.env", value: [] }] });
  assert.deepEqual(out.fieldMeta["service.env.TOKEN"], { source: "human", confidence: 1, needs_review: false });
  assert.equal((out.fieldMeta["service.envx"] as { needs_review: boolean }).needs_review, true);
});
