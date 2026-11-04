// RV-27: 워커가 빌린 GCP 토큰을 precheck 쪽 env 로 넘기는가 (빌린 자격 없음·프로젝트 모름이면 안 넘김). DB·클라우드 호출 0
import { test } from "node:test";
import assert from "node:assert/strict";
import { precheckSideEnv } from "../src/jobs/precheck.js";

const BASE = { PATH: "/bin", GOOGLE_APPLICATION_CREDENTIALS: "/own/adc.json", CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT: "x@y" } as NodeJS.ProcessEnv;

test("RV-27 정상: 도착 GCP 토큰 + 전용 프로젝트 → 도착 쪽 env 에 그 토큰·프로젝트, 워커 자기 자격 이름은 지움", () => {
  const e = precheckSideEnv({ gcpToken: { target: "tok-b" } }, BASE, { source: null, target: "cust-mig" })!;
  assert.equal(e.target!.CLOUDSDK_AUTH_ACCESS_TOKEN, "tok-b");
  assert.equal(e.target!.CLOUDSDK_CORE_PROJECT, "cust-mig");
  assert.equal(e.target!.GOOGLE_APPLICATION_CREDENTIALS, undefined);
  assert.equal(e.target!.CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT, undefined);
  assert.equal(e.source, undefined);
});

test("RV-27 거부: 토큰 없음(가짜 발급기)·프로젝트 모름이면 sideEnv 없음 → 예전 길(이유 글이 워커 로그인이라고 밝힘)", () => {
  assert.equal(precheckSideEnv({}, BASE, { target: "cust-mig" }), undefined);
  assert.equal(precheckSideEnv({ gcpToken: { target: "tok-b" } }, BASE, { target: null }), undefined);
  assert.equal(precheckSideEnv(undefined, BASE), undefined);
});
