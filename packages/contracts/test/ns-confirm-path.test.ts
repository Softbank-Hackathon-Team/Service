// NS-1: 네임스페이스 객체를 못 읽으면 가져오기가 namespaces.<ns> 에 검토 표시를 붙인다 (adapters import/pipeline.ts namespacesOf).
//   그 키를 PATCH confirm 으로 확인할 수 있어야 spec_review 에서 나간다 (T04 가 검토 칸을 센다)
import { test } from "node:test";
import assert from "node:assert/strict";
import { SpecConfirmPath, SpecPatchInput, reviewLabel } from "../src/index.js";

test("NS-1: confirm 경로가 namespaces.<ns> 를 받는다 (PATCH 본문 검사 통과)", () => {
  assert.equal(SpecConfirmPath.safeParse("namespaces.real-app").success, true);
  const body = SpecPatchInput.safeParse({ baseVersion: 2, confirm: ["namespaces.real-app", "unread.Namespace"] });
  assert.ok(body.success, JSON.stringify(body.error?.issues));
});

test("NS-1 거부: 머리 이름이 다르거나 빈칸이 있는 경로는 그대로 막힌다", () => {
  for (const p of ["namespace.real-app", "namespacesx.real-app", "namespaces real-app", "namespaces.real app", "spec.namespaces.real-app", "unmapped"])
    assert.equal(SpecConfirmPath.safeParse(p).success, false, p);
});

test("NS-1: namespaces.<ns> 이름표는 키 원문이 아니라 사람이 읽는 말", () => {
  assert.equal(reviewLabel("namespaces.real-app"), "네임스페이스 real-app");
  assert.equal(reviewLabel("namespaces.real-app#2"), "네임스페이스 real-app (2번째)");
});
