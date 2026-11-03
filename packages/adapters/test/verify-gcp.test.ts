// L7i: GCP 연결 확인 읽기 — 가짜 exec 만 (실제 gcloud 호출 없음)
import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyGcpObserve, gcpEnvFor } from "../src/verify/gcp.js";
import type { Exec } from "../src/terraform/real-runner.js";

type Reply = { code?: number; out?: unknown; err?: string };
function fakeExec(table: Array<[RegExp, Reply]>) {
  const calls: Array<{ line: string; env: NodeJS.ProcessEnv }> = [];
  const exec: Exec = async (cmd, args, o) => {
    const line = `${cmd} ${args.join(" ")}`; calls.push({ line, env: o.env });
    const hit = table.find(([re]) => re.test(line));
    const r = hit?.[1] ?? { code: 1, err: `no fake for: ${line}` };
    return { code: r.code ?? 0, stdout: JSON.stringify(r.out ?? null), stderr: r.err ?? "", ms: 1 };
  };
  return { exec, calls };
}
const P = "cust-proj-123";
const denied: Reply = { code: 1, err: "ERROR: (gcloud) PERMISSION_DENIED: Permission denied on resource project" };
const table = (over: Array<[RegExp, Reply]> = []): Array<[RegExp, Reply]> => [...over,
  [/^gcloud projects describe/, { out: { projectId: P, projectNumber: "123456789012" } }],
  [/^gcloud container clusters list/, { out: [{ name: "shop" }] }],
  [/^gcloud sql instances list/, { out: [] }],
  [/^gcloud iam service-accounts describe svc-operate@/, { out: { email: `svc-operate@${P}.iam.gserviceaccount.com` } }],
];
const input = { projectId: P, token: "ya29.secret", clusterName: "shop" };

test("정상: 읽기 4번 모두 통과, 프로젝트 번호를 돌려주고 빌린 토큰만 쓴다", async () => {
  const f = fakeExec(table());
  const r = await verifyGcpObserve({ exec: f.exec, env: { PATH: "/bin", GOOGLE_APPLICATION_CREDENTIALS: "/own.json", CLOUDSDK_CORE_ACCOUNT: "me" } }, input);
  assert.deepEqual(r, { ok: true, clusters: ["shop"], projectNumber: "123456789012" });
  assert.equal(f.calls.length, 4);
  for (const c of f.calls) {
    assert.equal(c.env.CLOUDSDK_AUTH_ACCESS_TOKEN, "ya29.secret");
    assert.equal(c.env.GOOGLE_APPLICATION_CREDENTIALS, undefined);
    assert.equal(c.env.CLOUDSDK_CORE_ACCOUNT, undefined);
    assert.ok(!c.line.includes("ya29"), "토큰은 인자에 안 들어간다");
  }
  assert.equal(gcpEnvFor("t", P, {}).CLOUDSDK_CORE_PROJECT, P);
});

test("거부: 프로젝트 번호가 처음과 다르면 ACCOUNT_MISMATCH (이후 읽기 안 함), 번호가 없던 첫 확인은 통과", async () => {
  const f = fakeExec(table());
  assert.deepEqual(await verifyGcpObserve({ exec: f.exec, env: {} }, { ...input, expectedProjectNumber: "999999999999" }), { ok: false, reason: "ACCOUNT_MISMATCH" });
  assert.equal(f.calls.length, 1);
  assert.equal((await verifyGcpObserve({ exec: f.exec, env: {} }, { ...input, expectedProjectNumber: "123456789012" })).ok, true);
  const other = fakeExec(table([[/^gcloud projects describe/, { out: { projectId: "someone-else", projectNumber: "1" + "0".repeat(11) } }]]));
  assert.equal((await verifyGcpObserve({ exec: other.exec, env: {} }, input) as { reason: string }).reason, "ACCOUNT_MISMATCH");
});

test("거부: 읽기 권한 없음 → PERMISSION_MISSING:<권한>, 클러스터 이름 없음 → K8S_ACCESS_MISSING, 실행 SA 없음 → ROLE_NOT_FOUND, 조직 정책 → ORG_POLICY_BLOCKED", async () => {
  const r = async (over: Array<[RegExp, Reply]>, i = input) => (await verifyGcpObserve({ exec: fakeExec(table(over)).exec, env: {} }, i) as { reason: string }).reason;
  assert.equal(await r([[/^gcloud sql instances list/, denied]]), "PERMISSION_MISSING:sql.instances.list");
  assert.equal(await r([[/^gcloud container clusters list/, denied]]), "PERMISSION_MISSING:container.clusters.list");
  assert.equal(await r([], { ...input, clusterName: "nope" }), "K8S_ACCESS_MISSING");
  assert.equal(await r([[/^gcloud iam service-accounts describe/, { code: 1, err: "NOT_FOUND: Unknown service account" }]]), "ROLE_NOT_FOUND");
  assert.equal(await r([[/^gcloud sql instances list/, { code: 1, err: "constraints/gcp.resourceLocations violated by organization policy" }]]), "ORG_POLICY_BLOCKED");
  await assert.rejects(verifyGcpObserve({ exec: fakeExec(table([[/^gcloud sql instances list/, { code: 127 }]])).exec, env: {} }, input));
});
