import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkEntries, elapsedSec, formatSec, failureClassOf, fidelityGroups, isolationLine, isRehearsalCode, isStaleRun, phaseEntries,
  rehearsalHeroLine, rehearsalPollMs, deadlineLabel, timeoutStageText, phaseLabel, rehearsalRelevant, rehearsalState, rehearsalStepDetail, rehearsalSummary, remainingSec, SKIP_TEXT,
} from "../src/features/migration/rehearsal";
import { migrationSteps } from "../src/features/migration/model";
import { stopReasonOf } from "../src/lib/failure";
import { stopEvidence } from "../src/lib/timelineDetail";
import { REHEARSAL_FAILURE_CLASS, REHEARSAL_FAILURE_CODES, type RehearsalRun } from "../src/lib/rehearsal-types";

const run = (over: Partial<RehearsalRun> = {}): RehearsalRun => ({
  id: "r1", status: "running", failureCode: null, phase: "applying", skip: null, reusedFrom: null, sandboxName: "sbx-r1",
  createdAt: "2026-11-04T10:00:00Z", startedAt: "2026-11-04T10:00:05Z", finishedAt: null, deadlineAt: "2026-11-04T10:20:00Z",
  fidelity: null, result: null, ...over,
});

test("리허설 상태: 줄 상태와 재사용·지난 시도를 나눈다", () => {
  assert.equal(rehearsalState(null), "none");
  assert.equal(rehearsalState(run({ status: "queued", phase: null })), "waiting");
  assert.equal(rehearsalState(run()), "running");
  assert.equal(rehearsalState(run({ status: "passed" })), "passed");
  assert.equal(rehearsalState(run({ status: "passed", reusedFrom: "r0" })), "reused");
  assert.equal(rehearsalState(run({ status: "skipped", skip: "disabled" })), "skipped");
  assert.equal(rehearsalState(run({ status: "failed" })), "failed");
  assert.equal(rehearsalState(run({ status: "error" })), "error");
  assert.equal(rehearsalState(run({ status: "failed" }), true), "stale");
});

test("진행 단계 '앱 배포' 칸 한 마디", () => {
  assert.equal(rehearsalStepDetail(null), undefined);
  assert.equal(rehearsalStepDetail(run()), "리허설 중");
  assert.equal(rehearsalStepDetail(run({ status: "passed" })), "리허설 통과");
  assert.equal(rehearsalStepDetail(run({ status: "passed", reusedFrom: "r0" })), "리허설 재사용");
  assert.equal(rehearsalStepDetail(run({ status: "skipped", skip: "non_k8s" })), "리허설 건너뜀");
  assert.equal(rehearsalStepDetail(run({ status: "error", failureCode: "REHEARSAL_TIMEOUT" })), "리허설에서 멈춤");
  const steps = migrationSteps({ status: "deploying" }, null, { deploying: "리허설 중" });
  assert.equal(steps.find((step) => step.label === "앱 배포")?.detail, "리허설 중");
  assert.equal(migrationSteps({ status: "deploying" }).find((step) => step.label === "앱 배포")?.detail, undefined);
});

test("지난 시도: 서버 run.stale 만 본다. 배포 중이면 '리허설 준비', 아니면 칸에 붙이지 않는다", () => {
  assert.equal(isStaleRun(run({ stale: true })), true);
  assert.equal(isStaleRun(run({ stale: false })), false);
  assert.equal(isStaleRun(run()), false, "옛 서버 응답(칸 없음)은 지금 시도로 본다");
  assert.equal(isStaleRun(null), false);
  const past = run({ status: "failed", failureCode: "REHEARSAL_CRASHLOOP", stale: true });
  assert.equal(rehearsalState(past, true), "stale");
  assert.equal(rehearsalStepDetail(past, true, "deploying"), "리허설 준비");
  assert.equal(rehearsalStepDetail(past, true, "paused"), undefined);
  assert.equal(rehearsalSummary(past, true), "지난 시도 기록");
  assert.equal(rehearsalSummary(past), "실패", "지난 줄의 그때 결과");
});

test("읽을지와 간격: 배포 단계부터, deploying 만 빠르게", () => {
  assert.equal(rehearsalRelevant({ status: "provisioning" }), false);
  assert.equal(rehearsalRelevant({ status: "deploying" }), true);
  assert.equal(rehearsalRelevant({ status: "completed" }), true);
  assert.equal(rehearsalRelevant({ status: "paused", pausedFrom: "deploying" }), true);
  assert.equal(rehearsalRelevant({ status: "paused", pausedFrom: "provisioning" }), false);
  assert.equal(rehearsalRelevant({ status: "failed", failedAtStatus: "provisioning" }), false);
  assert.equal(rehearsalPollMs("deploying"), 2_000);
  assert.equal(rehearsalPollMs("syncing"), null);
});

test("단계 목록·요약·큰 카드 한 줄", () => {
  // 이미지 복사는 줄이 생기기 전 일이라 단계에 없다: 만들기 → 올리기 → 검사 → 지우기
  assert.deepEqual(phaseEntries(run()).map((e) => e.status), ["done", "active", "pending", "pending"]);
  assert.deepEqual(phaseEntries(run()).map((e) => e.label), ["샌드박스 만들기", "같은 매니페스트 올리기", "검사", "샌드박스 지우기"]);
  assert.equal(phaseLabel("mirroring"), "", "옛 서버의 모르는 단계는 비운다");
  assert.ok(phaseEntries(run({ status: "queued", phase: null })).every((e) => e.status === "pending"));
  assert.equal(rehearsalSummary(run({ phase: "checking" })), "도는 중 · 검사");
  assert.match(rehearsalHeroLine(run()) ?? "", /가상 클러스터에서 먼저 리허설/);
  assert.equal(rehearsalHeroLine(run({ status: "skipped", skip: "disabled" })), SKIP_TEXT.disabled);
  assert.equal(rehearsalHeroLine(run({ status: "failed" })), null, "멈춘 결론은 멈춤 화면이 말한다");
});

test("검사 줄: 판정을 가른 실패는 이유와 함께 따로, 나머지는 판정에 드는 것 먼저", () => {
  const check = (id: "rollout" | "restarts" | "edge_http" | "quota", ok: boolean, required: boolean, subject = "Deployment/web") =>
    ({ id, subject, required, ok, ms: 10, detail: ok ? "" : "CrashLoopBackOff 5회" });
  const { failed, items, more } = checkEntries({ checks: [check("edge_http", false, false), check("rollout", true, true), check("restarts", false, true), check("quota", true, true, "도착 네임스페이스 한도")] }, 2);
  assert.deepEqual(failed, [{ label: "재시작 없음 · Deployment/web", detail: "CrashLoopBackOff 5회" }]);
  assert.deepEqual(items.map((i) => [i.label, i.status]), [["롤아웃 · Deployment/web", "done"], ["도착 네임스페이스 한도", "done"]], "대상이 이름과 같으면 한 번만");
  assert.equal(more, 1, "참고 실패 줄은 뒤로 밀린다");
  assert.equal(formatSec(0), "1초 미만");
  assert.equal(formatSec(95), "1분 35초");
});

test("충실도: 세 묶음, 빈 묶음 뺌, 표는 고치지 않음", () => {
  const item = (id: "images" | "namespace" | "traffic", status: "identical" | "substituted" | "not_checked") => ({ id, status, real: "r", sandbox: "s", reason: "why", refs: [] });
  const groups = fidelityGroups({ version: 1, target: "aws-eks", bundleSha256: "abc", items: [item("images", "substituted"), item("namespace", "identical"), item("traffic", "substituted")] });
  assert.deepEqual(groups.map((g) => [g.title, g.items.length]), [["같게 확인한 것", 1], ["바꿔서 확인한 것", 2]]);
  assert.deepEqual(fidelityGroups(null), []);
});

test("격리 한 줄과 시간", () => {
  assert.equal(isolationLine({ runtimeClass: null, podSecurity: "baseline", mock: false }), "같은 커널, 전용 노드 · 파드 보안 baseline");
  assert.equal(isolationLine({ runtimeClass: "gvisor", podSecurity: "restricted", mock: true }), "커널 분리(gvisor) · 파드 보안 restricted · 흉내 샌드박스");
  const now = Date.parse("2026-11-04T10:01:05Z");
  assert.equal(elapsedSec(run(), now), 60);
  assert.equal(remainingSec(run(), now), 1135);
  assert.equal(remainingSec(run({ finishedAt: "2026-11-04T10:02:00Z" }), now), null);
});

test("리허설 실패 코드 14개 모두 사람 말이 있고, 플랫폼 문제는 system 으로 나뉜다", () => {
  assert.equal(REHEARSAL_FAILURE_CODES.length, 14);
  for (const code of REHEARSAL_FAILURE_CODES) {
    assert.equal(isRehearsalCode(code), true);
    const reason = stopReasonOf(code, "paused");
    assert.ok(reason && reason.label.startsWith("리허설"), `${code} 문장 없음`);
    assert.equal(reason!.kind, REHEARSAL_FAILURE_CLASS[code] === "platform" ? "system" : "step", code);
  }
  assert.equal(failureClassOf("REHEARSAL_POLICY_DENIED"), "cannot_vouch");
  assert.match(stopReasonOf("REHEARSAL_POLICY_DENIED", "paused")!.hint, /고장 났다는 뜻은 아닙니다/);
  assert.equal(isRehearsalCode("TF_APPLY_FAILED"), false);
});

test("배포 중인데 줄이 아직 없으면(이미지 복사 중) 리허설 준비", () => {
  assert.equal(rehearsalStepDetail(null, false, "deploying"), "리허설 준비");
  assert.equal(rehearsalStepDetail(null, false, "syncing"), undefined);
  assert.match(rehearsalHeroLine(null) ?? "", /리허설을 준비하고 있습니다 · 이미지 복사/);
});

test("기한은 지금 단계의 기한: 줄 서기 / 실행", () => {
  assert.equal(deadlineLabel(run({ status: "queued", phase: null })), "줄 서기 기한");
  assert.equal(deadlineLabel(run({ status: "running" })), "실행 기한");
  assert.equal(deadlineLabel(run({ status: "passed" })), null);
});

test("리허설 시간 초과는 어디서 났는지로 나눈다", () => {
  assert.equal(timeoutStageText("queue"), "샌드박스가 아직 돌지 못함 (줄 서기 기한 넘김)");
  assert.equal(timeoutStageText("run"), "실행 중 시간 초과");
  assert.equal(timeoutStageText(null), null);
  const move = (detail: Record<string, unknown>) => ({ kind: "transition" as const, at: "t", from: "deploying", to: "paused", detail, measurements: [] });
  assert.equal(stopEvidence([move({ rehearsal: { stage: "queue" } }) as never], "paused")?.rehearsalStage, "queue");
  assert.equal(stopEvidence([move({ rehearsal: { stage: "bogus" } }) as never], "paused")?.rehearsalStage, null);
  assert.equal(stopEvidence([move({}) as never], "paused")?.rehearsalStage, null);
});
