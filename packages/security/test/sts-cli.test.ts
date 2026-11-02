// L4: AWS CLI STS 발급기 (가짜 run 만. 실제 AWS 호출 없음) + REAL_STS 환경별 발급기 고르기
import { test } from "node:test";
import assert from "node:assert/strict";
import { awsCliSts, awsStsIssuer, mockIssuer, perEnvAwsIssuer, StsCliError, assumeRoleInput, type IssueContext } from "../src/index.js";

const T = "11111111-1111-4111-8111-111111111111", E = "22222222-2222-4222-8222-222222222222";
const ctx = (externalId?: string): IssueContext => ({
  req: { tenantId: T, envId: E, provider: "aws", purpose: "observe", actions: ["eks:DescribeCluster"], ttlSec: 900 },
  now: new Date("2026-11-03T00:00:00Z"), roleRef: "arn:aws:iam::123456789012:role/svc-observe",
  sessionName: "svc-observe-11111111-observe-1", ...(externalId ? { externalId } : {}),
});
const OK = JSON.stringify({ Credentials: { AccessKeyId: "ASIAREAL", SecretAccessKey: "s", SessionToken: "t", Expiration: "2026-11-03T00:15:00Z" },
  AssumedRoleUser: { Arn: "arn:aws:sts::123456789012:assumed-role/svc-observe/x", AssumedRoleId: "AROA:x" } });

test("정상: assume-role 인자에 external-id·source-identity·tags·duration 900, --profile 없음, Expiration 은 Date", async () => {
  const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
  const sts = awsCliSts({ env: { AWS_REGION: "ap-northeast-2", AWS_PROFILE: "platform" },
    run: async (args, env) => { calls.push({ args, env }); return { code: 0, stdout: OK, stderr: "" }; } });
  const r = await sts.assumeRole(assumeRoleInput(ctx("ext-abc")));
  const a = calls[0]!.args;
  assert.deepEqual(a.slice(0, 2), ["sts", "assume-role"]);
  const val = (f: string) => a[a.indexOf(f) + 1];
  assert.equal(val("--external-id"), "ext-abc");
  assert.equal(val("--source-identity"), "svc-observe-11111111-observe-1");
  assert.equal(val("--duration-seconds"), "900");
  assert.equal(val("--region"), "ap-northeast-2");
  assert.ok(a.includes(`Key=svc:tenant,Value=${T}`) && a.includes("Key=svc:purpose,Value=observe"));
  assert.ok(!a.includes("--profile"));
  assert.ok(r.Credentials?.Expiration instanceof Date);
  assert.equal(r.Credentials?.Expiration?.toISOString(), "2026-11-03T00:15:00.000Z");
  // 발급기에 끼우면 aws 자격이 나온다
  const out = await awsStsIssuer({ sts }).issue(ctx("ext-abc"));
  assert.equal(out.material.kind, "aws");
  assert.equal(out.expiresAt.toISOString(), "2026-11-03T00:15:00.000Z");
});

test("거부: AccessDenied → StsCliError.awsCode, 메시지에 계정 번호·stderr 원문 없음", async () => {
  const stderr = "\nAn error occurred (AccessDenied) when calling the AssumeRole operation: User: arn:aws:sts::999988887777:assumed-role/p/x is not authorized to perform: sts:AssumeRole on resource: arn:aws:iam::123456789012:role/svc-observe\n";
  const sts = awsCliSts({ env: {}, run: async () => ({ code: 254, stdout: "", stderr }) });
  await assert.rejects(sts.assumeRole(assumeRoleInput(ctx("e"))), (e: unknown) => {
    assert.ok(e instanceof StsCliError);
    assert.equal(e.awsCode, "AccessDenied");
    assert.equal(e.code, 254);
    assert.ok(!e.message.includes("123456789012") && !e.message.includes("999988887777") && !e.message.includes("not authorized"));
    return true;
  });
  const missing = awsCliSts({ env: {}, run: async () => ({ code: 127, stdout: "", stderr: "aws 없음" }) });
  await assert.rejects(missing.assumeRole(assumeRoleInput(ctx("e"))), (e: unknown) => e instanceof StsCliError && e.missing && e.awsCode === null);
});

test("REAL_STS 래퍼: external_id 있는 환경만 진짜, 없는 환경(시드)은 mock", async () => {
  let realCalls = 0;
  const real = awsStsIssuer({ sts: { assumeRole: async () => { realCalls++; return {
    Credentials: { AccessKeyId: "ASIAREAL", SecretAccessKey: "s", SessionToken: "t", Expiration: new Date("2026-11-03T00:15:00Z") } }; } } });
  const w = perEnvAwsIssuer(real, mockIssuer("aws"));
  assert.equal(w.mockFor?.({}), true);
  assert.equal(w.mockFor?.({ externalId: "x" }), false);
  const seed = await w.issue(ctx());
  assert.equal(realCalls, 0);
  assert.ok(seed.material.kind === "aws" && seed.material.accessKeyId.startsWith("ASIAMOCK"));
  assert.equal(seed.detail.realSts, false);
  const live = await w.issue(ctx("ext-1"));
  assert.equal(realCalls, 1);
  assert.equal(live.detail.realSts, true);
});
