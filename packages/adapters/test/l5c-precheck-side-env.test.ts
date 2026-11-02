// L5c: 사전 점검이 쪽마다 빌린 관찰 자격 env 로 클라우드 CLI 를 부르는가. 가짜 exec 만 (실제 AWS 호출 없음)
import { test } from "node:test";
import assert from "node:assert/strict";
import { runCloudPrecheck, type PrecheckDeps, type PrecheckInput } from "../src/precheck/cloud-precheck.js";
import { envFor } from "../src/verify/aws.js";

const j = (v: unknown) => JSON.stringify(v);
type Call = { key: string; env: NodeJS.ProcessEnv };
function fakeExec(calls: Call[]): PrecheckDeps["exec"] {
  return async (cmd, args, o) => {
    const key = `${cmd} ${args.join(" ")}`;
    calls.push({ key, env: o.env });
    // 계정 번호는 env 의 AWS_CONFIG_FILE 로 가른다 (빌린 자격마다 다른 계정)
    const acct = o.env.AWS_CONFIG_FILE?.includes("src") ? "111111111111" : o.env.AWS_CONFIG_FILE?.includes("tgt") ? "222222222222" : "999999999999";
    const out = (stdout: string) => ({ code: 0, stdout, stderr: "", ms: 1 });
    if (key.startsWith("aws sts get-caller-identity")) return out(j({ Account: acct }));
    if (key.startsWith("aws ec2 describe-regions")) return out(j({ Regions: [{ RegionName: "ap-northeast-2", OptInStatus: "opt-in-not-required" }] }));
    if (key.startsWith("aws service-quotas")) return out(j({ Quota: { Value: 5 } }));
    if (key.startsWith("aws rds describe-db-engine-versions")) return out(j(["16.3"]));
    if (key.startsWith("aws")) return out("0");
    return { code: 1, stdout: "", stderr: `unexpected ${key}`, ms: 1 };
  };
}
const BASE = { AWS_REGION: "ap-northeast-2", AWS_PROFILE: "finals", AWS_ACCESS_KEY_ID: "AKIAOWN", PATH: "/bin" } as NodeJS.ProcessEnv;
const awsToAws: PrecheckInput = {
  source: { side: "source", provider: "aws", accountId: "111111111111" }, target: { side: "target", provider: "aws", accountId: "222222222222" },
  sourcePgMajor: 16, sourceDbBytes: 1, endpoints: [],
};
const deps = (calls: Call[], sideEnv?: PrecheckDeps["sideEnv"]): PrecheckDeps => ({ exec: fakeExec(calls), env: BASE,
  tcp: async () => ({ ok: true, ms: 1 }), diskFree: async () => 50 * 1024 ** 3, ...(sideEnv ? { sideEnv } : {}) });

test("정상: 출발·도착 aws 조회가 각자 빌린 자격 env (프로필·워커 키 없음) → 두 계정 모두 일치 PASS", async () => {
  const calls: Call[] = [];
  const sideEnv = {
    source: envFor({ AWS_CONFIG_FILE: "/tmp/src/config", AWS_SHARED_CREDENTIALS_FILE: "/tmp/src/credentials", AWS_REGION: "ap-northeast-2" }, BASE),
    target: envFor({ AWS_CONFIG_FILE: "/tmp/tgt/config", AWS_SHARED_CREDENTIALS_FILE: "/tmp/tgt/credentials", AWS_REGION: "ap-northeast-2" }, BASE),
  };
  const cs = await runCloudPrecheck(awsToAws, deps(calls, sideEnv));
  const by = new Map(cs.map((c) => [c.id, c]));
  assert.equal(by.get("PC-CRED-S")!.verdict, "PASS", by.get("PC-CRED-S")!.reason);
  assert.equal(by.get("PC-CRED-T")!.verdict, "PASS", by.get("PC-CRED-T")!.reason);
  const aws = calls.filter((c) => c.key.startsWith("aws"));
  assert.ok(aws.length > 3);
  for (const c of aws) {
    assert.equal(c.env.AWS_PROFILE, undefined, c.key);
    assert.equal(c.env.AWS_ACCESS_KEY_ID, undefined, c.key);
    assert.ok(c.env.AWS_CONFIG_FILE, c.key);
  }
  // 도착 쪽 조회(지역·할당량·엔진 버전)는 도착 자격으로
  for (const c of aws.filter((x) => /describe-regions|service-quotas|describe-db-engine-versions/.test(x.key)))
    assert.equal(c.env.AWS_CONFIG_FILE, "/tmp/tgt/config", c.key);
});

test("거부(깃발 off 그대로): sideEnv 없으면 프로세스 env 그대로 → 등록 계정과 다르면 FAIL", async () => {
  const calls: Call[] = [];
  const cs = await runCloudPrecheck(awsToAws, deps(calls));
  assert.equal(new Map(cs.map((c) => [c.id, c])).get("PC-CRED-T")!.verdict, "FAIL");
  assert.ok(calls.filter((c) => c.key.startsWith("aws")).every((c) => c.env.AWS_PROFILE === "finals"));
});
