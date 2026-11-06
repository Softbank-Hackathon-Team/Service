import { test } from "node:test";
import assert from "node:assert/strict";
import { stopReasonOf } from "../src/lib/failure";
import { failureDetail, failureDetailOf, stopHelp, stopHelpOf } from "../src/lib/timelineDetail";
import type { TimelineItem } from "../src/lib/types";

const EMPTY = { error: null, missing: [], hint: null };

test("멈춘 도움말: 맨 위의 error·missing·hint 를 그대로 읽는다", () => {
  assert.deepEqual(stopHelpOf({ planId: "p1", error: "  클러스터 없이 만들기는 aws 도착만 ", missing: ["TF_FACT_CLUSTER_NAME"], hint: "TF_FACT_CLUSTER_NAME 을 채운다" }),
    { error: "클러스터 없이 만들기는 aws 도착만", missing: ["TF_FACT_CLUSTER_NAME"], hint: "TF_FACT_CLUSTER_NAME 을 채운다" });
});

test("멈춘 도움말: 단계 칸(shift) 안에 있으면 거기서 읽고, 코드뿐인 error 대신 사람 말 reason 을 쓴다", () => {
  const detail = { lbId: "lb-1", shift: { error: "TRAFFIC_NOT_CONFIGURED", missing: ["PROM_URL", "TRAFFIC_PROVIDER"],
    reason: "진짜 판에 판정 지표·LB 전환기 설정이 없음", hint: "PROM_URL: 판정용 Prometheus 주소 (차트 trafficMetrics.promUrl)" } };
  assert.deepEqual(stopHelpOf(detail), { error: "진짜 판에 판정 지표·LB 전환기 설정이 없음", missing: ["PROM_URL", "TRAFFIC_PROVIDER"],
    hint: "PROM_URL: 판정용 Prometheus 주소 (차트 trafficMetrics.promUrl)" });
  // 사람 말이 없으면 코드라도 보인다 (지어내지 않는다)
  assert.equal(stopHelpOf({ shift: { error: "TRAFFIC_LB_BUSY" } }).error, "TRAFFIC_LB_BUSY");
});

test("멈춘 도움말: envLayer·tempRole·deploy 칸의 이유도 읽는다 (예전엔 맨 위 error 만 봐서 안 보였다)", () => {
  assert.equal(stopHelpOf({ envId: "e1", provider: "gcp", envLayer: { failureCode: "TF_FACTS_MISSING", error: "도착 프로젝트가 없다" } }).error, "도착 프로젝트가 없다");
  assert.equal(stopHelpOf({ tempRole: { code: "TEMP_ROLE_DENIED", error: "최소 권한 파일 없음" } }).error, "최소 권한 파일 없음");
  assert.equal(stopHelpOf({ deploy: { error: "GITOPS_NOT_CONFIGURED", reason: "GITOPS_REPO_URL 없음" }, rehearsal: { skipped: "off" } }).error, "GITOPS_REPO_URL 없음");
  // 앞 칸에 도움말이 없으면 다음 칸을 본다
  assert.equal(stopHelpOf({ evidence: { guardrailRule: "MG-2-07" }, relay: { error: "보안 그룹 규칙을 열 권한 없음" } }).error, "보안 그룹 규칙을 열 권한 없음");
});

test("멈춘 도움말: 빠진 것만, 고치는 법만 있어도 읽는다", () => {
  assert.deepEqual(stopHelpOf({ planId: "p1", real: true, missing: ["TF_FACT_VPC_ID", "TF_FACT_SUBNET_IDS"] }),
    { error: null, missing: ["TF_FACT_VPC_ID", "TF_FACT_SUBNET_IDS"], hint: null });
  assert.deepEqual(stopHelpOf({ shift: { hint: "npm run ops:lb-release -- lb-1 로 회수한 뒤 재개" } }),
    { error: null, missing: [], hint: "npm run ops:lb-release -- lb-1 로 회수한 뒤 재개" });
});

test("멈춘 도움말: 빠진 것·고치는 법은 한 칸에서 짝으로(맨 위 먼저), 이유는 따로 맨 위 먼저", () => {
  assert.deepEqual(stopHelpOf({ missing: ["helm: sandbox.imageRegistry"], deploy: { error: "다른 이유", hint: "다른 법" } }),
    { error: "다른 이유", missing: ["helm: sandbox.imageRegistry"], hint: null });
  assert.deepEqual(stopHelpOf({ planId: "p1", provider: "gcp", error: "중계기를 못 만듦",
    relay: { missing: ["PLATFORM_EGRESS_CIDRS"], hint: "worker-env 에 PLATFORM_EGRESS_CIDRS 를 넣고 다시 계획" } }),
    { error: "중계기를 못 만듦", missing: ["PLATFORM_EGRESS_CIDRS"], hint: "worker-env 에 PLATFORM_EGRESS_CIDRS 를 넣고 다시 계획" });
});

test("멈춘 도움말: 글이 아닌 값은 버리고, 버린 맨 위 값이 단계 칸을 가리지 않는다", () => {
  assert.deepEqual(stopHelpOf({ error: 3, reason: null, missing: "PROM_URL", hint: { text: "x" } }), EMPTY);
  assert.deepEqual(stopHelpOf({ error: "   ", missing: [], shift: { missing: [1, null, " PROM_URL ", "", "PROM_URL", { x: 1 }, "terraform"], hint: ["a"] } }),
    { error: null, missing: ["PROM_URL", "terraform"], hint: null });
  assert.deepEqual(stopHelpOf({ list: [{ error: "배열 안은 단계 칸이 아니다" }] }), EMPTY);
});

test("멈춘 도움말: 아무것도 없으면 빈 도움말", () => {
  assert.deepEqual(stopHelpOf({}), EMPTY);
  assert.deepEqual(stopHelpOf({ lastJudgement: { stepPct: 50, verdict: "bad" }, evidence: { guardrailRule: "MG-2-07" }, attempts: 3 }), EMPTY);
});

const move = (over: Partial<TimelineItem>): TimelineItem => ({
  seq: 1, at: "2026-11-06T00:00:00Z", kind: "transition", actor: "worker", action: "migration.paused", result: "ok",
  from: "shifting", to: "paused", durationMs: null, failureCode: null, requestId: null, measurements: [], detail: {}, ...over,
});

test("멈춘 도움말(타임라인): 그 상태로 들어온 마지막 전이를 읽고, 계획 재확인 글(recheck)은 이유로 쓴다", () => {
  const items = [
    move({ seq: 1, detail: { shift: { missing: ["OLD"] } } }),
    move({ seq: 2, from: "paused", to: "shifting" }),
    move({ seq: 3, failureCode: "TRAFFIC_NOT_CONFIGURED", detail: { shift: { error: "TRAFFIC_NOT_CONFIGURED", missing: ["PROM_URL"], hint: "PROM_URL 을 채운다" } } }),
    move({ seq: 4, kind: "event", from: null, to: null, action: "security.live_check", detail: { error: "다른 줄" } }),
  ];
  assert.deepEqual(stopHelp(items, "paused"), { error: "TRAFFIC_NOT_CONFIGURED", missing: ["PROM_URL"], hint: "PROM_URL 을 채운다" });
  assert.deepEqual(stopHelp(items, "failed"), EMPTY);
  const failed = move({ to: "failed", from: "planning", detail: { recheck: "target unstable", missing: ["TF_FACT_REGION"] } });
  assert.deepEqual(stopHelp([failed]), { error: "target unstable", missing: ["TF_FACT_REGION"], hint: null });
  // 실패 카드의 이유 한 줄도 단계 칸을 읽는다
  const envLayer = move({ to: "failed", from: "provisioning", detail: { envLayer: { failureCode: "TF_FACTS_MISSING", error: "도착 프로젝트가 없다" } } });
  assert.equal(failureDetail([envLayer]), "도착 프로젝트가 없다");
  assert.equal(failureDetailOf(envLayer), "도착 프로젝트가 없다");
});

test("멈춘 이유 문장: 도착 사실 빠짐은 '일부만 생겼을 수 있음'이 아니고, 샌드박스 없음은 재개만으로 풀린다고 약속하지 않는다", () => {
  const facts = stopReasonOf("TF_FACTS_MISSING", "failed")!;
  assert.equal(facts.label, "도착 정보 빠짐");
  assert.equal(facts.kind, "system");
  assert.match(facts.hint, /이번 실행으로 생긴 자원은 없습니다/);
  assert.doesNotMatch(facts.hint, /일부만/);
  assert.equal(stopReasonOf("TF_APPLY_FAILED", "failed")?.label, "자원 생성 실패");   // 넓은 TF_ 줄은 그대로
  const sandbox = stopReasonOf("REHEARSAL_SANDBOX_UNAVAILABLE", "paused")!;
  assert.doesNotMatch(sandbox.hint, /새 샌드박스에서/);
  assert.match(sandbox.hint, /고친 뒤 재개/);
});
