import { test } from "node:test";
import assert from "node:assert/strict";
import { errorText } from "../src/lib/errors";
import { connectionReasonText, stopReasonOf } from "../src/lib/failure";
import { FAILURE_CODES } from "../../../packages/core/src/failure-codes";
import { errorCode } from "../src/lib/errors";
import { HttpError } from "../src/lib/http";
import { failureDetail, failureDetailOf, stopEvidence } from "../src/lib/timelineDetail";
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

test("실패 이유: failed 로 들어온 마지막 전이에 서버가 남긴 글(detail.error, 계획 재확인은 recheck)을 그대로 읽는다", () => {
  const failed = (detail: Record<string, unknown>, seq = 2) =>
    item({ seq, action: "migration.failed", result: "error", from: "importing", to: "failed", failureCode: "IMPORT_SOURCE_UNAVAILABLE", detail });
  const items = [
    item({ seq: 1, kind: "event", from: null, to: null, action: "import.attempt_failed", result: "error", detail: { error: "앞 시도" } }),
    failed({ error: "  aws: AccessDenied <script>  ", attempts: 3 }),
  ];
  assert.equal(failureDetail(items), "aws: AccessDenied <script>");   // 글자 그대로 (화면이 HTML 로 해석하지 않는다)
  assert.equal(failureDetail([failed({ recheck: "target unstable" })]), "target unstable");
  assert.equal(failureDetail([failed({ attempts: 3 })]), null);
  assert.equal(failureDetail([failed({ error: "x" })], "paused"), null);
  assert.equal(failureDetailOf(items[0]!), "앞 시도");
});

test("오류 문장: 서버가 새로 내는 코드도 사람 말로 바꾼다", () => {
  const err = (status: number, code: string) => new HttpError(status, { status, code, message: "", requestId: "r" });
  assert.match(errorText(err(409, "ENV_LOCK_MISSING")), /되돌리거나/);
  assert.match(errorText(err(409, "LLM_BUDGET_EXCEEDED")), /지출 상한/);
  assert.match(errorText(err(409, "AGENT_RUN_IN_PROGRESS")), /이미 점검이/);
  assert.equal(errorText(err(409, "NO_SUCH_CODE")), "요청을 처리하지 못했습니다.");
});

test("멈춘 이유 v2: 새 코드도 사람 말로, 승인 뒤 바뀜은 '일부만 생겼을 수 있음' 줄로 떨어지지 않는다", () => {
  const drift = stopReasonOf("TF_PLAN_DRIFT", "failed")!;
  assert.equal(drift.label, "승인 뒤 계획 바뀜");
  assert.match(drift.hint, /이번 실행으로 생긴 자원은 없습니다/);
  assert.doesNotMatch(drift.hint, /일부만/);
  assert.equal(stopReasonOf("TF_APPLY_FAILED", "failed")?.label, "자원 생성 실패");   // 넓은 TF_ 줄은 그대로
  const values = stopReasonOf("GITOPS_VALUES_DRIFT", "paused")!;
  assert.equal(values.label, "승인 뒤 배포 값 바뀜");
  assert.match(values.hint, /앱을 올리기 전에/);
  assert.equal(stopReasonOf("GITOPS_PUSH_FAILED", "paused")?.label, "배포 저장소 반영 실패");
  assert.equal(stopReasonOf("UNSUPPORTED_V2", "failed")?.label, "도착이 못 만드는 구성");
  assert.equal(stopReasonOf("NEEDS_HUMAN", "failed")?.label, "사람이 정할 것 남음");
  assert.equal(stopReasonOf("RUNTIME_OUTPUT_MISSING", "paused")?.kind, "step");
  assert.equal(stopReasonOf("RUNTIME_UNHEALTHY", "paused")?.label, "앱이 정상으로 안 뜸");
  assert.equal(stopReasonOf("RUNTIME_CHECK_FAILED", "paused")?.kind, "system");
  for (const code of ["UNSUPPORTED_V2", "NEEDS_HUMAN", "RUNTIME_OUTPUT_MISSING", "RUNTIME_UNHEALTHY", "RUNTIME_CHECK_FAILED", "TF_PLAN_DRIFT", "GITOPS_VALUES_DRIFT"])
    assert.notEqual(stopReasonOf(code, "failed")?.label, "알 수 없는 사유", code);
});

test("멈춘 이유: 서버 실패 코드 목록(core failure-codes.ts)의 코드는 모두 사람 말이 있다", () => {
  // #253 이 더하는 코드도 미리 (아직 main 목록에 없다)
  const next = ["REPL_ENDPOINT_INCOMPLETE", "REPL_SECRET_UNRESOLVED", "REPL_TARGET_UNREACHABLE", "SEALING_CERT_MISSING", "ONPREM_EGRESS_UNKNOWN",
    "RELAY_CONFIG_MISSING", "RELAY_SOURCE_DB_UNKNOWN", "RELAY_ROLE_DENIED", "RELAY_PROVISION_FAILED", "RELAY_TEARDOWN_FAILED", "REPL_DELIVERY_FAILED"];
  for (const code of [...FAILURE_CODES, ...next])
    assert.notEqual(stopReasonOf(code, "failed")?.label, "알 수 없는 사유", code);
});

test("멈춘 이유: 트래픽 되돌리기 실패는 판정이 아니라 단계 실패, 한도 걸림은 칸이 빈 컨테이너도 말한다", () => {
  const restore = stopReasonOf("TRAFFIC_RESTORE_FAILED", "failed")!;
  assert.equal(restore.kind, "step");
  assert.match(restore.hint, /아직 도착으로/);
  assert.equal(stopReasonOf("TRAFFIC_PAUSED", "paused")?.kind, "guardrail");     // 넓은 TRAFFIC_ 줄은 그대로
  const quota = stopReasonOf("REHEARSAL_QUOTA_EXCEEDED", "paused")!;
  assert.match(quota.hint, /비어 있는 컨테이너/);
  assert.match(quota.hint, /requests.*limits/);
  assert.equal(stopReasonOf("IMPORT_SPEC_INVALID", "failed")?.label, "명세 모양 오류");
  assert.equal(stopReasonOf("IMPORT_FAILED", "failed")?.label, "구성 읽기 실패");
  assert.equal(stopReasonOf("APP_LINK_UNAVAILABLE", "failed")?.kind, "system");
  assert.equal(stopReasonOf("SECRET_VALUES_MISSING", "paused")?.label, "비밀 값 비어 있음");
});

test("오류 문장 v2: 승인·시작·재시도·명세 고치기·계정 코드", () => {
  const err = (status: number, code: string) => new HttpError(status, { status, code, message: "", requestId: "r" });
  for (const code of ["ACKS_MISSING", "PLAN_HASH_MISMATCH", "TENANT_BUSY", "RETRY_BUDGET_EXHAUSTED", "REPLAN_NOT_ALLOWED", "SPEC_VERSION_CONFLICT",
    "SPEC_PATH_IR_MISMATCH", "SPEC_INCLUDE_UNAVAILABLE", "SPEC_PATCH_INVALID", "USER_DISABLED", "ENV_IN_USE", "BAD_ACCOUNT_ID", "ENV_NAME_TAKEN"])
    assert.notEqual(errorText(err(409, code)), "요청을 처리하지 못했습니다.", code);
  assert.match(errorText(err(409, "TENANT_BUSY")), /다시 시작/);
  assert.match(errorText(err(409, "RETRY_BUDGET_EXHAUSTED")), /고객이 부담/);
  assert.match(errorText(err(401, "USER_DISABLED")), /계정/);
  assert.equal(errorCode(err(409, "TENANT_BUSY")), "TENANT_BUSY");
  assert.equal(errorCode(new TypeError("x")), null);
});

test("연결 실패 이유: 코드는 사람 말로, 권한 이름은 문장에 넣고, 모르는 코드는 코드 그대로, 옛 글은 그대로", () => {
  assert.match(connectionReasonText("ROLE_ASSUME_DENIED")!, /임시 역할/);
  assert.equal(connectionReasonText("PERMISSION_MISSING:rds:DescribeDBInstances"), "관찰 역할에 권한이 빠졌습니다: rds:DescribeDBInstances");
  assert.match(connectionReasonText("PERMISSION_MISSING")!, /권한이 빠졌습니다/);
  for (const code of ["ORG_POLICY_BLOCKED", "ROLE_NOT_FOUND", "LINK_EXPIRED", "K8S_ACCESS_MISSING", "ACCOUNT_MISMATCH"])
    assert.doesNotMatch(connectionReasonText(code)!, /모르는/, code);
  assert.match(connectionReasonText("SOMETHING_NEW")!, /SOMETHING_NEW/);
  assert.equal(connectionReasonText("Agent 생존 신호가 30분째 없습니다"), "Agent 생존 신호가 30분째 없습니다");
  assert.equal(connectionReasonText(null), null);
});
