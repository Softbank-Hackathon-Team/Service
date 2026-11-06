// 온프레 이전 중계기 (relay/aws-relay.ts · relay/relay-step.ts): 순수 계획, 가짜 aws 로 만들기·다시 돌기·정리, 단계 문(건너뜀·거부)
//   진짜 AWS 는 부르지 않는다. 가짜 aws 는 이 파일의 작은 EC2 흉내 (태그 필터·규칙·상태만)
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { createServer, connect, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { RELAY_ACTIONS } from "@svc/adapters";
import { FakeAws, fakeDeps } from "./fake-aws-relay.js";
import { actionsOfPolicy, createTempRoleBroker, loadPermissionSet, memoryLedger, mockIssuer, STEP_ROLES, stepActions, TempRoleDenied, type AuditRecord } from "@svc/security";
import { deriveSshHostKey, deriveSshKeypair, knownHostsLine } from "../src/gitops/migration-secrets.js";
import {
  buildRelayPlan, existingDbEgressCover, existingDbIngressCover, ownedBy, RELAY_FORWARDER_PY, pickPublicSubnet, platformEgressCidrs, provisionRelay, RelayError, relayTags, teardownRelay, type GcpRelayPlanInput, type OnpremRelayPlanInput,
} from "../src/relay/aws-relay.js";
import { forwardTarget } from "../src/gitops/replication-delivery.js";
import { addRelayPeer, cloudSqlPeerOf, gcpEndpointRows, gcpRelayGate, prepareGcpRelayStep, provisionRelayStep, rdsIdentifierFromIds, relayEndpointRows, relayGate, relayKindOf, sourcePasswordRef, teardownRelayStep, type RelayFacts } from "../src/relay/relay-step.js";
import { PASSWORD_REF_RE, ReplicationEndpoint } from "@svc/contracts";

const MK = "test-master-key-0123456789abcdef-xyz";   // 시험용 가짜 키
const T = "11111111-1111-4111-8111-111111111111", M = "22222222-2222-4222-8222-222222222222";
const RDS = "shop-db.c1abcdefgh.ap-northeast-2.rds.amazonaws.com";
const PERM_DIR = new URL("../../../infra/permissions/", import.meta.url).pathname;

function planInput(o: Partial<OnpremRelayPlanInput> = {}): OnpremRelayPlanInput {
  return {
    kind: "aws-onprem", migrationId: M,
    rds: { identifier: "shop-db", endpoint: RDS, port: 5432, vpcId: "vpc-0a1", securityGroupIds: ["sg-0rds"], masterUsername: "postgres", dbName: "shop", masterSecretArn: null },
    network: { vpcCidrs: ["10.0.0.0/16"], subnetId: "subnet-0b0b" },
    ami: { imageId: "ami-0abc", rootDeviceName: "/dev/xvda" },
    platformEgressCidrs: ["198.51.100.7/32"], onpremEgressIp: "203.0.113.9",
    tunnelPublicKey: deriveSshKeypair(MK, T, M).publicKeyLine, hostKey: deriveSshHostKey(MK, T, M), ...o,
  };
}

// ── 1. 순수 계획 ───────────────────────────────────────────────────────────────────

test("계획: user-data 에 PermitOpen <rds>:5432·파생 호스트 키 하나만, SG 규칙 그대로, 태그 셋", () => {
  const p = buildRelayPlan(planInput());
  const host = deriveSshHostKey(MK, T, M);
  assert.ok(p.userData.includes(`  PermitOpen ${RDS}:5432\n`));
  assert.ok(p.userData.includes("  PermitListen 0.0.0.0:5432\n"));
  assert.ok(p.userData.includes(host.privateKeyOpenssh.trim()), "파생 호스트 개인 키");
  assert.ok(p.userData.includes(host.publicKeyLine), "파생 호스트 공개 키");
  assert.ok(p.userData.includes(deriveSshKeypair(MK, T, M).publicKeyLine), "터널 authorized_keys");
  // 다른 종류 호스트 키: 지우고, HostKey 는 ed25519 한 줄만
  assert.deepEqual(p.userData.split("\n").filter((l) => /^HostKey /.test(l)), ["HostKey /etc/ssh/ssh_host_ed25519_key"]);
  assert.ok(p.userData.includes("rm -f /etc/ssh/ssh_host_rsa_key /etc/ssh/ssh_host_rsa_key.pub /etc/ssh/ssh_host_ecdsa_key /etc/ssh/ssh_host_ecdsa_key.pub"));
  assert.equal((p.userData.match(/BEGIN OPENSSH PRIVATE KEY/g) ?? []).length, 1);
  assert.ok(!/ec2-user|authorized_keys.*ec2/.test(p.userData), "관리 SSH 키 없음");
  assert.ok(p.userData.includes("  ForceCommand /bin/false") && p.userData.includes("Match all"));
  assert.deepEqual(p.rules.map((r) => [r.direction, r.port, r.cidr]), [
    ["ingress", 22, "203.0.113.9/32"], ["ingress", 5432, "10.0.0.0/16"], ["ingress", 5432, "198.51.100.7/32"],
    ["ingress", 15432, "198.51.100.7/32"], ["egress", 5432, "10.0.0.0/16"]]);
  // 출발 입구 forwarder: 목적지는 RDS:5432 고정, 15432 에서 받는다, root 아닌 일회용 계정
  assert.ok(p.userData.includes(`ExecStart=/usr/bin/python3 /usr/local/bin/svc-relay-fwd.py ${RDS} 5432 15432\n`));
  assert.ok(p.userData.includes("DynamicUser=yes") && p.userData.includes("systemctl enable --now svc-relay-fwd.service"));
  assert.ok(p.userData.indexOf("systemctl restart sshd") < p.userData.indexOf("svc-relay-fwd.py <<"), "터널(sshd)이 먼저 선다");
  assert.equal(p.dbIngress.tags.find((t) => t.Key === "svc:role")!.Value, "relay-db-ingress");
  assert.deepEqual([p.dbIngress.groupId, p.dbIngress.port], ["sg-0rds", 5432]);
  for (const tags of [p.sgTags, p.instance.tags, p.dbEgress.tags]) assert.ok(ownedBy(tags, M));
  assert.equal(p.sgTags.find((t) => t.Key === "svc:role")!.Value, "relay");
  assert.equal(p.dbEgress.tags.find((t) => t.Key === "svc:role")!.Value, "relay-db-egress");
  assert.deepEqual([p.dbEgress.groupId, p.instance.instanceType, p.instance.subnetId], ["sg-0rds", "t4g.nano", "subnet-0b0b"]);
  assert.deepEqual(buildRelayPlan(planInput()), p, "같은 입력 → 같은 계획");
  // known_hosts 줄은 EC2 를 만들기 전에 정해진다 (공개 키 = 파생 값)
  assert.equal(knownHostsLine("203.0.113.50", p.hostPublicKey!), `203.0.113.50 ${host.publicKeyLine.split(" ").slice(0, 2).join(" ")}`);
  assert.notEqual(host.publicKeyLine.split(" ")[1], deriveSshKeypair(MK, T, M).publicKeyLine.split(" ")[1], "호스트 키 ≠ 터널 키");
});

test("계획 거부: 22 를 넓게 열 값·RDS 포트 5432 아님·이상한 엔드포인트·플랫폼 대역 없음", () => {
  assert.throws(() => buildRelayPlan(planInput({ onpremEgressIp: "0.0.0.0/0" })), RelayError);
  assert.throws(() => buildRelayPlan(planInput({ rds: { ...planInput().rds, port: 5433 } })), /5432/);
  assert.throws(() => buildRelayPlan(planInput({ rds: { ...planInput().rds, endpoint: "x'; rm -rf /" } })), RelayError);
  assert.throws(() => buildRelayPlan(planInput({ rds: { ...planInput().rds, securityGroupIds: [] } })), /보안 그룹/);
  assert.throws(() => platformEgressCidrs(undefined), (e: RelayError) => e.code === "RELAY_CONFIG_MISSING");
  assert.throws(() => platformEgressCidrs("10.0.0.0/8"), /좁게/);
  assert.deepEqual(platformEgressCidrs(" 198.51.100.7/32, 198.51.100.0/24 "), ["198.51.100.7/32", "198.51.100.0/24"]);
});

test("공개 서브넷: 명시 연결 경로표 → 없으면 기본 경로표, 0.0.0.0/0 → igw-* 만", () => {
  const subnets = [{ SubnetId: "subnet-b" }, { SubnetId: "subnet-a" }, { SubnetId: "subnet-c" }];
  const rts = [
    { Associations: [{ Main: true }], Routes: [{ DestinationCidrBlock: "0.0.0.0/0", GatewayId: "nat-1" }] },
    { Associations: [{ SubnetId: "subnet-b" }, { SubnetId: "subnet-c" }], Routes: [{ DestinationCidrBlock: "0.0.0.0/0", GatewayId: "igw-1" }] },
  ];
  assert.equal(pickPublicSubnet(subnets, rts), "subnet-b");
  assert.equal(pickPublicSubnet([{ SubnetId: "subnet-a" }], rts), null, "기본 경로표가 NAT 면 공개 아님");
});

test("명세 ids 에서 RDS 이름: ARN · nativeKey, 다른 구성요소는 안 봄", () => {
  assert.equal(rdsIdentifierFromIds({ "arn:aws:rds:ap-northeast-2:123456789012:db:shop-db": "shop-db", "arn:aws:ecs:x": "api" }, "shop-db"), "shop-db");
  assert.equal(rdsIdentifierFromIds({ "rds.dbInstance///shop-db2": "db" }, "db"), "shop-db2");
  assert.equal(rdsIdentifierFromIds({ "arn:aws:rds:ap-northeast-2:123456789012:db:shop-db": "shop-db" }, "other"), null);
});

// ── 2. 가짜 aws ────────────────────────────────────────────────────────────────────

const deps = fakeDeps;
const newFake = () => new FakeAws(RDS, M);

test("실행기: 처음엔 만들고(기본 나가기 규칙 뺌·RDS 나가기 사설 IP/32), 다시 돌면 태그로 찾아 그대로 쓴다", async () => {
  const f = newFake();
  const plan = buildRelayPlan(planInput());
  const r1 = await provisionRelay(deps(f), plan);
  assert.deepEqual([r1.publicIp, r1.privateIp], ["203.0.113.50", "10.0.1.20"]);
  assert.equal(f.ops().filter((o) => o === "ec2 run-instances").length, 1);
  assert.equal(f.userData, plan.userData, "user-data 는 파일로 넘겼다 (argv 에 개인 키 없음)");
  assert.ok(!f.calls.flat().some((a) => a.includes("PRIVATE KEY")), "aws 인자에 개인 키 없음");
  const relayRules = f.rules.filter((r) => r.group === r1.securityGroupId).map((r) => [r.egress ? "egress" : "ingress", r.from, r.cidr]).sort();
  assert.deepEqual(relayRules, [["egress", 5432, "10.0.0.0/16"], ["ingress", 15432, "198.51.100.7/32"], ["ingress", 22, "203.0.113.9/32"],
    ["ingress", 5432, "10.0.0.0/16"], ["ingress", 5432, "198.51.100.7/32"]]);
  // RDS 들어오기: 가짜 RDS 보안 그룹이 VPC 대역 5432 를 이미 받는다 → 규칙을 안 단다
  assert.deepEqual([r1.dbIngressRuleId, r1.dbIngressCoveredBy], ["", "sgr-rds-default"]);
  const dbRule = f.rules.find((r) => r.id === r1.dbEgressRuleId)!;
  assert.deepEqual([dbRule.group, dbRule.egress, dbRule.from, dbRule.cidr], ["sg-0rds", true, 5432, "10.0.1.20/32"]);
  assert.ok(ownedBy(dbRule.tags, M) && ownedBy(f.sgs.get(r1.securityGroupId)!.tags, M));
  assert.deepEqual(r1.reused, []);

  const before = f.calls.length;
  const r2 = await provisionRelay(deps(f), plan);
  assert.deepEqual([r2.instanceId, r2.securityGroupId, r2.dbEgressRuleId], [r1.instanceId, r1.securityGroupId, r1.dbEgressRuleId]);
  assert.deepEqual(r2.created, []);
  const again = f.calls.slice(before).map((a) => `${a[0]} ${a[1]}`);
  assert.ok(!again.some((o) => /create-|run-instances|authorize-|revoke-/.test(o)), again.join(","));

  // 온프레 나가는 IP 가 바뀜 → 새 22 규칙 더하고 옛 것 뺌 (EC2 는 그대로)
  const r3 = await provisionRelay(deps(f), buildRelayPlan(planInput({ onpremEgressIp: "203.0.113.77" })));
  assert.equal(r3.instanceId, r1.instanceId);
  assert.deepEqual(f.rules.filter((r) => r.group === r1.securityGroupId && r.from === 22).map((r) => r.cidr), ["203.0.113.77/32"]);
});

test("정리: 이 이전 두 태그가 있는 것만 지운다 (RDS 규칙 → EC2 종료 기다림 → SG). 남의 것·RDS 원래 규칙은 그대로, 다시 불러도 됨", async () => {
  const f = newFake();
  const r1 = await provisionRelay(deps(f), buildRelayPlan(planInput()));
  f.foreign();
  const t = await teardownRelay(deps(f), M);
  assert.deepEqual(t.removed.sort(), [r1.dbEgressRuleId, r1.instanceId, r1.securityGroupId].sort());
  const order = f.ops().filter((o) => /revoke-security-group-egress|terminate-instances|delete-security-group/.test(o));
  assert.deepEqual(order.slice(-3), ["ec2 revoke-security-group-egress", "ec2 terminate-instances", "ec2 delete-security-group"]);
  assert.ok(f.sgs.has("sg-foreign") && f.sgs.has("sg-0rds") && f.insts.get("i-foreign")!.state === "running");
  assert.ok(f.rules.some((r) => r.id === "sgr-rds-default"), "RDS 원래 규칙은 안 건드림");
  assert.equal(f.insts.get(r1.instanceId)!.state, "terminated");
  assert.deepEqual((await teardownRelay(deps(f), M)).removed, [], "두 번째는 지울 것 없음");
  for (const a of f.calls.filter((c) => c[1] === "terminate-instances")) assert.ok(!a.includes("i-foreign"));
});

// 출발 RDS 보안 그룹 나가기: 이미 열려 있으면 고객 보안 그룹을 안 고친다 (연결 스택 SourceDbSecurityGroupId 를 비운 고객은 그 권한이 없다)
test("RDS 나가기 판정: 전부 허용·VPC 대역 5432·중계 SG 참조는 이미 열림, 다른 포트·접두 목록·플랫폼이 단 규칙은 아님", () => {
  const row = (o: Record<string, unknown>) => ({ SecurityGroupRuleId: "sgr-x", IsEgress: true, ...o });
  const ip = "10.0.1.20";
  assert.equal(existingDbEgressCover([row({ IpProtocol: "-1", FromPort: -1, ToPort: -1, CidrIpv4: "0.0.0.0/0" })], ip, 5432, "sg-relay"), "sgr-x");
  assert.equal(existingDbEgressCover([row({ IpProtocol: "tcp", FromPort: 5432, ToPort: 5432, CidrIpv4: "10.0.0.0/16" })], ip, 5432, "sg-relay"), "sgr-x");
  assert.equal(existingDbEgressCover([row({ IpProtocol: "tcp", FromPort: 0, ToPort: 65535, ReferencedGroupInfo: { GroupId: "sg-relay" } })], ip, 5432, "sg-relay"), "sgr-x");
  assert.equal(existingDbEgressCover([row({ IpProtocol: "tcp", FromPort: 443, ToPort: 443, CidrIpv4: "0.0.0.0/0" })], ip, 5432, "sg-relay"), undefined);
  assert.equal(existingDbEgressCover([row({ IpProtocol: "tcp", FromPort: 5432, ToPort: 5432, CidrIpv4: "10.9.0.0/16" })], ip, 5432, "sg-relay"), undefined);
  assert.equal(existingDbEgressCover([row({ IpProtocol: "-1", PrefixListId: "pl-123" })], ip, 5432, "sg-relay"), undefined);
  assert.equal(existingDbEgressCover([row({ IsEgress: false, IpProtocol: "-1", CidrIpv4: "0.0.0.0/0" })], ip, 5432, "sg-relay"), undefined);
  assert.equal(existingDbEgressCover([row({ IpProtocol: "tcp", FromPort: 5432, ToPort: 5432, CidrIpv4: "10.0.1.99/32",
    Tags: relayTags("33333333-3333-4333-8333-333333333333", "relay-db-egress") })], "10.0.1.99", 5432, "sg-relay"), undefined, "다른 이전이 단 규칙은 그 이전이 끝나면 빠진다");
});

test("실행기: RDS 보안 그룹에 기본 나가기(전부 허용)가 있으면 규칙을 안 달고(권한 없어도 됨), 정리도 RDS 쪽은 안 건드린다", async () => {
  const f = newFake();
  f.rules.push({ id: "sgr-rds-egress-all", group: "sg-0rds", egress: true, proto: "-1", from: -1, to: -1, cidr: "0.0.0.0/0", tags: [] });
  f.denyEgressGroup = "sg-0rds";   // 열려고 하면 실패한다: 안 열어야 통과
  const r1 = await provisionRelay(deps(f), buildRelayPlan(planInput()));
  assert.equal(r1.dbEgressRuleId, "");
  assert.equal(r1.dbEgressCoveredBy, "sgr-rds-egress-all");
  assert.ok(!f.calls.some((a) => a[1] === "authorize-security-group-egress" && a.includes("sg-0rds")), "RDS 보안 그룹을 안 고쳤다");
  const t = await teardownRelay(deps(f), M);
  assert.deepEqual(t.removed.sort(), [r1.instanceId, r1.securityGroupId].sort());
  assert.ok(f.rules.some((r) => r.id === "sgr-rds-egress-all"), "고객 규칙 그대로");
});

test("실행기: RDS 나가기가 막혀 있고 열 권한도 없으면 RELAY_DB_EGRESS_DENIED (보안 그룹 번호·스택 입력값 안내)", async () => {
  const f = newFake();
  f.denyEgressGroup = "sg-0rds";
  await assert.rejects(provisionRelay(deps(f), buildRelayPlan(planInput())), (e: unknown) => {
    assert.ok(e instanceof RelayError);
    assert.equal(e.code, "RELAY_DB_EGRESS_DENIED");
    assert.equal(e.awsCode, "UnauthorizedOperation");
    assert.match(e.message, /sg-0rds/);
    assert.match(e.message, /SourceDbSecurityGroupId/);
    return true;
  });
});

// 2026-11-06 실측: 실제 RDS 보안 그룹은 클러스터 보안 그룹만 받았다 → 중계기 → RDS:5432 TIMEOUT. 그때 이 규칙을 단다
test("RDS 들어오기 판정: 전부 허용·VPC 대역·중계 SG 참조는 이미 열림, 클러스터 SG 참조·다른 포트·나가기·플랫폼이 단 규칙은 아님", () => {
  const row = (o: Record<string, unknown>) => ({ SecurityGroupRuleId: "sgr-in", IsEgress: false, ...o });
  const ip = "10.0.1.20";
  assert.equal(existingDbIngressCover([row({ IpProtocol: "-1", CidrIpv4: "0.0.0.0/0" })], ip, 5432, "sg-relay"), "sgr-in");
  assert.equal(existingDbIngressCover([row({ IpProtocol: "tcp", FromPort: 5432, ToPort: 5432, CidrIpv4: "10.0.0.0/16" })], ip, 5432, "sg-relay"), "sgr-in");
  assert.equal(existingDbIngressCover([row({ IpProtocol: "tcp", FromPort: 5432, ToPort: 5432, ReferencedGroupInfo: { GroupId: "sg-relay" } })], ip, 5432, "sg-relay"), "sgr-in");
  assert.equal(existingDbIngressCover([row({ IpProtocol: "tcp", FromPort: 5432, ToPort: 5432, ReferencedGroupInfo: { GroupId: "sg-eks-cluster" } })], ip, 5432, "sg-relay"), undefined);
  assert.equal(existingDbIngressCover([row({ IpProtocol: "tcp", FromPort: 3306, ToPort: 3306, CidrIpv4: "10.0.0.0/16" })], ip, 5432, "sg-relay"), undefined);
  assert.equal(existingDbIngressCover([row({ IsEgress: true, IpProtocol: "-1", CidrIpv4: "0.0.0.0/0" })], ip, 5432, "sg-relay"), undefined);
  assert.equal(existingDbIngressCover([row({ IpProtocol: "tcp", FromPort: 5432, ToPort: 5432, ReferencedGroupInfo: { GroupId: "sg-relay" },
    Tags: relayTags("33333333-3333-4333-8333-333333333333", "relay-db-ingress") })], ip, 5432, "sg-relay"), undefined, "다른 이전이 단 규칙");
});

test("실행기: RDS 가 클러스터 SG 만 받으면 들어오기 규칙(중계 SG 참조)을 달고, 다시 돌면 그대로, 정리는 그 규칙부터 뺀다", async () => {
  const f = newFake();
  f.rules = f.rules.filter((r) => r.id !== "sgr-rds-default");
  f.rules.push({ id: "sgr-rds-from-eks", group: "sg-0rds", egress: false, proto: "tcp", from: 5432, to: 5432, cidr: "sg:sg-eks-cluster", tags: [] });
  const r1 = await provisionRelay(deps(f), buildRelayPlan(planInput()));
  const inRule = f.rules.find((r) => r.id === r1.dbIngressRuleId)!;
  assert.ok(inRule, "들어오기 규칙을 달았다");
  assert.deepEqual([inRule.group, inRule.egress, inRule.from, inRule.to, inRule.cidr], ["sg-0rds", false, 5432, 5432, `sg:${r1.securityGroupId}`]);
  assert.equal(inRule.tags.find((t) => t.Key === "svc:role")!.Value, "relay-db-ingress");
  assert.ok(ownedBy(inRule.tags, M));
  const before = f.calls.length;
  const r2 = await provisionRelay(deps(f), buildRelayPlan(planInput()));
  assert.equal(r2.dbIngressRuleId, r1.dbIngressRuleId);
  assert.ok(!f.calls.slice(before).some((a) => /authorize-|revoke-/.test(a[1]!)), "다시 돌면 아무것도 안 고친다");
  const t = await teardownRelay(deps(f), M);
  assert.ok(t.removed.includes(r1.dbIngressRuleId));
  const order = f.ops().slice(before).filter((o) => /revoke-security-group-(ingress|egress)|terminate-instances|delete-security-group/.test(o));
  assert.deepEqual(order, ["ec2 revoke-security-group-ingress", "ec2 revoke-security-group-egress", "ec2 terminate-instances", "ec2 delete-security-group"],
    "참조 규칙을 먼저 빼야 중계 SG 를 지울 수 있다");
  assert.ok(f.rules.some((r) => r.id === "sgr-rds-from-eks"), "고객 규칙 그대로");
});

test("실행기: RDS 들어오기가 막혀 있고 열 권한도 없으면 RELAY_DB_INGRESS_DENIED (옛 연결 템플릿, 스택 업데이트 안내)", async () => {
  const f = newFake();
  f.rules = f.rules.filter((r) => r.id !== "sgr-rds-default");
  f.denyIngressGroup = "sg-0rds";
  await assert.rejects(provisionRelay(deps(f), buildRelayPlan(planInput())), (e: unknown) => {
    assert.ok(e instanceof RelayError);
    assert.equal(e.code, "RELAY_DB_INGRESS_DENIED");
    assert.match(e.message, /sg-0rds/);
    assert.match(e.message, /SourceDbSecurityGroupId/);
    return true;
  });
});

test("터널 목적지: 출발 줄이 중계기 출발 입구(host=공개 IP:15432)면 진짜 RDS 이름(tls_servername):5432, 아니면 예전처럼", () => {
  const base = { tenantId: T, migrationId: M, sourceEnvId: "783df2ef-8dbf-4a20-904d-bb02aeb96332", rds: planInput().rds, db: "shop", appUser: "shop_app", publicIp: "203.0.113.50", privateIp: "10.0.1.20", knownHosts: "203.0.113.50 ssh-ed25519 AAAA" };
  const [s] = relayEndpointRows({ ...base, existing: [] });
  assert.equal(forwardTarget(s), `${RDS}:5432`);
  assert.equal(forwardTarget({ ...s, host: RDS, port: 5432, tlsServername: null }), `${RDS}:5432`);
  assert.throws(() => forwardTarget({ ...s, host: "203.0.113.50", port: 15432, tlsServername: null }), /5432/);
});

// forwarder 를 진짜로 돌린다 (python3 표준 라이브러리만 = 중계기 AL2023 과 같은 조건). 가짜 상류 서버로 바이트가 그대로 오가는지
test("출발 입구 forwarder: 받은 바이트를 상류로 그대로, 응답도 그대로 (여러 연결 동시에)", { skip: spawnSync("python3", ["-c", "import asyncio"]).status !== 0 ? "python3 없음" : false }, async () => {
  const up = createServer((s) => s.on("data", (b) => s.write(Buffer.concat([Buffer.from("ack:"), b]))));
  await new Promise<void>((r) => up.listen(0, "127.0.0.1", r));
  const upPort = (up.address() as AddressInfo).port;
  const dir = mkdtempSync(join(tmpdir(), "relay-fwd-"));
  const free = createServer(); await new Promise<void>((r) => free.listen(0, "127.0.0.1", r));
  const listenPort = (free.address() as AddressInfo).port; await new Promise<void>((r) => free.close(() => r()));
  writeFileSync(join(dir, "fwd.py"), RELAY_FORWARDER_PY);
  const py = spawn("python3", [join(dir, "fwd.py"), "127.0.0.1", String(upPort), String(listenPort)], { stdio: "ignore" });
  try {
    const once = (msg: string) => new Promise<string>((resolve, reject) => {
      const c = connect(listenPort, "127.0.0.1", () => c.write(msg));
      c.on("data", (b) => { resolve(b.toString()); c.end(); });
      c.on("error", reject);
    });
    let ok = false;
    for (let i = 0; i < 50 && !ok; i++) { try { await once("ping"); ok = true; } catch { await new Promise((r) => setTimeout(r, 100)); } }
    assert.ok(ok, "forwarder 가 떴다");
    assert.deepEqual(await Promise.all(["a", "bb", "ccc"].map(once)), ["ack:a", "ack:bb", "ack:ccc"]);
  } finally {
    py.kill(); up.close(); rmSync(dir, { recursive: true, force: true });
  }
});

test("실행기 거부: 권한 없음 → RELAY_PROVISION_FAILED + awsCode, 만든 것은 태그를 단 채 남는다", async () => {
  const f = newFake();
  f.failOn = "ec2 run-instances";
  await assert.rejects(provisionRelay(deps(f), buildRelayPlan(planInput())),
    (e: RelayError) => e.code === "RELAY_PROVISION_FAILED" && e.awsCode === "UnauthorizedOperation");
  const sg = [...f.sgs].find(([, g]) => ownedBy(g.tags, M));
  assert.ok(sg, "보안 그룹은 태그와 함께 남음 → 다시 돌면 찾는다");
});

// ── 3. 단계 문 ───────────────────────────────────────────────────────────────────

const facts = (o: Partial<RelayFacts> = {}): RelayFacts => ({
  sourceProvider: "aws", sourceRegion: "ap-northeast-2", sourceExternalId: "ext-123", targetProvider: "onprem",
  postgres: [{ id: "shop-db", db: "shop", user: "shop_app" }], rdsIdentifier: "shop-db", onpremEgressIp: "203.0.113.9", existing: [], ...o });
const GOOD = { REPL_SECRET_MASTER_KEY: MK, PLATFORM_EGRESS_CIDRS: "198.51.100.7/32" } as NodeJS.ProcessEnv;

test("단계 문: 시드 환경·출발 AWS 아님·명세 postgres 없음·push 모드는 건너뜀 (아무것도 안 부름)", async () => {
  assert.deepEqual(relayGate(facts({ sourceExternalId: null }), GOOD), { kind: "skip", reason: "source_creds_mock" });
  assert.deepEqual(relayGate(facts(), { ...GOOD, REAL_STS: "0" }), { kind: "skip", reason: "source_creds_mock" });
  assert.deepEqual(relayGate(facts({ sourceProvider: "gcp" }), GOOD), { kind: "skip", reason: "no_relay_route" });
  assert.deepEqual(relayGate(facts({ postgres: [] }), GOOD), { kind: "skip", reason: "no_postgres" });
  assert.deepEqual(relayGate(facts(), { ...GOOD, ONPREM_FLOOR_VIA_GIT: "0" }), { kind: "skip", reason: "not_pull_mode" });
  assert.deepEqual(relayGate(facts(), { ...GOOD, RELAY_AUTO: "0" }), { kind: "skip", reason: "relay_auto_off" });
  let borrowed = 0;
  const out = await provisionRelayStep({ tenantId: T, migrationId: M }, { id: M, status: "provisioning", sourceEnvId: randomUUID(), targetEnvId: randomUUID() },
    { env: GOOD, facts: facts({ sourceExternalId: null }), borrow: async () => { borrowed++; throw new Error("no"); } });
  assert.deepEqual(out, { kind: "skipped", reason: "source_creds_mock" });
  assert.equal(borrowed, 0, "역할도 안 빌림");
  assert.deepEqual(await teardownRelayStep({ tenantId: T, migrationId: M }, { id: M, sourceEnvId: "x", targetEnvId: "y" },
    { env: GOOD, facts: facts({ sourceProvider: "gcp" }) }), { kind: "skipped", reason: "no_relay_route" });
});

test("중계기 종류 표: (출발, 도착) 짝만 본다. 표에 없는 짝은 중계기 없음", () => {
  assert.equal(relayKindOf("aws", "onprem"), "aws-onprem");
  assert.equal(relayKindOf("aws", "gcp"), "aws-gcp");
  for (const [s, t] of [["gcp", "onprem"], ["aws", "aws"], ["onprem", "gcp"], [null, "gcp"], ["aws", null]] as const) assert.equal(relayKindOf(s, t), null, `${s}->${t}`);
});

// ── GCP 도착 (aws-gcp) ──────────────────────────────────────────────────────────────

const SQL = { publicIp: "34.64.10.20", outgoingIp: "34.64.10.99" };
const gcpInput = (o: Partial<GcpRelayPlanInput> = {}): GcpRelayPlanInput => {
  const { kind: _k, onpremEgressIp: _e, tunnelPublicKey: _t, hostKey: _h, ...base } = planInput();
  return { ...base, kind: "aws-gcp", cloudSql: SQL, ...o };
};

test("GCP 계획: 22·SSH 없음, 15432 = 플랫폼 대역 + Cloud SQL 나가는 IP/32, 5432 = VPC 만, 나가기 = VPC + Cloud SQL 공개 IP/32", () => {
  const p = buildRelayPlan(gcpInput());
  assert.equal(p.kind, "aws-gcp");
  assert.deepEqual(p.rules.map((r) => [r.direction, r.port, r.cidr]), [
    ["ingress", 5432, "10.0.0.0/16"], ["ingress", 15432, "198.51.100.7/32"], ["ingress", 15432, "34.64.10.99/32"],
    ["egress", 5432, "10.0.0.0/16"], ["egress", 5432, "34.64.10.20/32"]]);
  assert.ok(!p.rules.some((r) => r.port === 22), "SSH 없음");
  assert.ok(!p.userData.includes("sshd") && !p.userData.includes("PRIVATE KEY") && !p.userData.includes("tunnel"), "SSH 설정·키 없음");
  assert.ok(p.userData.includes(`ExecStart=/usr/bin/python3 /usr/local/bin/svc-relay-fwd.py ${RDS} 5432 15432\n`), "출발 입구 → RDS");
  assert.ok(p.userData.includes("ExecStart=/usr/bin/python3 /usr/local/bin/svc-relay-fwd.py 34.64.10.20 5432 5432\n"), "역방향 입구 → Cloud SQL 공개 IP");
  assert.ok(p.userData.includes("systemctl enable --now svc-relay-rev.service") && p.userData.includes("systemctl enable --now svc-relay-fwd.service"));
  assert.equal(p.instance.tags.find((t) => t.Key === "svc:reverse-target")?.Value, "34.64.10.20");
  assert.deepEqual([p.hostPublicKey, p.reverseTarget], [null, "34.64.10.20"]);
  assert.deepEqual(buildRelayPlan(gcpInput()), p, "같은 입력 → 같은 계획");
  // 나가는 IP 가 플랫폼 대역과 같으면 15432 규칙을 겹쳐 달지 않는다
  assert.equal(buildRelayPlan(gcpInput({ platformEgressCidrs: ["34.64.10.99/32"] })).rules.filter((r) => r.port === 15432).length, 1);
  assert.throws(() => buildRelayPlan(gcpInput({ cloudSql: { publicIp: "", outgoingIp: "34.64.10.99" } })), (e: RelayError) => e.code === "RELAY_TARGET_DB_UNKNOWN");
});

test("GCP 실행기: 만들기 → 다시 돌면 그대로, Cloud SQL 공개 IP 가 바뀌면 옛 EC2 를 지우고 새 목적지로 만든다, 정리는 태그로 전부", async () => {
  const f = newFake();
  const r1 = await provisionRelay(deps(f), buildRelayPlan(gcpInput()));
  assert.ok(f.userData.includes("svc-relay-fwd.py 34.64.10.20 5432 5432"));
  const sgRules = () => f.rules.filter((x) => x.group === r1.securityGroupId).map((x) => `${x.egress ? "out" : "in"}:${x.from}:${x.cidr}`).sort();
  assert.deepEqual(sgRules(), ["in:15432:198.51.100.7/32", "in:15432:34.64.10.99/32", "in:5432:10.0.0.0/16", "out:5432:10.0.0.0/16", "out:5432:34.64.10.20/32"]);
  const r2 = await provisionRelay(deps(f), buildRelayPlan(gcpInput()));
  assert.equal(r2.instanceId, r1.instanceId); assert.deepEqual(r2.created, []);
  const r3 = await provisionRelay(deps(f), buildRelayPlan(gcpInput({ cloudSql: { publicIp: "34.64.10.21", outgoingIp: "34.64.10.98" } })));
  assert.notEqual(r3.instanceId, r1.instanceId);
  assert.equal(f.insts.get(r1.instanceId)!.state, "terminated");
  assert.ok(f.userData.includes("svc-relay-fwd.py 34.64.10.21 5432 5432"));
  assert.deepEqual(sgRules(), ["in:15432:198.51.100.7/32", "in:15432:34.64.10.98/32", "in:5432:10.0.0.0/16", "out:5432:10.0.0.0/16", "out:5432:34.64.10.21/32"], "옛 Cloud SQL 규칙은 빠진다");
  await teardownRelay(deps(f), M);
  assert.equal([...f.sgs.keys()].filter((id) => ownedBy(f.sgs.get(id)!.tags, M)).length, 0);
  assert.equal(f.rules.filter((x) => ownedBy(x.tags, M)).length, 0, "RDS·중계 규칙 남지 않음");
});

test("GCP 단계 문: 표의 aws->gcp 만 go, 시드·명세 postgres 없음·플랫폼 대역 없음은 건너뜀·거부 (SSH·온프레 IP·마스터 키는 안 봄)", () => {
  const gf = (o: Partial<RelayFacts> = {}) => facts({ targetProvider: "gcp", onpremEgressIp: null, ...o });
  const env = { PLATFORM_EGRESS_CIDRS: "198.51.100.7/32" } as NodeJS.ProcessEnv;
  assert.deepEqual(gcpRelayGate(gf(), env), { kind: "go", identifier: "shop-db", platformCidrs: ["198.51.100.7/32"], region: "ap-northeast-2", db: "shop", user: "shop_app" });
  assert.deepEqual(gcpRelayGate(facts(), env), { kind: "skip", reason: "not_gcp_relay" });
  assert.deepEqual(relayGate(gf(), GOOD), { kind: "skip", reason: "not_onprem_relay" });
  assert.deepEqual(gcpRelayGate(gf({ sourceExternalId: null }), env), { kind: "skip", reason: "source_creds_mock" });
  assert.deepEqual(gcpRelayGate(gf({ postgres: [] }), env), { kind: "skip", reason: "no_postgres" });
  assert.equal((gcpRelayGate(gf(), {}) as { failureCode?: string }).failureCode, "RELAY_CONFIG_MISSING");
  assert.equal((gcpRelayGate(gf({ rdsIdentifier: null }), env) as { failureCode?: string }).failureCode, "RELAY_SOURCE_DB_UNKNOWN");
});

test("GCP 순서: terraform 앞에 플랫폼 대역을 작업 폴더에, 중계 IP 는 처음 한 번만 '다시 terraform', 재시도는 앞 실행 IP 를 그대로 품는다", async () => {
  const root = mkdtempSync(join(tmpdir(), "gcp-order-"));
  const env = { TF_WORK_DIR: root, PLATFORM_EGRESS_CIDRS: "198.51.100.7/32" } as NodeJS.ProcessEnv;
  const m = { id: M, status: "provisioning" as const, sourceEnvId: randomUUID(), targetEnvId: randomUUID() };
  const gf = facts({ targetProvider: "gcp", onpremEgressIp: null });
  const file = join(root, "t-11111111", M, "repl-network.json");
  assert.equal((await prepareGcpRelayStep({ tenantId: T, migrationId: M }, m, { env, facts: gf })).kind, "go");
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { peerCidrs: ["198.51.100.7/32"], appLoginSql: true });
  assert.equal(addRelayPeer({ tenantId: T, migrationId: M }, "203.0.113.50", env), true, "새 중계 IP → terraform 한 번 더");
  assert.equal(addRelayPeer({ tenantId: T, migrationId: M }, "203.0.113.50", env), false, "같은 IP → 더 안 돎");
  await prepareGcpRelayStep({ tenantId: T, migrationId: M }, m, { env, facts: gf });
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).peerCidrs, ["198.51.100.7/32", "203.0.113.50/32"], "재시도 첫 terraform 도 중계 IP 를 뺐다 넣지 않는다");
  assert.equal((await prepareGcpRelayStep({ tenantId: T, migrationId: M }, m, { env, facts: facts() })).kind, "skip", "온프레 도착은 파일을 안 만진다");
  rmSync(root, { recursive: true, force: true });
});

test("GCP 끝점 줄: 출발 = 중계 출발 입구(aws-sm), 도착 = Cloud SQL 공개 IP·관리자(tf:)·verify-ca, 역방향 peer = 중계 사설 IP:5432", () => {
  const PEM = "-----BEGIN CERTIFICATE-----\nMIIBx\n-----END CERTIFICATE-----";
  const out = { db_admin_username: "svc_admin_0123456789", db_username: "shop_app", db_name: "shop", db_server_ca_cert: PEM };
  const [s, t] = gcpEndpointRows({ tenantId: T, migrationId: M, sourceEnvId: "783df2ef-8dbf-4a20-904d-bb02aeb96332",
    rds: { ...planInput().rds, masterSecretArn: "arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:rds!db-x" }, db: "shop", appUser: "shop_app",
    publicIp: "203.0.113.50", privateIp: "10.0.1.20", cloudSql: SQL, out, existing: [] });
  for (const r of [s, t]) assert.ok(ReplicationEndpoint.safeParse(r).success, JSON.stringify(ReplicationEndpoint.safeParse(r).error?.issues));
  assert.deepEqual([s.host, s.port, s.peerHost, s.passwordRef, s.sslmode, s.tlsServername], ["203.0.113.50", 15432, null, "aws-sm:arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:rds!db-x", "require", RDS]);
  assert.deepEqual([t.provider, t.host, t.port, t.username, t.passwordRef, t.peerHost, t.peerPort, t.appRole, t.sslmode, t.caPem, t.relayHost],
    ["cloudsql", "34.64.10.20", 5432, "svc_admin_0123456789", "tf:db_admin_password", "10.0.1.20", 5432, "shop_app", "verify-ca", PEM, null]);
  assert.notEqual(t.username, t.appRole, "관리자 ≠ 앱 계정");
  assert.equal(gcpEndpointRows({ tenantId: T, migrationId: M, sourceEnvId: "s", rds: planInput().rds, db: "shop", appUser: "shop_app",
    publicIp: "203.0.113.50", privateIp: "10.0.1.20", cloudSql: SQL, out: { ...out, db_server_ca_cert: "" }, existing: [] })[1].sslmode, "require");
  assert.throws(() => gcpEndpointRows({ tenantId: T, migrationId: M, sourceEnvId: "s", rds: planInput().rds, db: "shop", appUser: "shop_app",
    publicIp: "203.0.113.50", privateIp: "10.0.1.20", cloudSql: SQL, out: {}, existing: [] }), (e: RelayError) => e.code === "RELAY_TARGET_DB_UNKNOWN");
  assert.deepEqual(cloudSqlPeerOf({ db_public_ip: "34.64.10.20", db_outgoing_ip: "34.64.10.99" }), SQL);
  assert.equal(cloudSqlPeerOf({ db_public_ip: "", db_outgoing_ip: "" }), null);
});

test("단계 거부: 온프레 나가는 IP 모름 → ONPREM_EGRESS_UNKNOWN (22 를 세상에 안 엶), 플랫폼 대역 없음 → RELAY_CONFIG_MISSING", async () => {
  const g = relayGate(facts({ onpremEgressIp: null }), GOOD);
  assert.equal(g.kind, "fail");
  if (g.kind === "fail") { assert.equal(g.failureCode, "ONPREM_EGRESS_UNKNOWN"); assert.match(g.reason, /egressIp/); assert.match(g.reason, /EGRESS_IP_URL/); }
  const f = newFake();
  const out = await provisionRelayStep({ tenantId: T, migrationId: M }, { id: M, status: "provisioning", sourceEnvId: "s", targetEnvId: "t" },
    { env: GOOD, facts: facts({ onpremEgressIp: null }), aws: { exec: f.exec } });
  assert.equal(out.kind === "failed" && out.failureCode, "ONPREM_EGRESS_UNKNOWN");
  assert.equal(f.calls.length, 0, "aws 를 안 불렀다");
  const g2 = relayGate(facts(), { REPL_SECRET_MASTER_KEY: MK });
  assert.equal(g2.kind === "fail" && g2.failureCode, "RELAY_CONFIG_MISSING");
  const g3 = relayGate(facts({ rdsIdentifier: null }), GOOD);
  assert.equal(g3.kind === "fail" && g3.failureCode, "RELAY_SOURCE_DB_UNKNOWN");
});

test("단계 정상: 빌린 출발 자격으로 만들고 끝점 두 줄 (도착 = 중계 공개 IP·사설 peer·고정 호스트 키, 출발 = RDS·env: 참조)", async () => {
  const f = newFake();
  let saved: unknown[] = [];
  const out = await provisionRelayStep({ tenantId: T, migrationId: M }, { id: M, status: "provisioning", sourceEnvId: "s", targetEnvId: "t" }, {
    env: GOOD, facts: facts(), aws: { exec: f.exec, sleep: async () => {}, pollMs: 0 },
    borrow: async (fn) => fn({ awsEnv: { source: { AWS_CONFIG_FILE: "/dev/null" } }, denied: [] }),
    save: async (rows) => { saved = rows; } });
  assert.equal(out.kind, "ok", JSON.stringify(out));
  const [s, t] = saved as ReturnType<typeof relayEndpointRows>;
  // 출발 = 중계기 출발 입구 (공개 IP:15432), 진짜 RDS 이름은 tls_servername
  assert.deepEqual([s.side, s.provider, s.host, s.port, s.tlsServername, s.dbname, s.username, s.passwordRef, s.appRole],
    ["source", "rds", "203.0.113.50", 15432, RDS, "shop", "postgres", "aws-sm:arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:rds!db-x", "shop_app"]);
  assert.deepEqual([t.side, t.provider, t.host, t.peerHost, t.peerPort, t.username, t.passwordRef, t.relayHost, t.relayPort],
    ["target", "cnpg", "203.0.113.50", "10.0.1.20", 5432, "svc_migrate", "derive:migrate", "203.0.113.50", 22]);
  assert.equal(t.relayKnownHosts, knownHostsLine("203.0.113.50", deriveSshHostKey(MK, T, M).publicKeyLine));
  assert.ok(!JSON.stringify(out).includes("PRIVATE"), "감사 detail 에 키 없음");

  // 거부된 역할 → RELAY_ROLE_DENIED (aws 안 부름)
  const f2 = newFake();
  const denied = await provisionRelayStep({ tenantId: T, migrationId: M }, { id: M, status: "provisioning", sourceEnvId: "s", targetEnvId: "t" }, {
    env: GOOD, facts: facts(), aws: { exec: f2.exec }, borrow: async (fn) => fn({ denied: [{ side: "source", purpose: "operate", code: "ROLE_NO_CEILING" }] }) });
  assert.equal(denied.kind === "failed" && denied.failureCode, "RELAY_ROLE_DENIED");
  assert.equal(f2.calls.length, 0);
});

test("출발 비밀번호 참조: 이전이 아니라 출발 환경 기준 이름 (같은 출발 RDS 로 이전을 다시 만들어도 같은 키), 운영자가 바꾼 참조는 그대로", () => {
  const base = { tenantId: T, rds: planInput().rds, db: "shop", appUser: "shop_app", publicIp: "203.0.113.50", privateIp: "10.0.1.20", knownHosts: "203.0.113.50 ssh-ed25519 AAAA", existing: [] };
  const [a] = relayEndpointRows({ ...base, migrationId: M, sourceEnvId: "783df2ef-8dbf-4a20-904d-bb02aeb96332" });
  const [b] = relayEndpointRows({ ...base, migrationId: randomUUID(), sourceEnvId: "783df2ef-8dbf-4a20-904d-bb02aeb96332" });
  assert.equal(a.passwordRef, "env:REPL_SECRET_SRC_783DF2EF");
  assert.equal(b.passwordRef, a.passwordRef);
  const [c] = relayEndpointRows({ ...base, migrationId: M, sourceEnvId: "783df2ef-8dbf-4a20-904d-bb02aeb96332", existing: [{ ...a, passwordRef: "env:REPL_SECRET_OPS" }] });
  assert.equal(c.passwordRef, "env:REPL_SECRET_OPS");
});

test("출발 비밀번호 참조: RDS 관리 비밀이 있으면 aws-sm:<ARN> (사람이 비밀번호를 안 넣음), 없거나 모양이 틀리면 예전 env:", () => {
  const ARN = "arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:rds!db-0a1b2c3d-4e5f-AbCdEf";
  assert.equal(sourcePasswordRef(ARN, "783df2ef-8dbf", "22222222"), `aws-sm:${ARN}`);
  assert.equal(sourcePasswordRef(null, "783df2ef-8dbf", "22222222"), "env:REPL_SECRET_SRC_783DF2EF");
  // 거부: RDS 관리 비밀이 아닌 ARN(고객의 다른 비밀)·Aurora 클러스터 비밀은 aws-sm 으로 안 받는다
  for (const bad of ["arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:prod/app-AbCdEf",
    "arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:rds!cluster-x", "arn:aws:secretsmanager:ap-northeast-2:123:secret:rds!db-x"])
    assert.equal(sourcePasswordRef(bad, "783df2ef-8dbf", "22222222"), "env:REPL_SECRET_SRC_783DF2EF", bad);
  const base = { tenantId: T, migrationId: M, sourceEnvId: "783df2ef-8dbf-4a20-904d-bb02aeb96332", db: "shop", appUser: "shop_app",
    publicIp: "203.0.113.50", privateIp: "10.0.1.20", knownHosts: "203.0.113.50 ssh-ed25519 AAAA", existing: [] };
  const [s] = relayEndpointRows({ ...base, rds: { ...planInput().rds, masterSecretArn: ARN } });
  assert.equal(s.passwordRef, `aws-sm:${ARN}`);
  assert.ok(PASSWORD_REF_RE.test(s.passwordRef));
});

test("끝점 줄 다시 쓰기: 같은 중계기면 배달이 채운 칸(CA·verify-full·출발 peer)을 그대로 둔다, 중계기가 바뀌면 CA 를 비운다", () => {
  const base = { tenantId: T, migrationId: M, sourceEnvId: "783df2ef-8dbf-4a20-904d-bb02aeb96332", rds: planInput().rds, db: "shop", appUser: "shop_app", publicIp: "203.0.113.50", privateIp: "10.0.1.20", knownHosts: "203.0.113.50 ssh-ed25519 AAAA" };
  const [s0, t0] = relayEndpointRows({ ...base, existing: [] });
  const delivered = [{ ...s0, peerHost: "db-tunnel.app.svc", peerPort: 5432, passwordRef: "env:REPL_SECRET_OPS" },
    { ...t0, caPem: "-----BEGIN CERTIFICATE-----\nx", tlsServername: "x-rw.app.svc", sslmode: "verify-full" as const }];
  const [s1, t1] = relayEndpointRows({ ...base, existing: delivered });
  assert.deepEqual([s1.peerHost, s1.passwordRef, t1.sslmode, t1.tlsServername], ["db-tunnel.app.svc", "env:REPL_SECRET_OPS", "verify-full", "x-rw.app.svc"]);
  const [, t2] = relayEndpointRows({ ...base, publicIp: "203.0.113.99", existing: delivered });
  assert.deepEqual([t2.caPem, t2.sslmode, t2.relayHost], [null, "require", "203.0.113.99"]);
});

// ── 4. 권한 ───────────────────────────────────────────────────────────────────────

test("권한: 중계기 문 묶음의 동작 = 워커가 부르는 동작(RELAY_ACTIONS), 키 쌍 동작 없음, 지우기·바꾸기는 태그 조건", () => {
  const doc = JSON.parse(readFileSync(`${PERM_DIR}aws-relay-statements.json`, "utf8"));
  assert.deepEqual(actionsOfPolicy(doc), [...RELAY_ACTIONS]);
  assert.ok(!JSON.stringify(doc).includes("KeyPair"));
  for (const s of doc.Statement as { Action: string[]; Condition?: Record<string, Record<string, string>>; Resource: string | string[] }[]) {
    if (s.Action.some((a) => /Terminate|DeleteSecurityGroup/.test(a)))
      assert.equal(s.Condition?.StringEquals?.["aws:ResourceTag/managed-by"], "platform");
    if (s.Action.includes("ec2:RunInstances") && JSON.stringify(s.Resource).includes("instance/"))
      assert.equal(s.Condition?.StringEquals?.["aws:RequestTag/managed-by"], "platform");
  }
});

test("중계기 역할: 세션 정책 = 중계기 동작만 (단계 정책 아님), 파일이 없으면·GCP 면 거부", async () => {
  const perms = loadPermissionSet(PERM_DIR);
  const log: AuditRecord[] = [];
  const sent: (string | undefined)[] = [];
  const aws = { ...mockIssuer("aws"), issue: async (ctx: Parameters<ReturnType<typeof mockIssuer>["issue"]>[0]) => { sent.push(ctx.sessionPolicy); return mockIssuer("aws").issue(ctx); } };
  const mk = (p = perms) => createTempRoleBroker({ issuers: { aws, gcp: mockIssuer("gcp"), onprem: mockIssuer("onprem"), azure_mock: mockIssuer("azure_mock") },
    permissions: p, ledger: memoryLedger({ durable: true }), resolveEnv: async () => ({ roleRef: "arn:aws:iam::123456789012:role/svc-operate" }),
    audit: async (_t, a) => { log.push(a); } });
  const [r] = STEP_ROLES.relay;
  const actions = stepActions(perms, "aws", r.purpose, r.stage, r.policy);
  assert.deepEqual(actions, [...RELAY_ACTIONS]);
  const req = { tenantId: T, envId: randomUUID(), provider: "aws", purpose: "operate", migrationId: M, stage: "apply", policy: "relay", actions, ttlSec: 900 };
  const cred = await mk().issue(req, { step: "relay" });
  assert.equal(cred.actions.length, RELAY_ACTIONS.length);
  const policy = JSON.parse(sent[0]!) as { Statement: { Action: string[] }[] };
  const allowed = policy.Statement.flatMap((s) => s.Action);
  // 줄이지 않은 원문 그대로 (ec2:* 로 줄면 실행 역할 운영 정책의 다른 ec2 동작까지 열린다)
  assert.deepEqual(allowed, [...RELAY_ACTIONS]);
  assert.ok(sent[0]!.length <= 2048);
  assert.equal(log.at(-1)!.detail!.policy, "relay");
  const noRelay = { ...perms, aws: { ...perms.aws, relay: undefined } };
  await assert.rejects(mk(noRelay).issue(req), (e: TempRoleDenied) => e.code === "ROLE_NO_CEILING");
  await assert.rejects(mk().issue({ ...req, actions: [...actions, "ec2:DeleteVpc"] }), (e: TempRoleDenied) => e.code === "ROLE_OUTSIDE_CEILING");
  await assert.rejects(mk().issue({ ...req, provider: "gcp" }), (e: TempRoleDenied) => e.code === "ROLE_POLICY_PROVIDER");
});

test("relayTags·ownedBy: 두 태그가 다 있어야 우리 것", () => {
  assert.ok(ownedBy(relayTags(M, "relay"), M));
  assert.ok(!ownedBy(relayTags(M, "relay"), randomUUID()));
  assert.ok(!ownedBy([{ Key: "svc:migration", Value: M }], M));
  assert.ok(!ownedBy([{ Key: "managed-by", Value: "platform" }], M));
});
