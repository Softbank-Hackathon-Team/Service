// PF-A14 (18회차 운영자 실수): 출발 네임스페이스를 직접 줬는데 그게 플랫폼이 만든 것(managed-by=platform, demo-day served-by)이면 검토 줄
import { test } from "node:test";
import assert from "node:assert/strict";
import { reviewLabel } from "@svc/contracts";
import { discoverAws } from "../src/discover/index.js";
import { normalizeV2 } from "../src/import/pipeline.js";
import { pfExec, PF_NS } from "./pf-a-eks-demo-fixture.js";

const reviews = async (ns: string) => {
  const r = normalizeV2(await discoverAws({ exec: pfExec().exec, env: { IMPORT_NAMESPACE: ns } }, { iam: true })).result;
  return Object.keys(r.fieldMeta).filter((k) => r.fieldMeta[k]!.needs_review);
};

test("PF-A14: IMPORT_NAMESPACE=app-demo(플랫폼 네임스페이스) → check.pick.platform-namespace 검토 + 이름표", async () => {
  assert.ok((await reviews("app-demo")).includes("check.pick.platform-namespace"));
  assert.equal(reviewLabel("check.pick.platform-namespace"), "플랫폼이 만든 네임스페이스를 고름 — 옮길 고객 앱이 맞는지 확인");
});

test("PF-A14 거부 쪽: 고객 네임스페이스(real-app)면 그 검토 줄 없음", async () => {
  assert.equal((await reviews(PF_NS)).includes("check.pick.platform-namespace"), false);
});
