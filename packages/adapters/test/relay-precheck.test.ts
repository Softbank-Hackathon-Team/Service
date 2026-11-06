// 출발 AWS → 온프레 pull 도착: 사전 점검이 출발 실행 역할(svc-operate)의 중계기 권한을 흉내 평가하고 빠진 동작을 이름으로 알린다
//   가짜 exec 만 (실제 AWS 호출 없음)
import { test } from "node:test";
import assert from "node:assert/strict";
import { runCloudPrecheck, type PrecheckDeps, type PrecheckInput } from "../src/precheck/cloud-precheck.js";
import { RELAY_ACTIONS } from "../src/precheck/relay-permissions.js";

const j = (v: unknown) => JSON.stringify(v);
function fakeExec(calls: string[][], sim: (args: string[]) => { code: number; stdout: string; stderr: string }): PrecheckDeps["exec"] {
  return async (cmd, args) => {
    calls.push([cmd, ...args]);
    const out = (stdout: string) => ({ code: 0, stdout, stderr: "", ms: 1 });
    if (cmd !== "aws") return { code: 0, stdout: "yes", stderr: "", ms: 1 };
    if (args[0] === "sts") return out(j({ Account: "111111111111" }));
    if (args[0] === "iam" && args[1] === "simulate-principal-policy") return { ...sim(args), ms: 1 };
    if (args[1] === "describe-db-engine-versions") return out(j(["16.3"]));
    if (args[1] === "describe-regions") return out(j({ Regions: [{ OptInStatus: "opt-in-not-required" }] }));
    return out("0");
  };
}
const AGENT = { keys: 1, lastHeartbeatAgeSec: 5, staleSec: 120, k3sVersion: "v1.36.5+k3s1" };
const input = (o: Partial<PrecheckInput> = {}): PrecheckInput => ({
  source: { side: "source", provider: "aws", accountId: "111111111111" }, target: { side: "target", provider: "onprem", agent: AGENT },
  sourcePgMajor: 16, sourceDbBytes: 1, endpoints: [], ...o });
const deps = (calls: string[][], sim: Parameters<typeof fakeExec>[1], env: NodeJS.ProcessEnv = {}): PrecheckDeps => ({
  exec: fakeExec(calls, sim), env: { AWS_REGION: "ap-northeast-2", ...env }, tcp: async () => ({ ok: true, ms: 1 }), diskFree: async () => 50 * 1024 ** 3 });
const evalOf = (allowedExcept: string[]) => ({ code: 0, stderr: "", stdout: j({ EvaluationResults: RELAY_ACTIONS.map((a) =>
  ({ EvalActionName: a, EvalDecision: allowedExcept.includes(a) ? "implicitDeny" : "allowed" })) }) });

test("빠진 동작을 이름으로 알린다 (WARN + 고치는 법). 흉내 평가는 실행 역할 ARN·중계기 동작 전부·태그 조건 값으로", async () => {
  const calls: string[][] = [];
  const cs = await runCloudPrecheck(input(), deps(calls, () => evalOf(["ec2:RunInstances", "ec2:TerminateInstances"])));
  const c = cs.find((x) => x.id === "PC-RELAY-PERM")!;
  assert.equal(c.verdict, "WARN");
  assert.match(c.reason, /빠진 동작 2개: ec2:RunInstances, ec2:TerminateInstances/);
  assert.match(c.fix!, /aws-connect\.json/);
  assert.match(c.fix!, /SourceDbSecurityGroupId/);
  const sim = calls.find((a) => a[1] === "iam")!;
  assert.equal(sim[sim.indexOf("--policy-source-arn") + 1], "arn:aws:iam::111111111111:role/svc-operate");
  for (const a of RELAY_ACTIONS) assert.ok(sim.includes(a), a);
  assert.match(sim[sim.indexOf("--context-entries") + 1]!, /aws:ResourceTag\/managed-by/);
  // 다 있으면 PASS
  const ok = await runCloudPrecheck(input(), deps([], () => evalOf([])));
  assert.equal(ok.find((x) => x.id === "PC-RELAY-PERM")!.verdict, "PASS");
});

test("거부: 관찰 역할에 흉내 평가 권한이 없으면 WARN 으로 필요한 동작 전부를 적는다. 출발 AWS→온프레 pull 이 아니거나 RELAY_AUTO=0 이면 안 본다", async () => {
  const denied = () => ({ code: 254, stdout: "", stderr: "An error occurred (AccessDenied) when calling the SimulatePrincipalPolicy operation: not authorized" });
  const cs = await runCloudPrecheck(input(), deps([], denied));
  const c = cs.find((x) => x.id === "PC-RELAY-PERM")!;
  assert.equal(c.verdict, "WARN");
  assert.match(c.reason, /iam:SimulatePrincipalPolicy/);
  for (const a of RELAY_ACTIONS) assert.ok(c.reason.includes(a), a);
  for (const i of [input({ target: { side: "target", provider: "aws", accountId: "222222222222" } }), input({ target: { side: "target", provider: "onprem" } })]) {
    const calls: string[][] = [];
    const x = await runCloudPrecheck(i, deps(calls, denied));
    assert.equal(x.find((y) => y.id === "PC-RELAY-PERM"), undefined);
    assert.ok(!calls.some((a) => a[1] === "iam"));
  }
  const off = await runCloudPrecheck(input(), deps([], denied, { RELAY_AUTO: "0" }));
  assert.equal(off.find((y) => y.id === "PC-RELAY-PERM"), undefined);
});

// 한 계정에 환경 여럿 (0056): 출발 환경에 꼬리가 있으면 그 환경 실행 역할(svc-operate-<8자>)을 흉내 평가한다
test("RoleSuffix: 출발 환경 꼬리가 있으면 svc-operate-<8자> 를, 없으면 옛 이름 svc-operate 를 흉내 평가", async () => {
  const arnOf = async (awsRoleSuffix: string | null) => {
    const calls: string[][] = [];
    await runCloudPrecheck(input({ source: { side: "source", provider: "aws", accountId: "111111111111", awsRoleSuffix } }), deps(calls, () => evalOf([])));
    const sim = calls.find((a) => a[1] === "iam")!;
    return sim[sim.indexOf("--policy-source-arn") + 1];
  };
  assert.equal(await arnOf("-783df2ef"), "arn:aws:iam::111111111111:role/svc-operate-783df2ef");
  assert.equal(await arnOf(null), "arn:aws:iam::111111111111:role/svc-operate");
});
