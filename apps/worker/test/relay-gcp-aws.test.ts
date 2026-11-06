// GCP 출발 → AWS 도착 중계기 (relay/gcp-aws.ts · relay-step.ts 표 · aws-relay.ts 계획): 길(L1~L4)마다 정한 것을 고정한다.
//   진짜 AWS·GCP 는 부르지 않는다 (가짜 aws = fake-aws-relay.ts, 가짜 gcloud = 이 파일의 exec)
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ExecResult } from "@svc/adapters";
import { RELAY_ACTIONS } from "@svc/adapters";
import { PASSWORD_REF_RE, ReplicationEndpoint } from "@svc/contracts";
import { loadPermissionSet, STEP_ROLES, stepActions } from "@svc/security";
import { FakeAws, fakeDeps } from "./fake-aws-relay.js";
import { buildRelayPlan, provisionRelay, RELAY_REVERSE_TAG, teardownRelay, type GcpAwsRelayPlanInput, RelayError } from "../src/relay/aws-relay.js";
import {
  cloudSqlInstanceFromIds, relayApplies, relayHome, relayKindOf, relayRoleStep, teardownRelayStep, type RelayFacts,
} from "../src/relay/relay-step.js";
import {
  cidrCovers, cloudSqlSourceOf, cloudSqlSourceProblems, gcpAwsEndpointRows, gcpAwsRelayGate, gcpAwsRelayPrecheck, prepareGcpAwsRelayStep,
  provisionGcpAwsRelayStep, rdsIdentifierOfAddress, readTargetNatIps, type CloudSqlSource,
} from "../src/relay/gcp-aws.js";

// 시험용 가짜 값 (문서용 IP 대역·가짜 계정)
const T = "11111111-1111-4111-8111-111111111111", M = "22222222-2222-4222-8222-222222222222";
const SRC_ENV = "783df2ef-8dbf-4a20-904d-bb02aeb96332";
const RDS = "shop-db-ab12.c1abcdefgh.ap-northeast-2.rds.amazonaws.com";
const PLAT = "198.51.100.7/32";
const SQL_PUBLIC = "203.0.113.20", SQL_OUT = "203.0.113.99", NAT = "192.0.2.10";
const PEM = "-----BEGIN CERTIFICATE-----\nMIIBx\n-----END CERTIFICATE-----";
const PERM_DIR = new URL("../../../infra/permissions/", import.meta.url).pathname;
const ENV_OK = { PLATFORM_EGRESS_CIDRS: PLAT, REPL_SECRET_SRC_783DF2EF: "fake-src-password" } as NodeJS.ProcessEnv;

const sqlFacts = (o: Partial<CloudSqlSource> = {}): CloudSqlSource => ({
  project: "src-proj-1", instance: "shop-db", publicIp: SQL_PUBLIC, outgoingIp: SQL_OUT, ipv4Enabled: true,
  authorizedNetworks: [`${NAT}/32`, PLAT], logicalDecoding: true, sslMode: "ENCRYPTED_ONLY", requireSsl: false, serverCaPem: PEM, ...o });
const facts = (o: Partial<RelayFacts> = {}): RelayFacts => ({
  sourceProvider: "gcp", sourceRegion: "asia-northeast3", sourceExternalId: null, targetProvider: "aws", targetRegion: "ap-northeast-2", targetExternalId: "ext-tgt",
  postgres: [{ id: "shop-db", db: "shop", user: "shop_app" }], rdsIdentifier: null, cloudSql: { project: "src-proj-1", instance: "shop-db" },
  onpremEgressIp: null, existing: [], ...o });
const job = { tenantId: T, migrationId: M };
const mig = { id: M, status: "provisioning" as const, sourceEnvId: SRC_ENV, targetEnvId: randomUUID() };
const planIn = (o: Partial<GcpAwsRelayPlanInput> = {}): GcpAwsRelayPlanInput => ({
  kind: "gcp-aws", migrationId: M,
  rds: { identifier: "shop-db-ab12", endpoint: RDS, port: 5432, vpcId: "vpc-0a1", securityGroupIds: ["sg-0rds"], masterUsername: "shop_app", dbName: "shop", masterSecretArn: null },
  network: { vpcCidrs: ["10.0.0.0/16"], subnetId: "subnet-0b0b" }, ami: { imageId: "ami-0abc", rootDeviceName: "/dev/xvda" },
  platformEgressCidrs: [PLAT], cloudSql: { publicIp: SQL_PUBLIC, outgoingIp: SQL_OUT }, ...o });
/** 도착 RDS 보안 그룹 = terraform 모양 (들어오기는 EKS 클러스터 SG 참조뿐, 나가기 없음) */
function targetFake() {
  const f = new FakeAws(RDS, M);
  f.sgs.set("sg-0rds", { vpc: "vpc-0a1", tags: [{ Key: "managed-by", Value: "platform" }, { Key: "tenant", Value: T }] });
  f.rules = [{ id: "sgr-rds-cluster", group: "sg-0rds", egress: false, proto: "tcp", from: 5432, to: 5432, cidr: "sg:sg-0cluster", tags: [] }];
  return f;
}

// ── 표·문 ──────────────────────────────────────────────────────────────────────────

test("표: gcp->aws = gcp-aws, 중계기는 도착 계정 (빌리는 역할 relay_target), 흉내 자격은 도착 연결 번호로 본다", () => {
  assert.equal(relayKindOf("gcp", "aws"), "gcp-aws");
  assert.equal(relayHome("gcp-aws"), "target");
  assert.equal(relayRoleStep("gcp-aws"), "relay_target");
  assert.equal(relayRoleStep("aws-gcp"), "relay");
  assert.equal(relayApplies(facts(), {}), null, "출발 GCP 에 external_id 가 없어도 도착 AWS 연결 번호로 간다");
  assert.equal(relayApplies(facts({ targetExternalId: null }), {}), "target_creds_mock");
  assert.equal(relayApplies(facts(), { REAL_STS: "0" }), "target_creds_mock");
  assert.equal(relayApplies(facts(), { RELAY_AUTO: "0" }), "relay_auto_off");
  // 예전 짝은 그대로 출발 쪽을 본다
  assert.equal(relayApplies({ sourceProvider: "aws", sourceExternalId: null, targetProvider: "gcp", targetExternalId: "x" }, {}), "source_creds_mock");
});

test("STEP_ROLES: relay_target = 도착 실행 역할 + relay 정책(중계기 동작만), relay_source_read = 출발 관찰만", () => {
  const perms = loadPermissionSet(PERM_DIR);
  const [r] = STEP_ROLES.relay_target;
  assert.deepEqual([r.side, r.purpose, r.stage, r.policy], ["target", "operate", "apply", "relay"]);
  assert.deepEqual(stepActions(perms, "aws", r.purpose, r.stage, r.policy), [...RELAY_ACTIONS]);
  assert.deepEqual(STEP_ROLES.relay_source_read, [{ side: "source", purpose: "observe" }]);
});

test("명세 ids → Cloud SQL: selfLink(프로젝트·이름), nativeKey 는 출발 프로젝트로, 다른 구성요소·이상한 값은 안 봄", () => {
  const self = "https://sqladmin.googleapis.com/sql/v1beta4/projects/src-proj-1/instances/shop-db";
  assert.deepEqual(cloudSqlInstanceFromIds({ [self]: "shop-db" }, "shop-db"), { project: "src-proj-1", instance: "shop-db" });
  assert.deepEqual(cloudSqlInstanceFromIds({ "cloudsql.instance/src-proj-1//shop-db": "shop-db" }, "shop-db", "src-proj-1"), { project: "src-proj-1", instance: "shop-db" });
  assert.equal(cloudSqlInstanceFromIds({ "cloudsql.instance/x//shop-db": "shop-db" }, "shop-db"), null, "nativeKey 인데 프로젝트를 모르면 null");
  assert.equal(cloudSqlInstanceFromIds({ [self]: "other" }, "shop-db"), null);
  assert.equal(cloudSqlInstanceFromIds({ "https://sqladmin.googleapis.com/sql/v1beta4/projects/a;rm/instances/x": "shop-db" }, "shop-db"), null);
});

test("문: 짝·흉내·postgres 없음은 건너뜀, postgres 둘·Cloud SQL 모름·플랫폼 대역 없음은 고칠 자리와 함께 거부", () => {
  assert.deepEqual(gcpAwsRelayGate(facts({ targetProvider: "gcp" }), ENV_OK), { kind: "skip", reason: "no_relay_route" });
  assert.deepEqual(gcpAwsRelayGate(facts({ targetExternalId: null }), ENV_OK), { kind: "skip", reason: "target_creds_mock" });
  assert.deepEqual(gcpAwsRelayGate(facts({ postgres: [] }), ENV_OK), { kind: "skip", reason: "no_postgres" });
  const two = gcpAwsRelayGate(facts({ postgres: [{ id: "a", db: "a", user: "a" }, { id: "b", db: "b", user: "b" }] }), ENV_OK);
  assert.equal(two.kind === "fail" && two.failureCode, "RELAY_SOURCE_DB_UNKNOWN");
  const noSql = gcpAwsRelayGate(facts({ cloudSql: null }), ENV_OK);
  assert.equal(noSql.kind === "fail" && noSql.failureCode, "RELAY_SOURCE_DB_UNKNOWN");
  assert.deepEqual(noSql.kind === "fail" && noSql.missing, ["spec_v2.ids: Cloud SQL selfLink"]);
  const noCidr = gcpAwsRelayGate(facts(), {});
  assert.equal(noCidr.kind === "fail" && noCidr.failureCode, "RELAY_CONFIG_MISSING");
  assert.deepEqual(noCidr.kind === "fail" && noCidr.missing, ["PLATFORM_EGRESS_CIDRS"]);
  assert.deepEqual(gcpAwsRelayGate(facts(), ENV_OK), { kind: "ready", ref: { project: "src-proj-1", instance: "shop-db" }, platformCidrs: [PLAT],
    region: "ap-northeast-2", db: "shop", user: "shop_app" });
});

// ── 출발 Cloud SQL (L2·L3 의 고객 몫) ────────────────────────────────────────────────────

test("Cloud SQL 읽기: 공개(PRIMARY)·나가는(OUTGOING) IP·승인된 네트워크·논리 디코딩·sslMode·서버 CA 만", () => {
  const raw = { ipAddresses: [{ type: "PRIVATE", ipAddress: "10.9.0.3" }, { type: "PRIMARY", ipAddress: SQL_PUBLIC }, { type: "OUTGOING", ipAddress: SQL_OUT }],
    settings: { ipConfiguration: { ipv4Enabled: true, authorizedNetworks: [{ value: `${NAT}/32` }, { value: PLAT }], sslMode: "ENCRYPTED_ONLY", requireSsl: false },
      databaseFlags: [{ name: "cloudsql.logical_decoding", value: "on" }] }, serverCaCert: { cert: PEM } };
  assert.deepEqual(cloudSqlSourceOf({ project: "src-proj-1", instance: "shop-db" }, raw), sqlFacts());
  const bare = cloudSqlSourceOf({ project: "p-123456", instance: "x" }, { serverCaCert: { cert: "-----BEGIN PRIVATE KEY-----" } });
  assert.deepEqual([bare.publicIp, bare.outgoingIp, bare.ipv4Enabled, bare.logicalDecoding, bare.serverCaPem], [null, null, false, false, null]);
});

test("CIDR 품기: 넓은 대역·같은 IP·/32 는 품고, 좁은 대역·다른 대역은 아님", () => {
  assert.ok(cidrCovers("198.51.100.0/24", PLAT));
  assert.ok(cidrCovers("198.51.100.7", PLAT));
  assert.ok(cidrCovers(PLAT, "198.51.100.7"));
  assert.ok(!cidrCovers(PLAT, "198.51.100.0/24"));
  assert.ok(!cidrCovers("198.51.101.0/24", PLAT));
  assert.ok(!cidrCovers("bogus", PLAT));
});

test("Cloud SQL 점검: 다 맞으면 없음. 공개 IP·플랫폼 대역·NAT IP·논리 디코딩·클라이언트 인증서는 block(빠진 것 이름), NAT 모르면 warn", () => {
  const ok = { platformCidrs: [PLAT], natIps: [NAT] };
  assert.deepEqual(cloudSqlSourceProblems(sqlFacts(), ok), []);
  const ids = (s: Partial<CloudSqlSource>, o: Parameters<typeof cloudSqlSourceProblems>[1] = ok) =>
    cloudSqlSourceProblems(sqlFacts(s), o).map((p) => `${p.id}:${p.level}`);
  assert.deepEqual(ids({ ipv4Enabled: false, publicIp: null }), ["PC-RELAY-SQL-PUBLIC:block"]);
  assert.deepEqual(ids({ outgoingIp: null }), ["PC-RELAY-SQL-PUBLIC:block"]);
  assert.deepEqual(ids({ authorizedNetworks: [`${NAT}/32`] }), ["PC-RELAY-SQL-AUTHNET:block"]);
  assert.deepEqual(ids({ authorizedNetworks: [PLAT] }), ["PC-RELAY-SQL-NAT:block"]);
  assert.deepEqual(ids({}, { platformCidrs: [PLAT], natIps: null }), ["PC-RELAY-SQL-NAT:warn"]);
  assert.deepEqual(ids({}, { platformCidrs: [PLAT], natIps: [] }), ["PC-RELAY-SQL-NAT:block"]);
  assert.deepEqual(ids({ logicalDecoding: false }), ["PC-RELAY-SQL-DECODING:block"]);
  assert.deepEqual(ids({ sslMode: "TRUSTED_CLIENT_CERTIFICATE_REQUIRED" }), ["PC-RELAY-SQL-TLS:block"]);
  assert.deepEqual(ids({ sslMode: null, requireSsl: true }), ["PC-RELAY-SQL-TLS:block"], "옛 requireSsl=true = 클라이언트 인증서 요구");
  const nat = cloudSqlSourceProblems(sqlFacts({ authorizedNetworks: [PLAT] }), ok)[0]!;
  assert.deepEqual(nat.missing, [`gcp: Cloud SQL shop-db 승인된 네트워크 ${NAT}/32`]);
  assert.match(nat.hint, /gcloud sql instances patch shop-db --project=src-proj-1 --authorized-networks=<지금 목록>,192\.0\.2\.10\/32/);
});

// ── 중계기 계획 (L1·L4 입구, L3 RDS 나가기) ──────────────────────────────────────────────────

test("계획: 입구 15432 하나 = 플랫폼 대역 + Cloud SQL 나가는 IP/32, 22·5432 들어오기 없음, 나가기 = VPC, RDS 나가기 대상 = Cloud SQL 공개 IP", () => {
  const p = buildRelayPlan(planIn());
  assert.equal(p.kind, "gcp-aws");
  assert.deepEqual(p.rules.map((r) => `${r.direction}:${r.port}:${r.cidr}`), [
    `ingress:15432:${PLAT}`, `ingress:15432:${SQL_OUT}/32`, "egress:5432:10.0.0.0/16"]);
  assert.ok(!p.rules.some((r) => r.direction === "ingress" && (r.port === 22 || r.port === 5432)), "SSH·5432 들어오기 없음");
  assert.match(p.userData, new RegExp(`svc-relay-fwd\\.py ${RDS.replace(/\./g, "\\.")} 5432 15432`));
  assert.ok(!/sshd|authorized_keys|svc-relay-rev/.test(p.userData), "SSH·역방향 forwarder 없음");
  assert.equal(p.hostPublicKey, null);
  assert.equal(p.reverseTarget, RDS, "user-data 목적지 = 도착 RDS (바뀌면 EC2 새로)");
  assert.equal(p.instance.tags.find((t) => t.Key === RELAY_REVERSE_TAG)?.Value, RDS);
  assert.equal(p.dbEgress.peerIp, SQL_PUBLIC);
  assert.equal(p.dbEgress.groupId, "sg-0rds");
  assert.deepEqual(buildRelayPlan(planIn()), p, "같은 입력 → 같은 계획");
  assert.equal(buildRelayPlan(planIn({ platformEgressCidrs: [`${SQL_OUT}/32`] })).rules.filter((r) => r.port === 15432).length, 1, "겹치면 한 줄");
  assert.throws(() => buildRelayPlan(planIn({ cloudSql: { publicIp: "", outgoingIp: SQL_OUT } })), (e: RelayError) => e.code === "RELAY_SOURCE_DB_UNKNOWN");
  assert.throws(() => buildRelayPlan(planIn({ platformEgressCidrs: [] })), (e: RelayError) => e.code === "RELAY_CONFIG_MISSING");
});

test("실행기: 도착 RDS 보안 그룹에 들어오기(중계 SG)·나가기(Cloud SQL 공개 IP/32) 둘 다 태그로 달고, 다시 돌면 그대로, 정리는 전부·두 번 불러도 됨", async () => {
  const f = targetFake();
  f.foreign();
  const r1 = await provisionRelay(fakeDeps(f), buildRelayPlan(planIn()));
  const rdsRules = () => f.rules.filter((r) => r.group === "sg-0rds");
  const eg = rdsRules().find((r) => r.egress)!;
  assert.deepEqual([eg.cidr, eg.from, eg.tags.find((t) => t.Key === "svc:role")?.Value], [`${SQL_PUBLIC}/32`, 5432, "relay-db-egress"]);
  const ing = rdsRules().find((r) => !r.egress && r.id !== "sgr-rds-cluster")!;
  assert.deepEqual([ing.cidr, ing.tags.find((t) => t.Key === "svc:role")?.Value], [`sg:${r1.securityGroupId}`, "relay-db-ingress"]);
  assert.ok(r1.dbEgressRuleId && r1.dbIngressRuleId);
  assert.match(f.userData, /gcp-aws/);

  const r2 = await provisionRelay(fakeDeps(f), buildRelayPlan(planIn()));
  assert.equal(r2.instanceId, r1.instanceId);
  assert.deepEqual(r2.created, [], "다시 돌면 새로 만든 것 없음");
  assert.equal(rdsRules().length, 3, "규칙이 늘지 않는다");

  // Cloud SQL 을 다시 만들어 공개 IP 가 바뀜 → 옛 나가기 규칙을 빼고 새 IP 로
  await provisionRelay(fakeDeps(f), buildRelayPlan(planIn({ cloudSql: { publicIp: "203.0.113.21", outgoingIp: SQL_OUT } })));
  assert.deepEqual(rdsRules().filter((r) => r.egress).map((r) => r.cidr), ["203.0.113.21/32"]);

  // 도착 RDS 를 다시 만들어 이름이 바뀜 → EC2 를 새로 (user-data 목적지가 고정이라)
  const newRds = "shop-db-cd34.c1abcdefgh.ap-northeast-2.rds.amazonaws.com";
  const r3 = await provisionRelay(fakeDeps(f), buildRelayPlan(planIn({ rds: { ...planIn().rds, endpoint: newRds } })));
  assert.notEqual(r3.instanceId, r1.instanceId);

  const t1 = await teardownRelay(fakeDeps(f), M);
  assert.ok(t1.removed.length >= 4);
  assert.deepEqual(rdsRules().map((r) => r.id), ["sgr-rds-cluster"], "RDS 원래 규칙(클러스터 SG)만 남는다");
  assert.ok(![...f.sgs.keys()].some((id) => id.startsWith("sg-new")), "중계 SG 0");
  assert.ok(![...f.insts].some(([id, x]) => id.startsWith("i-new") && x.state !== "terminated"), "중계 EC2 0");
  assert.ok(f.sgs.has("sg-foreign") && f.insts.get("i-foreign")?.state === "running", "남의 것은 그대로");
  assert.deepEqual((await teardownRelay(fakeDeps(f), M)).removed, [], "다시 불러도 됨 (지울 것 없음)");
});

test("실행기 거부: 도착 RDS 나가기를 열 권한이 없으면 RELAY_DB_EGRESS_DENIED (도착 연결 스택 TargetDbRulesForRelay 안내)", async () => {
  const f = targetFake();
  f.denyEgressGroup = "sg-0rds";
  await assert.rejects(provisionRelay(fakeDeps(f), buildRelayPlan(planIn())),
    (e: RelayError) => e.code === "RELAY_DB_EGRESS_DENIED" && /도착 RDS/.test(e.message) && /TargetDbRulesForRelay/.test(e.message));
  const g = targetFake();
  g.denyIngressGroup = "sg-0rds";
  await assert.rejects(provisionRelay(fakeDeps(g), buildRelayPlan(planIn())),
    (e: RelayError) => e.code === "RELAY_DB_INGRESS_DENIED" && /TargetDbRulesForRelay/.test(e.message));
});

// ── 끝점 두 줄 ─────────────────────────────────────────────────────────────────────

test("끝점 줄: 출발 = Cloud SQL 공개 IP(verify-ca·env: 출발 환경 키·peer 같은 IP), 도착 = 중계 입구 15432(tls_servername = RDS, tf:db_password, peer 같은 입구)", () => {
  const out = { db_address: RDS, db_username: "shop_app", db_name: "shop" };
  const base = { tenantId: T, migrationId: M, sourceEnvId: SRC_ENV, cloudSql: sqlFacts(), db: "shop", appUser: "shop_app", rds: planIn().rds, publicIp: "203.0.113.50", out, existing: [] };
  const [s, t] = gcpAwsEndpointRows(base);
  for (const r of [s, t]) assert.ok(ReplicationEndpoint.safeParse(r).success, JSON.stringify(ReplicationEndpoint.safeParse(r).error?.issues));
  assert.deepEqual([s.provider, s.host, s.port, s.username, s.passwordRef, s.peerHost, s.peerPort, s.appRole, s.sslmode, s.caPem, s.tlsServername],
    ["cloudsql", SQL_PUBLIC, 5432, "postgres", "env:REPL_SECRET_SRC_783DF2EF", SQL_PUBLIC, 5432, "shop_app", "verify-ca", PEM, null]);
  assert.deepEqual([t.provider, t.host, t.port, t.username, t.passwordRef, t.peerHost, t.peerPort, t.appRole, t.sslmode, t.tlsServername, t.relayHost],
    ["rds", "203.0.113.50", 15432, "shop_app", "tf:db_password", "203.0.113.50", 15432, "shop_app", "require", RDS, null]);
  assert.ok(PASSWORD_REF_RE.test(s.passwordRef) && PASSWORD_REF_RE.test(t.passwordRef));
  // 관리자를 나눈 도착(앞으로의 aws/root db_admin_username)이면 관리자 + tf:db_admin_password, 앱 계정은 따로
  const [, t2] = gcpAwsEndpointRows({ ...base, out: { ...out, db_admin_username: "svc_admin_0123456789" } });
  assert.deepEqual([t2.username, t2.passwordRef, t2.appRole], ["svc_admin_0123456789", "tf:db_admin_password", "shop_app"]);
  // 운영자가 넣은 출발 줄(다른 관리자·비밀번호 참조)은 그대로
  const [s3] = gcpAwsEndpointRows({ ...base, existing: [{ ...s, username: "repl_admin", passwordRef: "env:REPL_SECRET_SQLADMIN" }] });
  assert.deepEqual([s3.username, s3.passwordRef], ["repl_admin", "env:REPL_SECRET_SQLADMIN"]);
  // CA 가 없으면 require, 공개 IP 가 없으면·도착 계정이 없으면 거부
  assert.equal(gcpAwsEndpointRows({ ...base, cloudSql: sqlFacts({ serverCaPem: null }) })[0].sslmode, "require");
  assert.throws(() => gcpAwsEndpointRows({ ...base, cloudSql: sqlFacts({ publicIp: null }) }), (e: RelayError) => e.code === "RELAY_SOURCE_DB_UNKNOWN");
  assert.throws(() => gcpAwsEndpointRows({ ...base, out: { db_address: RDS } }), (e: RelayError) => e.code === "RELAY_TARGET_DB_UNKNOWN");
  assert.equal(rdsIdentifierOfAddress(RDS), "shop-db-ab12");
  assert.equal(rdsIdentifierOfAddress("10.0.0.1"), null);
});

// ── apply 단계 ─────────────────────────────────────────────────────────────────────

test("apply 앞(prepare): 짝이 다르면 null, 출발 비밀번호 env·Cloud SQL 길이 모자라면 RDS 를 만들기 전에 빠진 것과 함께 failed", async () => {
  const read = async () => sqlFacts();
  assert.equal(await prepareGcpAwsRelayStep(job, mig, { env: ENV_OK, facts: facts({ sourceProvider: "aws" }), readSource: read }), null);
  assert.deepEqual(await prepareGcpAwsRelayStep(job, mig, { env: ENV_OK, facts: facts({ targetExternalId: null }), readSource: read }), { kind: "skip", reason: "target_creds_mock" });
  const noPw = await prepareGcpAwsRelayStep(job, mig, { env: { PLATFORM_EGRESS_CIDRS: PLAT }, facts: facts(), readSource: read });
  assert.equal(noPw?.kind === "fail" && noPw.failureCode, "REPL_SECRET_UNRESOLVED");
  assert.deepEqual(noPw?.kind === "fail" && noPw.missing, ["REPL_SECRET_SRC_783DF2EF"]);
  let reads = 0;
  const bad = await prepareGcpAwsRelayStep(job, mig, { env: ENV_OK, facts: facts(), readSource: async () => { reads++; return sqlFacts({ logicalDecoding: false, authorizedNetworks: [] }); } });
  assert.equal(bad?.kind === "fail" && bad.failureCode, "RELAY_SOURCE_DB_UNKNOWN");
  assert.deepEqual(bad?.kind === "fail" && bad.missing, [`gcp: Cloud SQL shop-db 승인된 네트워크 ${PLAT}`, "gcp: Cloud SQL shop-db 플래그 cloudsql.logical_decoding=on"],
    "NAT 는 apply 에서 안 본다 (사전 점검 몫)");
  assert.equal(reads, 1);
  const readFail = await prepareGcpAwsRelayStep(job, mig, { env: ENV_OK, facts: facts(), readSource: async () => { throw new RelayError("RELAY_SOURCE_DB_UNKNOWN", "no"); } });
  assert.equal(readFail?.kind === "fail" && readFail.failureCode, "RELAY_SOURCE_DB_UNKNOWN");
  const go = await prepareGcpAwsRelayStep(job, mig, { env: ENV_OK, facts: facts(), readSource: read });
  assert.deepEqual(go, { kind: "go", cloudSql: sqlFacts(), platformCidrs: [PLAT], region: "ap-northeast-2", db: "shop", user: "shop_app" });
});

test("apply 뒤(provision): 도착 비밀번호 없으면 안 빌림, 역할 거부는 도착 연결 스택 안내, 정상이면 도착 자격으로 만들고 끝점 두 줄을 쓴다", async () => {
  const root = mkdtempSync(join(tmpdir(), "gcp-aws-"));
  const env = { ...ENV_OK, TF_WORK_DIR: root } as NodeJS.ProcessEnv;
  const g = { kind: "go" as const, cloudSql: sqlFacts(), platformCidrs: [PLAT], region: "ap-northeast-2", db: "shop", user: "shop_app" };
  const out = { db_address: RDS, db_username: "shop_app", db_name: "shop", db_master_secret_arn: "arn:aws:secretsmanager:ap-northeast-2:000000000000:secret:rds!db-x" };
  let borrowed = 0;
  const f = targetFake();
  const noSecret = await provisionGcpAwsRelayStep(job, mig, g, out, { env, aws: { exec: f.exec }, borrow: async (fn) => { borrowed++; return fn({ denied: [] }); } });
  assert.equal(noSecret.kind === "failed" && noSecret.failureCode, "RELAY_TARGET_DB_UNKNOWN");
  assert.deepEqual(noSecret.kind === "failed" && noSecret.detail?.missing, ["db-secret.json: db_password"]);
  assert.equal(borrowed + f.calls.length, 0);
  const noAddr = await provisionGcpAwsRelayStep(job, mig, g, { db_username: "shop_app" }, { env, borrow: async (fn) => fn({ denied: [] }) });
  assert.equal(noAddr.kind === "failed" && noAddr.failureCode, "RELAY_TARGET_DB_UNKNOWN");

  mkdirSync(join(root, M), { recursive: true });
  writeFileSync(join(root, M, "db-secret.json"), JSON.stringify({ db_password: "fake" }), { mode: 0o600 });
  const denied = await provisionGcpAwsRelayStep(job, mig, g, out, { env, aws: { exec: f.exec },
    borrow: async (fn) => fn({ denied: [{ side: "target", purpose: "operate", code: "ROLE_NO_CEILING" }] }) });
  assert.equal(denied.kind === "failed" && denied.failureCode, "RELAY_ROLE_DENIED");
  assert.deepEqual(denied.kind === "failed" && denied.detail?.missing, ["aws: 도착 svc-operate 인라인 정책 relay"]);

  // 출발 쪽 자격만 있으면(옛 relay 단계) 쓰지 않는다: 도착 계정에 만든다
  const wrongSide = await provisionGcpAwsRelayStep(job, mig, g, out, { env, aws: { exec: f.exec },
    borrow: async (fn) => fn({ awsEnv: { source: { AWS_CONFIG_FILE: "/dev/null" } }, denied: [] }) });
  assert.equal(wrongSide.kind === "failed" && wrongSide.failureCode, "RELAY_ROLE_DENIED");

  const saved: ReplicationEndpoint[][] = [];
  let appLogins = 0;
  const ok = await provisionGcpAwsRelayStep(job, mig, g, out, { env, aws: { exec: f.exec, sleep: async () => {}, pollMs: 0, pollTries: 5 },
    borrow: async (fn) => fn({ awsEnv: { target: { AWS_CONFIG_FILE: "/dev/null" } }, denied: [] }),
    existing: [], save: async (r) => { saved.push(r); }, appLogin: async () => { appLogins++; return "created"; } });
  assert.equal(ok.kind, "ok", JSON.stringify(ok));
  const d = ok.kind === "ok" ? ok.detail : {};
  assert.deepEqual([d.kind, d.rdsIdentifier, d.entryPort, d.appLogin, d.targetAppRoleIsAdmin], ["gcp-aws", "shop-db-ab12", 15432, "same_as_admin", true]);
  assert.equal(appLogins, 0, "관리자 = 앱(RDS 마스터)이면 로그인 역할을 안 만든다 (DB-08 이 sync 에서 멈춘다)");
  assert.deepEqual(saved[0]!.map((r) => `${r.side}:${r.provider}:${r.host}:${r.port}`), [`source:cloudsql:${SQL_PUBLIC}:5432`, "target:rds:203.0.113.50:15432"]);
  assert.ok(!JSON.stringify(d).includes("fake"), "감사 detail 에 비밀번호 없음");

  // 관리자를 나눈 도착이면 앱 로그인 역할을 맞춘다 (두 비밀번호가 다 있어야)
  writeFileSync(join(root, M, "db-secret.json"), JSON.stringify({ db_password: "fake", db_admin_password: "fake2" }), { mode: 0o600 });
  const split = await provisionGcpAwsRelayStep(job, mig, g, { ...out, db_admin_username: "svc_admin_0123456789" }, { env, aws: { exec: f.exec, sleep: async () => {}, pollMs: 0, pollTries: 5 },
    borrow: async (fn) => fn({ awsEnv: { target: { AWS_CONFIG_FILE: "/dev/null" } }, denied: [] }), existing: [], save: async () => {}, appLogin: async () => { appLogins++; return "created"; } });
  assert.equal(split.kind === "ok" && split.detail.appLogin, "created");
  assert.equal(appLogins, 1);
  rmSync(root, { recursive: true, force: true });
});

test("정리: gcp-aws 는 도착 자격·도착 지역으로 지운다, 도착 연결이 흉내면 건너뜀 (cleanup·롤백·repl-cleanup 은 그대로 부름)", async () => {
  const f = targetFake();
  await provisionRelay(fakeDeps(f), buildRelayPlan(planIn()));
  const env = { PLATFORM_EGRESS_CIDRS: PLAT } as NodeJS.ProcessEnv;
  const m = { id: M, sourceEnvId: SRC_ENV, targetEnvId: "t" };
  const regions: string[] = [];
  const exec = async (cmd: string, args: string[], o: unknown): Promise<ExecResult> => { regions.push(args[args.indexOf("--region") + 1]!); return f.exec(cmd, args); };
  const r = await teardownRelayStep(job, m, { env, facts: facts({ targetRegion: "ap-northeast-2", sourceRegion: "asia-northeast3" }), aws: { exec: exec as never, sleep: async () => {}, pollMs: 0, pollTries: 5 },
    borrow: async (fn) => fn({ awsEnv: { target: { AWS_CONFIG_FILE: "/dev/null" } }, denied: [] }) });
  assert.equal(r.kind, "ok");
  assert.ok(regions.length > 0 && regions.every((x) => x === "ap-northeast-2"), "도착 지역");
  assert.deepEqual(f.rules.filter((x) => x.group === "sg-0rds").map((x) => x.id), ["sgr-rds-cluster"]);
  const onlySource = await teardownRelayStep(job, m, { env, facts: facts(), borrow: async (fn) => fn({ awsEnv: { source: { A: "1" } }, denied: [] }) });
  assert.deepEqual(onlySource, { kind: "skipped", reason: "target_creds_mock" });
  const denied = await teardownRelayStep(job, m, { env, facts: facts(), borrow: async (fn) => fn({ denied: [{ side: "target", purpose: "operate", code: "X" }] }) });
  assert.equal(denied.kind === "failed" && denied.failureCode, "RELAY_TEARDOWN_FAILED");
  assert.match(denied.kind === "failed" ? denied.reason : "", /도착 실행 역할/);
  assert.deepEqual(await teardownRelayStep(job, m, { env, facts: facts({ targetExternalId: null }) }), { kind: "skipped", reason: "target_creds_mock" });
});

// ── 사전 점검 (승인 전) ─────────────────────────────────────────────────────────────────

/** 가짜 gcloud(sql instances describe) + aws(ec2 describe-nat-gateways) */
function cliFake(sqlRaw: unknown, nat: unknown, calls: string[][] = []) {
  return async (cmd: string, args: string[]): Promise<ExecResult> => {
    calls.push([cmd, ...args]);
    if (cmd === "gcloud" && args[0] === "sql") return { code: 0, stdout: JSON.stringify(sqlRaw), stderr: "", ms: 1 };
    if (cmd === "aws" && args[1] === "describe-nat-gateways") return nat === "deny" ? { code: 254, stdout: "", stderr: "AccessDenied", ms: 1 } : { code: 0, stdout: JSON.stringify(nat), stderr: "", ms: 1 };
    throw new Error(`fake cli: ${cmd} ${args.join(" ")}`);
  };
}
const RAW_OK = { ipAddresses: [{ type: "PRIMARY", ipAddress: SQL_PUBLIC }, { type: "OUTGOING", ipAddress: SQL_OUT }],
  settings: { ipConfiguration: { ipv4Enabled: true, authorizedNetworks: [{ value: PLAT }, { value: `${NAT}/32` }], sslMode: "ENCRYPTED_ONLY" },
    databaseFlags: [{ name: "cloudsql.logical_decoding", value: "on" }] }, serverCaCert: { cert: PEM } };
const NAT_OK = { NatGateways: [{ NatGatewayAddresses: [{ PublicIp: NAT }] }] };
const roles = { gcpToken: { source: "fake-token" }, awsEnv: { target: { AWS_CONFIG_FILE: "/dev/null" } } };

test("사전 점검: 길이 다 맞으면 없음 (빌린 출발 토큰·도착 관찰 역할로 읽기만), 짝이 다르면 아무것도 안 읽음", async () => {
  const calls: string[][] = [];
  assert.deepEqual(await gcpAwsRelayPrecheck(job, mig, roles, ENV_OK, { facts: facts(), exec: cliFake(RAW_OK, NAT_OK, calls), targetVpcId: "vpc-0a1" }), []);
  assert.deepEqual(calls.map((c) => `${c[0]} ${c[1]} ${c[2]}`), ["gcloud sql instances", "aws ec2 describe-nat-gateways"]);
  assert.ok(calls[0]!.includes("--project=src-proj-1"));
  assert.ok(calls.every((c) => !c.some((a) => /patch|create|delete|authorize/.test(a))), "읽기만");
  const none: string[][] = [];
  assert.deepEqual(await gcpAwsRelayPrecheck(job, mig, roles, ENV_OK, { facts: facts({ sourceProvider: "aws" }), exec: cliFake(RAW_OK, NAT_OK, none) }), []);
  assert.deepEqual(await gcpAwsRelayPrecheck(job, mig, roles, ENV_OK, { facts: facts({ targetExternalId: null }), exec: cliFake(RAW_OK, NAT_OK, none) }), []);
  assert.equal(none.length, 0);
});

test("사전 점검 막힘: 플랫폼 대역·NAT IP·논리 디코딩·출발 비밀번호 env 없음 → block (빠진 것 이름 + 고칠 명령), 토큰·NAT 못 읽음 → block·warn", async () => {
  const raw = { ...RAW_OK, settings: { ...RAW_OK.settings, ipConfiguration: { ...RAW_OK.settings.ipConfiguration, authorizedNetworks: [] }, databaseFlags: [] } };
  const items = await gcpAwsRelayPrecheck(job, mig, roles, { PLATFORM_EGRESS_CIDRS: PLAT }, { facts: facts(), exec: cliFake(raw, NAT_OK), targetVpcId: "vpc-0a1" });
  assert.deepEqual(items.map((i) => `${i.id}:${i.level}`), ["PC-RELAY-SQL-SECRET:block", "PC-RELAY-SQL-AUTHNET:block", "PC-RELAY-SQL-NAT:block", "PC-RELAY-SQL-DECODING:block"]);
  assert.match(items[0]!.message, /빠진 것: REPL_SECRET_SRC_783DF2EF/);
  assert.match(items[0]!.fix!, /secretKeys/);
  assert.match(items[2]!.message, new RegExp(`빠진 것: gcp: Cloud SQL shop-db 승인된 네트워크 ${NAT.replace(/\./g, "\\.")}/32`));
  const noTok = await gcpAwsRelayPrecheck(job, mig, { awsEnv: roles.awsEnv }, ENV_OK, { facts: facts(), exec: cliFake(RAW_OK, NAT_OK) });
  assert.deepEqual(noTok.map((i) => `${i.id}:${i.level}`), ["PC-RELAY-SQL-READ:block"]);
  const natDeny = await gcpAwsRelayPrecheck(job, mig, roles, ENV_OK, { facts: facts(), exec: cliFake(RAW_OK, "deny"), targetVpcId: "vpc-0a1" });
  assert.deepEqual(natDeny.map((i) => `${i.id}:${i.level}`), ["PC-RELAY-SQL-NAT:warn"]);
  const noVpc = await gcpAwsRelayPrecheck(job, mig, roles, ENV_OK, { facts: facts(), exec: cliFake(RAW_OK, NAT_OK), targetVpcId: null });
  assert.deepEqual(noVpc.map((i) => `${i.id}:${i.level}`), ["PC-RELAY-SQL-NAT:warn"]);
  const gate = await gcpAwsRelayPrecheck(job, mig, roles, {}, { facts: facts(), exec: cliFake(RAW_OK, NAT_OK) });
  assert.deepEqual(gate.map((i) => `${i.id}:${i.level}`), ["PC-RELAY-GCP-AWS:block"]);
  assert.match(gate[0]!.message, /빠진 것: PLATFORM_EGRESS_CIDRS/);
  assert.deepEqual(await readTargetNatIps("not-a-vpc", {}, "ap-northeast-2", cliFake(RAW_OK, NAT_OK)), null);
});
