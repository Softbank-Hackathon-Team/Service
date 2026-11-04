import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkEntries, elapsedSec, failureClassOf, fidelityGroups, isolationLine, isRehearsalCode, isStaleRun, phaseEntries,
  rehearsalHeroLine, rehearsalPollMs, rehearsalRelevant, rehearsalState, rehearsalStepDetail, rehearsalSummary, remainingSec, SKIP_TEXT,
} from "../src/features/migration/rehearsal";
import { migrationSteps } from "../src/features/migration/model";
import { stopReasonOf } from "../src/lib/failure";
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

test("지난 시도: deploying 인데 실패 줄이 마지막 전이보다 먼저 생겼으면", () => {
  const failed = run({ status: "failed", createdAt: "2026-11-04T10:00:00Z" });
  assert.equal(isStaleRun(failed, { status: "deploying", updatedAt: "2026-11-04T10:30:00Z" }), true);
  assert.equal(isStaleRun(failed, { status: "paused", updatedAt: "2026-11-04T10:30:00Z" }), false, "멈춘 동안은 그 줄이 지금 이유다");
  assert.equal(isStaleRun(run({ status: "passed" }), { status: "deploying", updatedAt: "2026-11-04T10:30:00Z" }), false);
  assert.equal(isStaleRun(failed, { status: "deploying", updatedAt: "2026-11-04T09:59:00Z" }), false);
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
  assert.deepEqual(phaseEntries(run()).map((e) => e.status), ["done", "done", "active", "pending", "pending"]);
  assert.ok(phaseEntries(run({ status: "queued", phase: null })).every((e) => e.status === "pending"));
  assert.equal(rehearsalSummary(run({ phase: "checking" })), "도는 중 · 검사");
  assert.match(rehearsalHeroLine(run()) ?? "", /가상 클러스터에서 먼저 리허설/);
  assert.equal(rehearsalHeroLine(run({ status: "skipped", skip: "disabled" })), SKIP_TEXT.disabled);
  assert.equal(rehearsalHeroLine(run({ status: "failed" })), null, "멈춘 결론은 멈춤 화면이 말한다");
});

test("검사 줄: 판정에 드는 실패가 먼저, 참고 줄은 뒤", () => {
  const check = (id: "rollout" | "restarts" | "edge_http", ok: boolean, required: boolean) => ({ id, subject: "Deployment/web", required, ok, ms: 10, detail: ok ? "" : "CrashLoopBackOff 5회" });
  const { items, more } = checkEntries({ checks: [check("edge_http", false, false), check("rollout", true, true), check("restarts", false, true)] }, 2);
  assert.deepEqual(items.map((i) => i.status), ["failed", "done"]);
  assert.match(items[0]!.label, /재시작 없음 · Deployment\/web/);
  assert.equal(items[0]!.detail, "CrashLoopBackOff 5회");
  assert.equal(more, 1);
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
