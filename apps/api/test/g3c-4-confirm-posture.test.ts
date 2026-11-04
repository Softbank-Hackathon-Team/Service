// G3c-4: 합치기가 붙인 posture·security 검토 표시를 confirm 으로 지울 수 있다 (라우트 조립 순서 그대로, DB 없음)
import { test } from "node:test";
import assert from "node:assert/strict";
import { SpecPatchInput } from "@svc/contracts";
import { applySpecV2Patch, type SpecMeta } from "@svc/core";

const flagged: SpecMeta = {
  posture: { source: "human", confidence: 1, needs_review: true, rationale: "출발 값이 바뀜, 앞서 사람이 정한 값 있음" },
  security: { source: "human", confidence: 1, needs_review: true },
  "components.api.image": { source: "k8s", confidence: 1, needs_review: false },
};

test("정상: confirm posture·security → 본문 검사 통과, 두 표시 needs_review false", () => {
  const body = SpecPatchInput.safeParse({ baseVersion: 3, confirm: ["posture", "security"] });
  assert.ok(body.success, JSON.stringify(body.error?.issues));
  const next = applySpecV2Patch({ spec: { components: [] }, fieldMeta: flagged }, { confirm: body.data!.confirm });
  assert.deepEqual(next.confirmed, ["posture", "security"]);
  assert.equal(Object.values(next.fieldMeta).some((m) => (m as { needs_review?: boolean }).needs_review), false);
  assert.equal((next.fieldMeta.posture as { source: string }).source, "human", "출처·신뢰도는 그대로");
});

test("거부: 모르는 머리 이름(app 밖 임의 키)·공백 있는 경로는 400 (본문 검사)", () => {
  assert.equal(SpecPatchInput.safeParse({ baseVersion: 3, confirm: ["postures"] }).success, false);
  assert.equal(SpecPatchInput.safeParse({ baseVersion: 3, confirm: ["posture x"] }).success, false);
  assert.equal(SpecPatchInput.safeParse({ baseVersion: 3, confirm: ["unmapped"] }).success, false);
});
