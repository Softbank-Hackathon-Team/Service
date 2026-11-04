import { RehearsalResult, sandboxIsolation, type RehearsalCheck, type RehearsalInput } from "@svc/contracts";
import { sandboxName, VCLUSTER_CHART } from "../ai/vcluster.js";
import { parseManifests, subjectOf } from "./manifests.js";
import { withSandboxFidelity } from "./run.js";

// STUB: 시험 전용 MOCK_SANDBOX=1. 클러스터 없이 정해진 결과를 낸다 (로컬 화면·e2e). 시계·난수를 쓰지 않아 같은 입력이면 같은 결과
//   pass: 모든 검사 통과. fail: 첫 워크로드가 재시작을 멈추지 않음 (REHEARSAL_CRASHLOOP)
export function mockRehearsalResult(input: RehearsalInput, runId: string, outcome: "pass" | "fail"): RehearsalResult {
  const iso = sandboxIsolation("rehearsal");
  const name = sandboxName("rehearsal", runId);
  const applied = parseManifests(input.apply, "apply").manifests;
  const rollouts = applied.filter((m) => m.info.wait === "rollout");
  const c = (id: RehearsalCheck["id"], subject: string, ok: boolean, ms: number, detail: string): RehearsalCheck =>
    ({ id, subject, required: true, ok, ms, detail: `(흉내) ${detail}` });
  const checks: RehearsalCheck[] = [
    c("unsupported_kind", "묶음", true, 0, `적용 ${applied.length}개 모두 지원 목록 안`),
    c("quota", "도착 네임스페이스 한도", true, 0, "도착 안"),
    c("sandbox_ready", name, true, 58_000, "가상 v1.35.0 준비 58초"),
    ...applied.map((m) => c("dry_run", subjectOf(m), true, 40, "서버 dry-run 통과")),
    c("target_policy", "도착 파드 보안", true, 0, `도착 ${input.targetPodSecurity}`),
    ...applied.map((m) => c("apply", subjectOf(m), true, 60, "적용함")),
    ...rollouts.map((m) => c("rollout", subjectOf(m), true, 20_000, "준비 1/1")),
    ...rollouts.map((m, i) => outcome === "fail" && i === 0
      ? c("restarts", subjectOf(m), false, 60_000, "60초 관찰: 재시작 +3, 이유 Error")
      : c("restarts", subjectOf(m), true, 60_000, "60초 관찰: 재시작 +0")),
  ];
  const failed = outcome === "fail" && rollouts.length > 0;
  return RehearsalResult.parse({
    verdict: failed ? "failed" : "passed",
    failureCode: failed ? "REHEARSAL_CRASHLOOP" : null,
    sandbox: { ...iso, name, hostNamespace: name, chart: VCLUSTER_CHART, k8sVersion: "v1.35.0", mock: true },
    bundleSha256: input.bundleSha256,
    checks: failed ? checks : [...checks, ...rollouts.map((m) => c("ready", subjectOf(m), true, 0, "Ready 1/1"))],
    fidelity: withSandboxFidelity(input.fidelity, input.targetPodSecurity, iso),
    warnings: [],
    timingsMs: { create: 58_000, apply: 4_000, check: failed ? 80_000 : 85_000, delete: 9_000 },
    deleted: true,
  });
}
