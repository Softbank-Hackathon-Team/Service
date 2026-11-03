import { test } from "node:test";
import assert from "node:assert/strict";
import { argoWatcherFromEnv, degradedDetail, judgeArgo, scrubReason, DEGRADED_UNKNOWN, type ArgoAppStatus, type KubectlRun } from "../src/gitops/argo-watch.js";

// ARGODEG: Argo 가 health.message 를 비워도 ARGO_DEGRADED 사유가 빈칸이 되지 않는다 (맥 실측 Z103)
const C = "c".repeat(40);
const b = { tenant: "t-1a2b3c4d", app: "guestbook", env: "gcp-gke" as const };
const commit = { commit: C, bundleSha256: "x", resources: [], changed: true };
const clock = () => { let t = 0; return { now: () => t, sleep: async (ms: number) => { t += ms; } }; };
const degraded = (extra: Partial<ArgoAppStatus> = {}): ArgoAppStatus => ({ sync: { status: "Synced", revision: C }, health: { status: "Degraded" }, ...extra });

test("빈 message 1: Application conditions 에서 채움 (…Error 조건 우선)", () => {
  const s = degraded({ conditions: [{ type: "SharedResourceWarning", message: "경고" }, { type: "ComparisonError", message: "failed to generate manifest" }] });
  assert.equal(judgeArgo(s, C).reason, "ARGO_DEGRADED: ComparisonError: failed to generate manifest");
});
test("빈 message 2: resources[] 의 Degraded 자원 health.message 에서 채움 (Healthy 자원은 무시)", () => {
  const s = degraded({ resources: [
    { kind: "Service", name: "web", health: { status: "Healthy", message: "ok" } },
    { kind: "Deployment", name: "web", health: { status: "Degraded", message: "Deployment does not have minimum availability." } }] });
  assert.equal(judgeArgo(s, C).reason, "ARGO_DEGRADED: Deployment/web: Deployment does not have minimum availability.");
});
test("빈 message 3: 전부 비면 고정 문구 (공백 message 도 비어 있는 것으로)", () => {
  for (const s of [degraded(), degraded({ health: { status: "Degraded", message: "   " }, conditions: [{ type: "X", message: "" }], resources: [{ kind: "Deployment", name: "w", health: { status: "Degraded" } }] })]) {
    const j = judgeArgo(s, C);
    assert.equal(j.reason, `ARGO_DEGRADED: ${DEGRADED_UNKNOWN}`);
    assert.equal(j.emptyDetail, true);
  }
});
test("message 가 있으면 예전 그대로 (순서 1번)", () => {
  assert.equal(judgeArgo(degraded({ health: { status: "Degraded", message: "x" }, conditions: [{ type: "E", message: "무시" }] }), C).reason, "ARGO_DEGRADED: x");
  assert.equal(degradedDetail(degraded()), "");
});

// ── ④ k8s 길: Deployment conditions · Pod 대기 이유 ──
const appJson = (status: ArgoAppStatus) => JSON.stringify({ status });
function kube(app: ArgoAppStatus, dep: unknown, pods: unknown, calls: string[][] = []): KubectlRun {
  return async (args) => {
    calls.push(args);
    const a = args.join(" ");
    if (/annotate/.test(a)) return { code: 0, stdout: "", stderr: "" };
    if (/get applications/.test(a)) return { code: 0, stdout: appJson(app), stderr: "" };
    if (/get deployment /.test(a)) return dep === null ? { code: 1, stdout: "", stderr: "Forbidden" } : { code: 0, stdout: JSON.stringify(dep), stderr: "" };
    if (/get pods/.test(a)) return { code: 0, stdout: JSON.stringify(pods), stderr: "" };
    return { code: 1, stdout: "", stderr: "unexpected" };
  };
}
const appWithDeploy = degraded({ resources: [{ kind: "Deployment", name: "web", namespace: "app-shop", health: { status: "Degraded" } }] });
const dep = { spec: { selector: { matchLabels: { app: "web" } } }, status: { conditions: [
  { type: "Available", status: "False", reason: "MinimumReplicasUnavailable", message: "Deployment does not have minimum availability." },
  { type: "Progressing", status: "False", reason: "ProgressDeadlineExceeded", message: 'ReplicaSet "web-1" has timed out progressing.' }] } };
const pods = { items: [{ status: { containerStatuses: [{ state: { waiting: { reason: "ImagePullBackOff", message: "Back-off pulling image" } } }] } }] };

test("k8s 길: Application 에 사유가 없으면 Deployment conditions + Pod 대기 이유로 채움, 읽은 명령은 get 뿐", async () => {
  const calls: string[][] = [];
  const r = await argoWatcherFromEnv({ ARGO_SOURCE: "k8s", ARGO_KUBE_CONTEXT: "hub" }, { kubectl: kube(appWithDeploy, dep, pods, calls), ...clock() }).wait(b, commit);
  assert.equal(r.ok, false);
  assert.match(r.reason!, /^ARGO_DEGRADED: Deployment\/web: Available: Deployment does not have minimum availability\.; Progressing: ReplicaSet "web-1" has timed out progressing\.; Pod: ImagePullBackOff \(Back-off pulling image\)$/);
  assert.ok(calls.every((c) => c.some((x) => ["get", "annotate"].includes(x))), "쓰기 의심 명령");
  assert.ok(!calls.some((c) => c.includes("delete") || c.includes("apply") || c.includes("patch")));
});
test("k8s 길: Deployment 를 못 읽으면(권한 없음) 고정 문구, 던지지 않음", async () => {
  const r = await argoWatcherFromEnv({ ARGO_SOURCE: "k8s" }, { kubectl: kube(appWithDeploy, null, pods), ...clock() }).wait(b, commit);
  assert.equal(r.reason, `ARGO_DEGRADED: ${DEGRADED_UNKNOWN}`);
});
test("k8s 길: Application 에 사유가 이미 있으면 Deployment 를 더 읽지 않음", async () => {
  const calls: string[][] = [];
  const s = degraded({ health: { status: "Degraded", message: "ImagePullBackOff" }, resources: appWithDeploy.resources });
  const r = await argoWatcherFromEnv({ ARGO_SOURCE: "k8s" }, { kubectl: kube(s, dep, pods, calls), ...clock() }).wait(b, commit);
  assert.equal(r.reason, "ARGO_DEGRADED: ImagePullBackOff");
  assert.ok(!calls.some((c) => c.includes("deployment")));
});

// ── 가리기 ──
test("비밀값·이미지 자격 문구 가림: URL user:pass@, Bearer, password=, 접근 키 ID, JWT, 계정 번호, imagePullSecrets", () => {
  const raw = [
    "pull from https://bob:s3cr3tpw@registry.example/app failed",
    "Authorization: Bearer abcdef1234567890xyz",
    "password=hunter2 token: abc123",
    "key AKIAABCDEFGHIJKLMNOP",
    "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk",
    "image 123456789012.dkr.ecr.ap-northeast-2.amazonaws.com/shop-api:1.0 pull access denied, imagePullSecrets regcred is missing",
  ].join(" | ");
  const out = scrubReason(raw);
  for (const leak of ["s3cr3tpw", "abcdef1234567890xyz", "hunter2", "abc123", "AKIAABCDEFGHIJKLMNOP", "eyJhbGci", "123456789012", "regcred"]) assert.ok(!out.includes(leak), `${leak} 가 남음: ${out}`);
  assert.match(out, /registry\.example/);   // 호스트는 남김
});
test("가린 결과가 사유 앞머리·길이 규칙을 지킴 (코드 앞머리 ARGO_DEGRADED, 200자 이내)", () => {
  const s = degraded({ conditions: [{ type: "ComparisonError", message: "x".repeat(500) + " password=pw" }] });
  const r = judgeArgo(s, C).reason!;
  assert.ok(/^ARGO_DEGRADED: /.test(r) && r.length <= "ARGO_DEGRADED: ".length + 200);
  assert.ok(!r.includes("password=pw"));
});
