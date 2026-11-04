// RV-24: 흉내 자격으로 닫힌 연결은 환경 보기에 mock:true (예전엔 verify_detail.mock 을 버려 진짜 연결과 구별 못 함)
import { test } from "node:test";
import assert from "node:assert/strict";
import { EnvironmentView } from "@svc/contracts";
import { toEnvironmentView } from "../src/routes/environments.js";

const base = { id: "0b9c2f4e-1111-4111-8111-111111111111", provider: "aws", name: "a", connectionStatus: "connected",
  accountId: null, lastVerifiedAt: null, failureReason: null };

test("verify_detail.mock=true → mock:true, 계약 통과", () => {
  const v = toEnvironmentView({ ...base, verifyDetail: { clusters: [], mock: true } });
  assert.equal(v.mock, true);
  assert.ok(EnvironmentView.safeParse(v).success);
});
test("진짜 확인(mock 없음)·verify_detail 없음 → mock 칸 자체 없음", () => {
  assert.equal("mock" in toEnvironmentView({ ...base, verifyDetail: { clusters: ["x"] } }), false);
  assert.equal("mock" in toEnvironmentView({ ...base, verifyDetail: null }), false);
});
