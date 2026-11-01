// L1 (Z10 리뷰): 감사 지문의 canonical()이 Date를 {}로 만들지 않는지
import { test } from "node:test";
import assert from "node:assert/strict";
import { canonical } from "../src/hash.js";

test("canonical: Date는 JSON.stringify처럼 ISO 문자열로 (DB에서 다시 읽어 계산해도 같은 지문)", () => {
  const at = new Date("2026-10-31T17:00:00.000Z");
  const written = canonical({ detail: { at, n: 1 } });
  const reread = canonical(JSON.parse(JSON.stringify({ detail: { at, n: 1 } })));
  assert.equal(written, reread);
  assert.equal(canonical(at), JSON.stringify("2026-10-31T17:00:00.000Z"));
});

test("canonical: 키 순서에 안 흔들리고 undefined 키는 뺀다 (기존 동작 유지)", () => {
  assert.equal(canonical({ b: 1, a: [2, { d: undefined, c: 3 }] }), canonical({ a: [2, { c: 3 }], b: 1 }));
  assert.equal(canonical({ b: 1, a: 2 }), '{"a":2,"b":1}');
});
