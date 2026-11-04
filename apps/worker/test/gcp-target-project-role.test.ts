// 결정 3번 A안: GCP 실행 역할은 이전 전용 프로젝트의 svc-operate, 관찰은 원래 프로젝트의 svc-observe. 도착 계정 SQL 도 같은 규칙. DB·클라우드 호출 0
import { test } from "node:test";
import assert from "node:assert/strict";
import { roleRefFor } from "../src/platform.js";
import { TARGET_ACCOUNT_SQL } from "../src/jobs/target-account.js";
import { gcpTargetFor } from "@svc/security";

const E = "11111111-1111-4111-8111-111111111111";
test("A안 정상: 전용 프로젝트가 있으면 실행 = svc-operate@전용, plan 단계 = svc-plan@전용, 관찰 = svc-observe@원래", () => {
  const e = { provider: "gcp", account_id: "cust-prj", external_id: null, gcp_target_project: "cust-mig" };
  assert.equal(roleRefFor(e, E, "operate").roleRef, "svc-operate@cust-mig.iam.gserviceaccount.com");
  assert.equal(roleRefFor(e, E, "observe").roleRef, "svc-observe@cust-prj.iam.gserviceaccount.com");
  assert.equal(gcpTargetFor(roleRefFor(e, E, "operate").roleRef, { purpose: "operate", stage: "plan" }), "svc-plan@cust-mig.iam.gserviceaccount.com");
});

test("A안 경계: 전용 프로젝트가 비면 예전처럼 원래 프로젝트, aws 는 전용 프로젝트 칸을 무시", () => {
  assert.equal(roleRefFor({ provider: "gcp", account_id: "cust-prj", external_id: null, gcp_target_project: null }, E, "operate").roleRef, "svc-operate@cust-prj.iam.gserviceaccount.com");
  assert.equal(roleRefFor({ provider: "aws", account_id: "111122223333", external_id: "x", gcp_target_project: "cust-mig" }, E, "operate").roleRef, "arn:aws:iam::111122223333:role/svc-operate");
  assert.match(TARGET_ACCOUNT_SQL, /provider = 'gcp' THEN COALESCE\(gcp_target_project, account_id\) ELSE account_id/);
});
