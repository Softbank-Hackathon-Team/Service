// 흉내 트래픽 표시: 가짜 지표(metricsSource stub)·mock 전환기(가짜 LB)로 낸 숫자·가중치를 실측처럼 보이지 않게 한다.
//   워커 shift 결과 detail (apps/worker jobs/shift.ts) 과 GET /migrations/:id/traffic-shift 의 표시 칸을 읽는다
import { test } from "node:test";
import assert from "node:assert/strict";
import { shiftNote, shiftStub } from "../src/features/migration/model";
import { setLocaleForTest, t } from "../src/lib/i18n";
import { EN } from "../src/i18n/en";
import {
  stopEvidence, summarizeDetail, trafficStubFlag, trafficStubIn, trafficStubLabels, trafficStubNotes, trafficStubOf,
} from "../src/lib/timelineDetail";
import type { TimelineItem } from "../src/lib/types";

// 워커가 MOCK_TRAFFIC=1·PROM_URL 없음·LB 등록 없음에서 남기는 shift 결과 detail (shift.ts 와 같은 키)
const STUB_DETAIL = {
  metricsSource: "stub", trafficProvider: "mock", trafficLbFrom: "env", lbId: "m1",
  trafficStub: "STUB: mock 전환기 (TRAFFIC_PROVIDER 없음) — Cloudflare LB 가중치는 안 바뀜",
  sharesStub: "STUB: 가짜 지표 (PROM_URL 없음) — stepShares 는 가중치로 계산한 값, 실측 아님. 실제 분배는 cf-check --probe", probe: null,
};
// 진짜 판: Prometheus 지표 + 등록된 Cloudflare LB
const REAL_DETAIL = { metricsSource: "prometheus", trafficProvider: "cloudflare", trafficLbFrom: "db", lbId: "cf-lb" };

const move = (over: Partial<TimelineItem>): TimelineItem => ({
  seq: 1, at: "2026-11-07T01:00:00Z", kind: "transition", actor: "worker", action: "migration.cutover", result: "ok",
  from: "shifting", to: "cutover", durationMs: null, failureCode: null, requestId: null, measurements: [], detail: {}, ...over,
});

test("shift 결과 detail: 흉내 판이면 흉내 지표·가짜 LB(등록 안 됨), 진짜 판이면 표시 없음, 트래픽 결과가 아니면 null", () => {
  assert.deepEqual(trafficStubOf(STUB_DETAIL), { metrics: true, lb: true, lbRegistered: false });
  assert.deepEqual(trafficStubOf(REAL_DETAIL), { metrics: false, lb: false, lbRegistered: true });
  assert.equal(trafficStubOf({ precheck: [], stub: true }), null);
  // 설명 글만 있어도 흉내 (옛 워커가 metricsSource 없이 남긴 경우)
  assert.deepEqual(trafficStubOf({ sharesStub: "STUB: 가짜 지표" }), { metrics: true, lb: false, lbRegistered: null });
  assert.deepEqual(trafficStubOf({ trafficStub: "STUB: mock 전환기" }), { metrics: false, lb: true, lbRegistered: null });
});

test("표시 글: 켜진 것만, 등록 여부에 따라 가짜 LB 글이 다르다", () => {
  assert.deepEqual(trafficStubLabels({ metrics: true, lb: true, lbRegistered: false }), ["흉내 지표 · 실제 측정 아님", "가짜 LB · 등록 안 됨"]);
  assert.deepEqual(trafficStubLabels({ metrics: false, lb: true, lbRegistered: true }), ["가짜 LB · mock 전환기"]);
  assert.deepEqual(trafficStubLabels({ metrics: false, lb: true, lbRegistered: null }), ["가짜 LB · mock 전환기"]);
  assert.deepEqual(trafficStubLabels({ metrics: false, lb: false, lbRegistered: true }), []);
  assert.deepEqual(trafficStubLabels(null), []);
  assert.equal(trafficStubFlag({ metrics: true, lb: true, lbRegistered: false }), "흉내 지표 · 가짜 LB");
  assert.equal(trafficStubFlag({ metrics: false, lb: false, lbRegistered: null }), null);
  assert.equal(trafficStubNotes({ metrics: true, lb: false, lbRegistered: null }).length, 1);
  assert.match(trafficStubNotes({ metrics: true, lb: false, lbRegistered: null })[0]!, /실제로 잰 값이 아닙니다/);
  assert.deepEqual(trafficStubNotes(null), []);
});

test("타임라인 한 줄 요약(summarizeDetail): 흉내 지표·가짜 LB 를 주의 칩으로, 진짜 지표는 실측 칩, 압축 관찰 글도 흉내로", () => {
  const stub = summarizeDetail({ ...STUB_DETAIL, stub: "관찰 시간 압축 (TRAFFIC_OBSERVE_SEC)" });
  assert.deepEqual(stub.map((c) => c.label), ["흉내(stub): 관찰 시간 압축 (TRAFFIC_OBSERVE_SEC)", "흉내 지표 · 실제 측정 아님", "가짜 LB · 등록 안 됨"]);
  assert.ok(stub.every((c) => c.tone === "wait"));
  const real = summarizeDetail(REAL_DETAIL);
  assert.deepEqual(real.map((c) => c.label), ["판정 지표 Prometheus (실측)"]);
  assert.equal(real[0]!.tone, undefined);
  assert.deepEqual(summarizeDetail({ windowSec: 900 }).map((c) => c.label), ["롤백 창 900초"]);
});

test("합친 표시: shift 를 여러 번 했으면 한 번이라도 흉내면 흉내, 전환 결과가 없으면 null", () => {
  const items = [move({ seq: 1, to: "paused", detail: REAL_DETAIL }), move({ seq: 2, from: "paused", to: "shifting" }), move({ seq: 3, detail: STUB_DETAIL })];
  assert.deepEqual(trafficStubIn(items), { metrics: true, lb: true, lbRegistered: false });
  assert.deepEqual(trafficStubIn([move({ detail: REAL_DETAIL })]), { metrics: false, lb: false, lbRegistered: null });
  assert.equal(trafficStubIn([move({ detail: { windowSec: 900 } })]), null);
  // 감사 이벤트(전이 아님)는 세지 않는다
  assert.equal(trafficStubIn([move({ kind: "event", to: null, detail: STUB_DETAIL })]), null);
});

test("멈춘 근거: 판정과 같은 전이의 흉내 표시를 같이 읽는다", () => {
  const judgement = { stepPct: 50, samples: 1500, targetErrorRatePct: 10, sourceErrorRatePct: 0, targetP95Ms: 139, sourceP95Ms: 139, verdict: "bad" };
  const paused = (detail: Record<string, unknown>) => [move({ to: "paused", detail: { lastJudgement: judgement, ...detail } })];
  assert.deepEqual(stopEvidence(paused(STUB_DETAIL), "paused")?.traffic, { metrics: true, lb: true, lbRegistered: false });
  assert.deepEqual(trafficStubLabels(stopEvidence(paused(REAL_DETAIL), "paused")?.traffic), []);
  assert.equal(stopEvidence(paused({}), "paused")?.traffic, null);
});

test("트래픽 막대 표시(traffic-shift 응답): 서버가 흉내라고 하면 켜고, 아니거나 옛 서버(칸 없음)면 끈다", () => {
  assert.deepEqual(shiftStub({ metricsSource: "stub", lbStub: true, lbRegistered: false }), { metrics: true, lb: true, lbRegistered: false });
  assert.deepEqual(shiftStub({ metricsSource: null, lbStub: true, lbRegistered: false }), { metrics: false, lb: true, lbRegistered: false });
  assert.equal(shiftStub({ metricsSource: "prometheus", lbStub: false, lbRegistered: true }), null);
  assert.equal(shiftStub({ metricsSource: null, lbStub: null, lbRegistered: false }), null);
  assert.equal(shiftStub({}), null, "옛 서버");
  assert.equal(shiftStub(null), null);
});

test("트래픽 막대 밑 한 줄: 흉내 지표면 실측이라고 쓰지 않는다", () => {
  const shift = { available: true, targetWeightPct: 50, observedWeightPct: 50, reached: true };
  assert.equal(shiftNote("shifting", { ...shift, metricsSource: "stub" }), "목표 50% · 흉내 지표 50%");
  assert.equal(shiftNote("shifting", { ...shift, observedWeightPct: null, reached: null, metricsSource: "stub" }), "목표 50%");
  assert.equal(shiftNote("shifting", { ...shift, metricsSource: "prometheus" }), "목표 50% · 실측 50%");
  assert.equal(shiftNote("shifting", shift), "목표 50% · 실측 50%", "지표 출처를 아직 모르면 예전 그대로");
  assert.doesNotMatch(shiftNote("shifting", { ...shift, metricsSource: "stub" })!, /실측/);
});

test("영어 화면에서도 표시가 번역된다", () => {
  setLocaleForTest("en");
  try {
    assert.deepEqual(trafficStubLabels({ metrics: true, lb: true, lbRegistered: false }), [EN["흉내 지표 · 실제 측정 아님"], EN["가짜 LB · 등록 안 됨"]]);
    assert.equal(t("목표 {0}% · 흉내 지표 {1}%", { 0: 50, 1: 50 }), "Goal 50% · mock metrics 50%");
  } finally {
    setLocaleForTest("ko");
  }
});
