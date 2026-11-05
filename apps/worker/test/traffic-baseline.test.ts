// #245: 전환 직전 기준값은 관찰 역할을 필요한 권한만 빌려 읽고 바로 돌려준다 (DB 없이, 발급기·읽기 가짜)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readSourceBaseline } from "../src/traffic-baseline.js";

const I = { tenantId: "t", migrationId: "m", envId: "e", provider: "aws", region: null, origins: ["shop.elb.amazonaws.com"] };
function fakeRoles(stub = false) {
  const issued: { actions: string[]; purpose: string }[] = [], revoked: string[] = [];
  return { issued, revoked, roles: {
    issue: async (r: { actions: string[]; purpose: string }) => { issued.push(r); return { credentialRef: "ref", stub, expiresAt: "x" }; },
    use: () => ({ kind: "aws", accessKeyId: "a", secretAccessKey: "b", sessionToken: "c" }),
    revoke: async (ref: string) => { revoked.push(ref); },
  } as never };
}

test("필요한 읽기 권한만 빌려 읽고, 끝나면 돌려준다", async () => {
  const f = fakeRoles();
  let got: { region?: string; cliEnv?: Record<string, string> } = {};
  const r = await readSourceBaseline(I, { roles: f.roles, read: (async (o: typeof got) => { got = o; return { rps: 50, lb: "app/s/1", from: "a", to: "b" }; }) as never });
  assert.deepEqual(r, { rps: 50, lb: "app/s/1", from: "a", to: "b" });
  assert.equal(f.issued[0]!.purpose, "observe");
  assert.deepEqual([...f.issued[0]!.actions].sort(), ["cloudwatch:GetMetricStatistics", "elasticloadbalancing:DescribeLoadBalancers"]);
  assert.equal(got.region, "ap-northeast-2");
  assert.equal(got.cliEnv?.AWS_SESSION_TOKEN, "c");
  assert.deepEqual(f.revoked, ["ref"]);
});

test("읽다 실패해도 자격은 돌려준다", async () => {
  const f = fakeRoles();
  await assert.rejects(readSourceBaseline(I, { roles: f.roles, read: (async () => { throw new Error("거부"); }) as never }), /거부/);
  assert.deepEqual(f.revoked, ["ref"]);
});

test("거부: AWS 가 아니거나, 원본 주소가 없으면 역할을 빌리지 않고, 흉내 자격이면 읽지 않는다", async () => {
  const a = fakeRoles();
  assert.ok("error" in await readSourceBaseline({ ...I, provider: "gcp" }, { roles: a.roles }));
  assert.ok("error" in await readSourceBaseline({ ...I, origins: [] }, { roles: a.roles }));
  assert.equal(a.issued.length, 0);
  const b = fakeRoles(true);
  const r = await readSourceBaseline(I, { roles: b.roles, read: (async () => assert.fail("흉내 자격으로 읽음")) as never });
  assert.ok("error" in r);
  assert.deepEqual(b.revoked, ["ref"]);
});
