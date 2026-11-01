// Z75-03: core 의 "받아들인 최신 명세" 조회가 쓰는 초안 표시 이름 = 에이전트가 초안에 붙이는 이름
// 둘이 어긋나면 AI 초안이 계획·적용·배포 입력으로 새어 들어간다 (Z19 H1)
import { test } from "node:test";
import assert from "node:assert/strict";
import { SPEC_DRAFT_KEY } from "@svc/core";
import { DRAFT_MARKER_KEY } from "@svc/agent";

test("Z75-03: core SPEC_DRAFT_KEY 와 agent DRAFT_MARKER_KEY 가 같다", () => {
  assert.equal(SPEC_DRAFT_KEY, DRAFT_MARKER_KEY);
});
