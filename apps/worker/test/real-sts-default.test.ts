// "mock 없이" 기본값: REAL_STS 가 비었거나 없으면 진짜 발급기, 0 일 때만 흉내 (클라우드 호출 없음: 발급기를 만들기만 한다)
import { test } from "node:test";
import assert from "node:assert/strict";
import { realStsEnabled, awsIssuer, gcpIssuer } from "../src/platform.js";

test("기본 켜짐: 값 없음·빈 값·1 = 진짜, 0 만 꺼짐", () => {
  assert.equal(realStsEnabled({}), true);
  assert.equal(realStsEnabled({ REAL_STS: "" }), true);
  assert.equal(realStsEnabled({ REAL_STS: "1" }), true);
  assert.equal(realStsEnabled({ REAL_STS: " 0 " }), false);
});

test("REAL_STS=0 이면 AWS·GCP 둘 다 흉내 발급기, 기본이면 진짜 쪽 래퍼", () => {
  assert.equal(awsIssuer({ REAL_STS: "0" }).mock, true);
  assert.equal(gcpIssuer({ REAL_STS: "0", GCP_PLATFORM_PROJECT: "svc-platform" }).mock, true);
  assert.equal(awsIssuer({}).mock, false);
  const g = gcpIssuer({ GCP_PLATFORM_PROJECT: "svc-platform" });
  assert.equal(g.mock, false);
  assert.equal(g.mockFor?.({ roleRef: "svc-observe@cust-proj-123.iam.gserviceaccount.com" } as never), false);
  assert.equal(g.mockFor?.({ roleRef: "svc-observe@stub.iam.gserviceaccount.com" } as never), true);
});

test("거부: 켜졌는데 GCP_PLATFORM_PROJECT 가 없으면 진짜 고객 SA 발급은 흉내로 넘어가지 않고 PLATFORM_SA_MISSING", async () => {
  const g = gcpIssuer({});
  await assert.rejects(
    g.issue({ roleRef: "svc-observe@cust-proj-123.iam.gserviceaccount.com", req: { tenantId: "t", purpose: "observe", ttlSec: 900 }, now: new Date() } as never),
    (e: Error & { reason?: string }) => e.reason === "PLATFORM_SA_MISSING");
});
