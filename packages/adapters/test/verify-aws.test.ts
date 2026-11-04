// L4: 연결 확인 읽기 (빌린 자격으로 aws·kubectl). CLI 는 가짜 exec 만 (z88 방식). 실제 AWS 호출 없음
import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyAwsObserve, envFor, trustHasExternalId } from "../src/verify/aws.js";
import type { Exec } from "../src/terraform/real-runner.js";

type Reply = { code?: number; out?: unknown; err?: string };
function fakeExec(table: Array<[RegExp, Reply]>) {
  const calls: Array<{ cmd: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
  const exec: Exec = async (cmd, args, o) => {
    calls.push({ cmd, args, env: o.env });
    const line = `${cmd} ${args.join(" ")}`;
    const hit = table.find(([re]) => re.test(line));
    if (!hit) return { code: 1, stdout: "", stderr: `no fake for: ${line}`, ms: 1 };
    const r = hit[1];
    return { code: r.code ?? 0, stdout: typeof r.out === "string" ? r.out : JSON.stringify(r.out ?? null), stderr: r.err ?? "", ms: 1 };
  };
  return { exec, calls };
}
const TRUST = encodeURIComponent(JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { AWS: "arn:aws:iam::111122223333:root" },
  Action: "sts:AssumeRole", Condition: { StringEquals: { "sts:ExternalId": "ext-1" } } }] }));
const NO_EXT = JSON.stringify({ Statement: [{ Effect: "Allow", Principal: { AWS: "x" }, Action: "sts:AssumeRole" }] });
const denied = (op: string): Reply => ({ code: 254, err: `An error occurred (AccessDenied) when calling the ${op} operation: arn:aws:iam::123456789012:role/svc-observe` });
const table = (over: Array<[RegExp, Reply]> = []): Array<[RegExp, Reply]> => [...over,
  [/^aws eks list-clusters/, { out: { clusters: ["other", "shop"] } }],
  [/^aws eks describe-cluster/, { out: { cluster: { name: "shop" } } }],
  [/^aws rds describe-db-instances/, { out: { DBInstances: [] } }],
  [/^aws iam get-role --role-name svc-operate/, { out: { Role: { AssumeRolePolicyDocument: TRUST } } }],
  [/^aws guardduty list-detectors/, { out: { DetectorIds: [] } }],
  [/^aws eks update-kubeconfig/, { out: "Added new context" }],
  [/^kubectl --kubeconfig .* auth can-i list deployments --all-namespaces/, { out: "yes\n" }],
  [/^kubectl --kubeconfig .* get namespaces -o name/, { out: "namespace/default\n" }],
];
const CLI = { AWS_ACCESS_KEY_ID: "ASIABORROWED", AWS_SECRET_ACCESS_KEY: "s", AWS_SESSION_TOKEN: "t", AWS_REGION: "ap-northeast-2" };
const BASE = { AWS_PROFILE: "platform", AWS_DEFAULT_PROFILE: "p2", AWS_ACCESS_KEY_ID: "AKIAOWN", HOME: "/h", PATH: "/bin" };
const input = { region: "ap-northeast-2", clusterName: "shop", cliEnv: CLI };

test("정상: 6단계 모두 통과 → ok, 모든 호출이 빌린 자격만 씀 (프로필·워커 키 없음)", async () => {
  const { exec, calls } = fakeExec(table());
  const r = await verifyAwsObserve({ exec, env: BASE }, input);
  assert.deepEqual(r, { ok: true, clusters: ["other", "shop"] });
  assert.equal(calls.length, 8);   // FM-CON-09: 실제 목록 읽기 한 번 더
  for (const c of calls) {
    assert.equal(c.env.AWS_PROFILE, undefined);
    assert.equal(c.env.AWS_DEFAULT_PROFILE, undefined);
    assert.equal(c.env.AWS_ACCESS_KEY_ID, "ASIABORROWED");
    assert.equal(c.env.HOME, "/h");
    assert.ok(!c.args.includes("--profile"));
  }
  assert.deepEqual(Object.keys(envFor({ A: "1" }, { AWS_SESSION_TOKEN: "x", PATH: "/b" })).sort(), ["A", "PATH"]);
});

test("거부: rds AccessDenied → PERMISSION_MISSING:rds:DescribeDBInstances (그 뒤 호출 없음)", async () => {
  const { exec, calls } = fakeExec(table([[/^aws rds describe-db-instances/, denied("DescribeDBInstances")]]));
  assert.deepEqual(await verifyAwsObserve({ exec, env: BASE }, input), { ok: false, reason: "PERMISSION_MISSING:rds:DescribeDBInstances" });
  assert.ok(!calls.some((c) => c.args[0] === "iam"));
});

test("거부: 실행 역할 없음(NoSuchEntity) → ROLE_NOT_FOUND / 신뢰 정책에 ExternalId 없음 / SCP → ORG_POLICY_BLOCKED", async () => {
  let f = fakeExec(table([[/^aws iam get-role/, { code: 254, err: "An error occurred (NoSuchEntity) when calling the GetRole operation: The role with name svc-operate cannot be found." }]]));
  assert.deepEqual(await verifyAwsObserve({ exec: f.exec, env: BASE }, input), { ok: false, reason: "ROLE_NOT_FOUND" });
  f = fakeExec(table([[/^aws iam get-role/, { out: { Role: { AssumeRolePolicyDocument: NO_EXT } } }]]));
  assert.deepEqual(await verifyAwsObserve({ exec: f.exec, env: BASE }, input), { ok: false, reason: "PERMISSION_MISSING:sts:ExternalId" });
  f = fakeExec(table([[/^aws rds describe-db-instances/, { code: 254, err: "An error occurred (AccessDenied) when calling the DescribeDBInstances operation: ... with an explicit deny in a service control policy" }]]));
  assert.deepEqual(await verifyAwsObserve({ exec: f.exec, env: BASE }, input), { ok: false, reason: "ORG_POLICY_BLOCKED" });
});

test("PF02: GuardDuty 읽기는 선택 — SCP·권한 없음이어도 연결은 ok + missingPermissions, 그 밖의 오류는 던짐", async () => {
  for (const err of ["An error occurred (AccessDeniedException) when calling the ListDetectors operation: ... with an explicit deny in a service control policy",
                     "An error occurred (AccessDeniedException) when calling the ListDetectors operation: not authorized"]) {
    const f = fakeExec(table([[/^aws guardduty/, { code: 254, err }]]));
    assert.deepEqual(await verifyAwsObserve({ exec: f.exec, env: BASE }, input), { ok: true, clusters: ["other", "shop"], missingPermissions: ["guardduty:ListDetectors"] });
  }
  const f = fakeExec(table([[/^aws guardduty/, { code: 255, err: "Could not connect to the endpoint URL" }]]));
  await assert.rejects(verifyAwsObserve({ exec: f.exec, env: BASE }, input));
});

test("PF02 거부: 클러스터 이름이 EKS 모양이 아니면(-- 로 시작 등) CLI 를 부르지 않고 K8S_ACCESS_MISSING", async () => {
  for (const clusterName of ["--endpoint-url=http://x", "a b", "-x", ""]) {
    const f = fakeExec(table());
    assert.deepEqual(await verifyAwsObserve({ exec: f.exec, env: BASE }, { ...input, clusterName }), { ok: false, reason: "K8S_ACCESS_MISSING" });
    assert.equal(f.calls.length, 0, clusterName);
  }
});

test("거부: can-i no → K8S_ACCESS_MISSING / 클러스터 이름 없음 → K8S_ACCESS_MISSING / aws 명령 없음은 던짐", async () => {
  let f = fakeExec(table([[/auth can-i/, { code: 1, out: "no\n" }]]));
  assert.deepEqual(await verifyAwsObserve({ exec: f.exec, env: BASE }, input), { ok: false, reason: "K8S_ACCESS_MISSING" });
  f = fakeExec(table());
  assert.deepEqual(await verifyAwsObserve({ exec: f.exec, env: BASE }, { ...input, clusterName: "nope" }), { ok: false, reason: "K8S_ACCESS_MISSING" });
  f = fakeExec([[/^aws/, { code: 127, err: "aws 없음" }]]);
  await assert.rejects(verifyAwsObserve({ exec: f.exec, env: BASE }, input));
});

test("trustHasExternalId: URL 인코딩·평문·Statement 하나짜리", () => {
  assert.equal(trustHasExternalId(TRUST), true);
  assert.equal(trustHasExternalId(NO_EXT), false);
  assert.equal(trustHasExternalId({ Statement: { Effect: "Allow", Condition: { StringEquals: { "sts:ExternalId": "x" } } } }), true);
  assert.equal(trustHasExternalId("%%bad"), false);
});

test("PF03 FM-NET: can-i 가 API 서버에 못 붙으면(시간 초과·연결 거부) no 가 아니라 던짐 (재시도), 진짜 no 는 K8S_ACCESS_MISSING", async () => {
  for (const err of ["Unable to connect to the server: dial tcp 10.0.0.1:443: i/o timeout", "error: the server doesn't have a resource type: connection refused"]) {
    const f = fakeExec(table([[/auth can-i/, { code: 1, out: "", err }]]));
    await assert.rejects(verifyAwsObserve({ exec: f.exec, env: BASE }, input));
  }
  const f = fakeExec(table([[/auth can-i/, { code: 1, out: "no\n" }]]));
  assert.deepEqual(await verifyAwsObserve({ exec: f.exec, env: BASE }, input), { ok: false, reason: "K8S_ACCESS_MISSING" });
});

test("FM-CON-09 (실측): can-i yes 여도 실제 목록 읽기가 401 → K8S_ACCESS_MISSING:UNAUTHORIZED (예전엔 connected)", async () => {
  const unauth: Reply = { code: 1, err: "error: You must be logged in to the server (Unauthorized)" };
  let f = fakeExec(table([[/get namespaces/, unauth]]));
  assert.deepEqual(await verifyAwsObserve({ exec: f.exec, env: BASE }, input), { ok: false, reason: "K8S_ACCESS_MISSING:UNAUTHORIZED" });
  f = fakeExec(table([[/auth can-i/, unauth]]));
  assert.deepEqual(await verifyAwsObserve({ exec: f.exec, env: BASE }, input), { ok: false, reason: "K8S_ACCESS_MISSING:UNAUTHORIZED" });
  assert.equal(f.calls.some((c) => c.args.includes("namespaces")), false, "can-i 에서 끝나면 목록 안 읽음");
  // 403 (인증은 됐지만 권한 없음) 은 예전처럼 K8S_ACCESS_MISSING
  f = fakeExec(table([[/get namespaces/, { code: 1, err: 'Error from server (Forbidden): namespaces is forbidden: User "x" cannot list resource "namespaces"' }]]));
  assert.deepEqual(await verifyAwsObserve({ exec: f.exec, env: BASE }, input), { ok: false, reason: "K8S_ACCESS_MISSING" });
});
