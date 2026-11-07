// GET /migrations/:id/traffic-shift 의 흉내 표시 (metricsSource·lbStub·lbRegistered). DB 없이 도는 부분: 사실 → 표시
//   화면이 가짜 지표·가짜 LB 를 실측처럼 보이지 않게 한다. 모르는 값은 지어내지 않고 null
import { test } from "node:test";
import assert from "node:assert/strict";
import { TrafficShiftProgress } from "@svc/contracts";
import { trafficStubMarks, type StubFacts } from "../src/routes/live-traffic.js";

const none: StubFacts = { shiftMetrics: null, shiftProvider: null, registeredProvider: null, fallbackLbHeld: false };

test("기록이 하나도 없으면 모름(null)이고 등록 안 됨", () => {
  assert.deepEqual(trafficStubMarks(none), { metricsSource: null, lbStub: null, lbRegistered: false });
});

test("흉내 판 shift 결과(가짜 지표·mock 전환기) → 흉내 지표·가짜 LB", () => {
  const m = trafficStubMarks({ ...none, shiftMetrics: "stub", shiftProvider: "mock" });
  assert.deepEqual(m, { metricsSource: "stub", lbStub: true, lbRegistered: false });
});

test("진짜 판 shift 결과(Prometheus·Cloudflare 등록) → 흉내 아님", () => {
  const m = trafficStubMarks({ shiftMetrics: "prometheus", shiftProvider: "cloudflare", registeredProvider: "cloudflare", fallbackLbHeld: false });
  assert.deepEqual(m, { metricsSource: "prometheus", lbStub: false, lbRegistered: true });
});

test("첫 shift 가 도는 중(결과 기록 전): 대신 이름 LB 를 쥐었으면 가짜 LB, 지표 출처는 아직 모름", () => {
  assert.deepEqual(trafficStubMarks({ ...none, fallbackLbHeld: true }), { metricsSource: null, lbStub: true, lbRegistered: false });
});

test("LB 는 워커와 같은 순서: 등록된 자리가 먼저, 등록이 mock 이면 가짜", () => {
  assert.equal(trafficStubMarks({ ...none, registeredProvider: "cloudflare", fallbackLbHeld: true, shiftProvider: "mock" }).lbStub, false);
  assert.equal(trafficStubMarks({ ...none, registeredProvider: "mock" }).lbStub, true);
  assert.equal(trafficStubMarks({ ...none, registeredProvider: "mock" }).lbRegistered, true);
  assert.equal(trafficStubMarks({ ...none, shiftProvider: "cloudflare" }).lbStub, false, "env 로 설정한 진짜 LB");
});

test("모르는 지표 출처 글자는 버린다 (응답 계약이 깨지지 않게)", () => {
  const m = trafficStubMarks({ ...none, shiftMetrics: "otel" });
  assert.equal(m.metricsSource, null);
  const body = { migrationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", available: false, targetWeightPct: null, observedWeightPct: null, reached: null,
    tolerancePct: 10, reobserve: 0, stepStartedAt: null, observedAt: null, ...m };
  assert.equal(TrafficShiftProgress.safeParse(body).success, true);
});

test("계약: 표시 칸이 없는 옛 응답도 받는다", () => {
  const old = { migrationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", available: false, targetWeightPct: null, observedWeightPct: null, reached: null,
    tolerancePct: 10, reobserve: 0, stepStartedAt: null, observedAt: null };
  assert.equal(TrafficShiftProgress.safeParse(old).success, true);
  assert.equal(TrafficShiftProgress.safeParse({ ...old, metricsSource: "otel" }).success, false);
});
