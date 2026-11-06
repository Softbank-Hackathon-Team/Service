// AWS 도착 사실 (aws/target-facts.ts): 도착 EKS 의 describe-cluster·describe-subnets → aws/root 자리표시 값. 클라우드 호출 0 (CLI 는 가짜)
import { test } from "node:test";
import assert from "node:assert/strict";
import { awsTargetFactsOf, readAwsTargetFacts, type Exec } from "../src/index.js";

const VPC = "vpc-0aaa1111bbbb2222c";
const DESCRIBED = { cluster: { name: "customer-eks", status: "ACTIVE", resourcesVpcConfig: { vpcId: VPC,
  subnetIds: ["subnet-0c3c3c3c3c3c3c3c3", "subnet-0a1a1a1a1a1a1a1a1", "subnet-0b2b2b2b2b2b2b2b2", "subnet-0d4d4d4d4d4d4d4d4"] } } };
const sn = (id: string, az: string, pub: boolean, tags: { Key: string; Value: string }[] = []) =>
  ({ SubnetId: id, AvailabilityZone: az, VpcId: VPC, MapPublicIpOnLaunch: pub, Tags: tags });
const SUBNETS = { Subnets: [
  sn("subnet-0c3c3c3c3c3c3c3c3", "ap-northeast-2c", false), sn("subnet-0a1a1a1a1a1a1a1a1", "ap-northeast-2a", false),
  sn("subnet-0b2b2b2b2b2b2b2b2", "ap-northeast-2a", true), sn("subnet-0d4d4d4d4d4d4d4d4", "ap-northeast-2c", false, [{ Key: "kubernetes.io/role/elb", Value: "1" }]),
] };

test("사설·공개 서브넷을 나누고 정렬해서 aws/root 자리표시 이름으로 (eksctl·env 모듈 표시 둘 다 공개로 본다)", () => {
  assert.deepEqual(awsTargetFactsOf("customer-eks", "ap-northeast-2", DESCRIBED, SUBNETS), { ok: true, cluster: "customer-eks", region: "ap-northeast-2", facts: {
    clusterName: "customer-eks", vpcId: VPC,
    dbSubnetIdsJson: '["subnet-0a1a1a1a1a1a1a1a1","subnet-0c3c3c3c3c3c3c3c3"]',
    dbPublicSubnetIdsJson: '["subnet-0b2b2b2b2b2b2b2b2","subnet-0d4d4d4d4d4d4d4d4"]',
  } });
});

test("공개 서브넷이 한 영역뿐이면 공개 DB 키를 빼고 (그때만 모자람), 다른 VPC 서브넷은 세지 않는다", () => {
  const r = awsTargetFactsOf("customer-eks", "ap-northeast-2", DESCRIBED, { Subnets: [...SUBNETS.Subnets.slice(0, 3),
    { ...sn("subnet-0e5e5e5e5e5e5e5e5", "ap-northeast-2c", true), VpcId: "vpc-0other000000000000" }] });
  assert.ok(r.ok);
  assert.equal(r.facts.dbPublicSubnetIdsJson, undefined);
  assert.equal(r.facts.dbSubnetIdsJson, '["subnet-0a1a1a1a1a1a1a1a1","subnet-0c3c3c3c3c3c3c3c3"]');
});

test("거부: 사설 서브넷이 한 영역뿐 / 클러스터가 ACTIVE 아님 / VPC 없음 → 이유 (RDS 서브넷 그룹 규칙)", () => {
  const reason = (x: ReturnType<typeof awsTargetFactsOf>) => (x.ok ? "ok" : x.reason);
  assert.match(reason(awsTargetFactsOf("customer-eks", "ap-northeast-2", DESCRIBED, { Subnets: SUBNETS.Subnets.filter((s) => s.AvailabilityZone === "ap-northeast-2a") })),
    /사설 서브넷이 두 영역\(AZ\) 이상에 없다/);
  assert.match(reason(awsTargetFactsOf("customer-eks", "ap-northeast-2", { cluster: { ...DESCRIBED.cluster, status: "UPDATING" } }, SUBNETS)), /UPDATING/);
  assert.match(reason(awsTargetFactsOf("customer-eks", "ap-northeast-2", { cluster: { status: "ACTIVE" } }, SUBNETS)), /VPC 를 못 읽음/);
});

test("CLI: 관찰 자격 env 로 describe-cluster → 그 클러스터 서브넷만 describe-subnets (지역 = AWS_REGION)", async () => {
  const calls: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const exec: Exec = async (_bin, args, o) => {
    calls.push({ args, env: o.env });
    return { code: 0, stdout: JSON.stringify(args[1] === "describe-cluster" ? DESCRIBED : SUBNETS), stderr: "", ms: 1 };
  };
  const env = { AWS_REGION: "ap-northeast-2", AWS_ACCESS_KEY_ID: "borrowed" };
  const r = await readAwsTargetFacts("customer-eks", { exec, env });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(calls.map((c) => c.args.slice(0, 2)), [["eks", "describe-cluster"], ["ec2", "describe-subnets"]]);
  assert.deepEqual(calls[0]!.args.slice(2, 4), ["--name", "customer-eks"]);
  assert.deepEqual(calls[1]!.args.slice(2, 7), ["--subnet-ids", ...DESCRIBED.cluster.resourcesVpcConfig.subnetIds]);
  assert.ok(calls.every((c) => c.args.join(" ").includes("--region ap-northeast-2") && c.env.AWS_ACCESS_KEY_ID === "borrowed"), "빌린 자격·지역으로");
});

test("CLI 거부: 클러스터 이름 없음·이상한 이름은 부르지 않고 이유, CLI 실패는 계정 번호를 가린 이유", async () => {
  let n = 0;
  const exec: Exec = async () => { n++; return { code: 254, stdout: "", stderr: "An error occurred (AccessDeniedException): arn:aws:iam::111122223333:role/svc-observe is not authorized", ms: 1 }; };
  const a = await readAwsTargetFacts(null, { exec, env: {} });
  const b = await readAwsTargetFacts("--profile=evil", { exec, env: {} });
  assert.equal(n, 0, "이름이 없거나 옵션 모양이면 CLI 를 부르지 않는다");
  assert.ok(!a.ok && /클러스터 이름이 없다/.test(a.reason));
  assert.ok(!b.ok && /모양이 아니다/.test(b.reason));
  const c = await readAwsTargetFacts("customer-eks", { exec, env: {} });
  assert.ok(!c.ok && /AccessDenied/.test(c.reason) && !c.reason.includes("111122223333"), !c.ok ? c.reason : "");
});
