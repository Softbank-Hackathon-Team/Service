import { test } from "node:test";
import assert from "node:assert/strict";
import { errorText } from "../src/lib/errors";
import { stopReasonOf } from "../src/lib/failure";
import { HttpError } from "../src/lib/http";
import { stopEvidence } from "../src/lib/timelineDetail";
import type { TimelineItem } from "../src/lib/types";

test("멈춘 이유: 트래픽 지표로 멈추면 가드레일, 단계 실패는 단계, 워커 문제는 시스템", () => {
  assert.equal(stopReasonOf("TRAFFIC_ERROR_RATE", "paused")?.kind, "guardrail");
  assert.match(stopReasonOf("TRAFFIC_ERROR_RATE", "paused")!.title, /오류가\n기준을 넘었습니다/);
  assert.equal(stopReasonOf("TRAFFIC_LATENCY", "rolling_back")?.label, "응답 시간 기준 넘음");
  assert.equal(stopReasonOf("TRAFFIC_SWITCH_FAILED", "paused")?.kind, "step");
  assert.equal(stopReasonOf("TRAFFIC_PAUSED", "paused")?.label, "트래픽 이동 멈춤");
  assert.equal(stopReasonOf("TF_APPLY_FAILED", "failed")?.label, "자원 생성 실패");
  assert.equal(stopReasonOf("TF_BIN_MISSING", "failed")?.kind, "system");
  assert.equal(stopReasonOf("GITOPS_NOT_CONFIGURED", "paused")?.kind, "system");
  assert.equal(stopReasonOf("GITOPS_PUSH_FAILED", "paused")?.label, "배포 저장소 반영 실패");
  assert.equal(stopReasonOf("ARGO_TIMEOUT", "paused")?.label, "배포 확인 실패");
  assert.equal(stopReasonOf("CUTOVER_UNFENCE_FAILED", "failed")?.label, "출발 쓰기 막힘 남음");
  assert.equal(stopReasonOf("CUTOVER_HALFWAY", "failed")?.label, "DB 전환 실패");
  assert.equal(stopReasonOf("JOB_FAILED_SYNC", "failed")?.kind, "system");
  assert.equal(stopReasonOf("IMPORT_SOURCE_UNAVAILABLE", "failed")?.label, "출발 환경 못 읽음");
});

test("멈춘 이유: 코드 없는 일시 정지는 가드레일 규칙, 사람이 되돌리거나 취소한 것은 이유 없음, 모르는 코드는 지어내지 않는다", () => {
  assert.equal(stopReasonOf(null, "paused")?.label, "가드레일 규칙");
  assert.equal(stopReasonOf(null, "rolling_back"), null);
  assert.equal(stopReasonOf(undefined, "cancelled"), null);
  const unknown = stopReasonOf("SOMETHING_NEW", "failed");
  assert.equal(unknown?.label, "알 수 없는 사유");
  assert.equal(unknown?.kind, "system");
  assert.ok(!("match" in unknown!));
});

const item = (over: Partial<TimelineItem>): TimelineItem => ({
  seq: 1, at: "2026-11-02T00:00:00Z", kind: "transition", actor: "worker", action: "migration.paused", result: "ok",
  from: "shifting", to: "paused", durationMs: null, failureCode: null, requestId: null, measurements: [], detail: {}, ...over,
});

test("멈춘 근거: 그 상태로 들어온 마지막 전이의 판정과 규칙 번호를 읽고, 모양이 틀리면 버린다", () => {
  const judgement = { stepPct: 50, samples: 10, targetErrorRatePct: 3, sourceErrorRatePct: 0.1, targetP95Ms: 900, sourceP95Ms: 100, verdict: "bad", at: "t" };
  const items = [
    item({ seq: 1, detail: { lastJudgement: { ...judgement, stepPct: 10 } } }),
    item({ seq: 2, from: "paused", to: "shifting" }),
    item({ seq: 3, detail: { lastJudgement: judgement, evidence: { guardrailRule: "MG-2-07" } } }),
    item({ seq: 4, kind: "event", to: null, action: "security.live_check" }),
  ];
  const got = stopEvidence(items, "paused");
  assert.equal(got?.judgement?.stepPct, 50);
  assert.equal(got?.rule, "MG-2-07");
  assert.equal(stopEvidence([item({ detail: { lastJudgement: { stepPct: "50" } } })], "paused")?.judgement, null);
  assert.equal(stopEvidence(items, "rolling_back"), null);
});

test("오류 문장: 서버가 새로 내는 코드도 사람 말로 바꾼다", () => {
  const err = (status: number, code: string) => new HttpError(status, { status, code, message: "", requestId: "r" });
  assert.match(errorText(err(409, "ENV_LOCK_MISSING")), /되돌리거나/);
  assert.match(errorText(err(409, "LLM_BUDGET_EXCEEDED")), /지출 상한/);
  assert.match(errorText(err(409, "AGENT_RUN_IN_PROGRESS")), /이미 점검이/);
  assert.equal(errorText(err(409, "NO_SUCH_CODE")), "요청을 처리하지 못했습니다.");
});
