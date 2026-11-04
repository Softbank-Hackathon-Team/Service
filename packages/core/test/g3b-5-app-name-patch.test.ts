// G3b-5: 사람이 명세 PATCH 로 app.name 을 고친다 (경로 계약 + 적용). 모르는 app.* 경로는 거부
import { test } from "node:test";
import assert from "node:assert/strict";
import { SpecPatchInput } from "@svc/contracts";
import { applySpecV2Patch } from "../src/specs.js";

test("G3b-5: app.name 바꾸기 → 값·출처 human", () => {
  assert.equal(SpecPatchInput.safeParse({ baseVersion: 1, changes: [{ path: "app.name", value: "shop" }] }).success, true);
  const next = applySpecV2Patch({ spec: { schemaVersion: "2", app: { name: "api" }, components: [] },
    fieldMeta: { "app.name": { source: "heuristic:first-service", confidence: 0.6, needs_review: true } } }, { changes: [{ path: "app.name", value: "shop" }] });
  assert.equal((next.spec.app as { name: string }).name, "shop");
  assert.deepEqual(next.fieldMeta["app.name"], { source: "human", confidence: 1, needs_review: false });
  assert.equal(SpecPatchInput.safeParse({ baseVersion: 1, confirm: ["app.name"] }).success, true);
});

test("G3b-5: app.name 밖의 app 경로는 계약에서 거부", () => {
  assert.equal(SpecPatchInput.safeParse({ baseVersion: 1, changes: [{ path: "app.owner", value: "x" }] }).success, false);
  assert.equal(SpecPatchInput.safeParse({ baseVersion: 1, changes: [{ path: "app", value: {} }] }).success, false);
});
