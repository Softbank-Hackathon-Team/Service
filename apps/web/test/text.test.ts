import { test } from "node:test";
import assert from "node:assert/strict";
import { middleEllipsis } from "../src/lib/text";

test("짧은 값은 그대로 둔다", () => {
  assert.equal(middleEllipsis("500m", 28), "500m");
  assert.equal(middleEllipsis("a".repeat(28), 28), "a".repeat(28));
});

test("긴 값은 앞뒤를 남기고 가운데를 줄여 max 글자에 맞춘다", () => {
  const hash = "sha256:7f3a9c1e5b2d8846900000000000000000000000000000000000001";
  const short = middleEllipsis(hash, 28);
  assert.equal(short.length, 28);
  assert.ok(short.startsWith("sha256:7f3a9c"));
  assert.ok(short.endsWith("0000001"));
  assert.ok(short.includes("…"));
});
