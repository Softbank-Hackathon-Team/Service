// 온프레 출발 → AWS 도착 중계기 (relay/onprem-aws.ts, ADR-031 R4): 표·문·끝점 두 줄·도착 계정에 만들기를 고정한다.
//   진짜 AWS 는 부르지 않는다 (가짜 aws = fake-aws-relay.ts)
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ReplicationEndpoint } from "@svc/contracts";
import { FakeAws } from "./fake-aws-relay.js";
import { relayHome, relayKindOf, relayRoleStep, type RelayFacts } from "../src/relay/relay-step.js";
import { onpremAwsEndpointRows, onpremAwsRelayGate, prepareOnpremAwsRelayStep, provisionOnpremAwsRelayStep } from "../src/relay/onprem-aws.js";

// 시험용 가짜 값 (문서용 IP 대역·가짜 계정). 마스터 키는 비밀이 아닌 시험 값
const T = "11111111-1111-4111-8111-111111111111", M = "33333333-3333-4333-8333-333333333333";
const RDS = "shop-db-ab12.c1abcdefgh.ap-northeast-2.rds.amazonaws.com";
const PLAT = "198.51.100.7/32", EGRESS = "192.0.2.44";
const MK = "test-master-key-not-a-secret-0123456789";
const ENV_OK = { PLATFORM_EGRESS_CIDRS: PLAT, REPL_SECRET_MASTER_KEY: MK, REAL_STS: "1" } as NodeJS.ProcessEnv;
const job = { tenantId: T, migrationId: M };
const mig = { id: M, status: "provisioning" as const, sourceEnvId: randomUUID(), targetEnvId: randomUUID() };
const facts = (o: Partial<RelayFacts> = {}): RelayFacts => ({
  sourceProvider: "onprem", sourceRegion: null, sourceExternalId: null, targetProvider: "aws", targetRegion: "ap-northeast-2", targetExternalId: "ext-tgt",
  postgres: [{ id: "shop-db", db: "shop", user: "shop_app" }], rdsIdentifier: null, cloudSql: null,
  onpremEgressIp: EGRESS, existing: [], ...o } as RelayFacts);
function targetFake() {
  const f = new FakeAws(RDS, M);
  f.sgs.set("sg-0rds", { vpc: "vpc-0a1", tags: [{ Key: "managed-by", Value: "platform" }, { Key: "tenant", Value: T }] });
  f.rules = [{ id: "sgr-rds-cluster", group: "sg-0rds", egress: false, proto: "tcp", from: 5432, to: 5432, cidr: "sg:sg-0cluster", tags: [] }];
  return f;
}

test("표: onprem->aws = onprem-aws, 중계기는 도착 계정 (빌리는 역할 relay_target)", () => {
  assert.equal(relayKindOf("onprem", "aws"), "onprem-aws");
  assert.equal(relayHome("onprem-aws"), "target");
  assert.equal(relayRoleStep("onprem-aws"), "relay_target");
});

test("문: pull 아님·흉내 자격·다른 짝은 건너뜀, 나가는 IP 모름·마스터 키 없음·DB 둘은 실패, 다 있으면 도착 지역으로 go", async () => {
  assert.deepEqual(onpremAwsRelayGate(facts(), { ...ENV_OK, ONPREM_FLOOR_VIA_GIT: "0" }), { kind: "skip", reason: "not_pull_mode" });
  assert.deepEqual(onpremAwsRelayGate(facts({ targetExternalId: null }), ENV_OK), { kind: "skip", reason: "target_creds_mock" });
  assert.deepEqual(onpremAwsRelayGate(facts({ postgres: [] }), ENV_OK), { kind: "skip", reason: "no_postgres" });
  const code = (f: RelayFacts, env = ENV_OK) => { const g = onpremAwsRelayGate(f, env); return g.kind === "fail" ? g.failureCode : g.kind; };
  assert.equal(code(facts({ onpremEgressIp: null })), "ONPREM_EGRESS_UNKNOWN", "22 를 세상에 열지 않는다");
  assert.equal(code(facts({ onpremEgressIp: "not-an-ip" })), "ONPREM_EGRESS_UNKNOWN");
  assert.equal(code(facts(), { ...ENV_OK, REPL_SECRET_MASTER_KEY: "short" }), "REPL_SECRET_UNRESOLVED");
  assert.equal(code(facts({ postgres: [{ id: "a", db: "a", user: "u" }, { id: "b", db: "b", user: "u" }] })), "RELAY_SOURCE_DB_UNKNOWN");
  assert.deepEqual(onpremAwsRelayGate(facts(), ENV_OK),
    { kind: "go", egressIp: EGRESS, platformCidrs: [PLAT], masterKey: MK, region: "ap-northeast-2", db: "shop", user: "shop_app" });
  // 다른 짝이면 apply 는 예전 그대로 (null)
  assert.equal(await prepareOnpremAwsRelayStep(job, mig, { env: ENV_OK, facts: facts({ sourceProvider: "aws", targetProvider: "onprem" }) }), null);
});

test("끝점 두 줄: 출발 = 온프레 CNPG(중계 공개 IP:5432, svc_migrate, derive:migrate, 중계기 칸), 도착 = RDS(입구 :15432, 진짜 이름은 tls_servername). 계약 통과", () => {
  const rds = { identifier: "shop-db-ab12", endpoint: RDS, port: 5432, vpcId: "vpc-0a1", securityGroupIds: ["sg-0rds"], masterUsername: "shop_app", dbName: "shop", masterSecretArn: null };
  const [s, t] = onpremAwsEndpointRows({ tenantId: T, migrationId: M, db: "shop", appUser: "shop_app", rds, out: { db_address: RDS, db_username: "shop_app", db_name: "shop" },
    publicIp: "203.0.113.50", privateIp: "10.0.1.20", knownHosts: "203.0.113.50 ssh-ed25519 AAAAfake", existing: [] });
  assert.ok(ReplicationEndpoint.safeParse(s).success, JSON.stringify(ReplicationEndpoint.safeParse(s).error?.issues));
  assert.ok(ReplicationEndpoint.safeParse(t).success, JSON.stringify(ReplicationEndpoint.safeParse(t).error?.issues));
  assert.deepEqual([s.side, s.provider, s.host, s.port, s.username, s.passwordRef, s.peerHost, s.relayHost], ["source", "cnpg", "203.0.113.50", 5432, "svc_migrate", "derive:migrate", "10.0.1.20", "203.0.113.50"]);
  assert.deepEqual([t.side, t.provider, t.host, t.port, t.tlsServername, t.passwordRef, t.peerHost, t.relayHost], ["target", "rds", "203.0.113.50", 15432, RDS, "tf:db_password", null, null]);
  // 거부: 도착 계정 이름이 terraform 출력에 없으면 줄을 만들지 않는다
  assert.throws(() => onpremAwsEndpointRows({ tenantId: T, migrationId: M, db: "shop", appUser: "shop_app", rds, out: { db_address: RDS },
    publicIp: "203.0.113.50", privateIp: "10.0.1.20", knownHosts: "x", existing: [] }), /db_username/);
});

test("apply 뒤(provision): 도착 비밀번호 없으면 안 빌림, 도착 자격 없으면 RELAY_ROLE_DENIED, 정상이면 도착 계정에 중계기 + 끝점 두 줄 (비밀 없음)", async () => {
  const root = mkdtempSync(join(tmpdir(), "onprem-aws-"));
  const env = { ...ENV_OK, TF_WORK_DIR: root } as NodeJS.ProcessEnv;
  const g = { kind: "go" as const, egressIp: EGRESS, platformCidrs: [PLAT], masterKey: MK, region: "ap-northeast-2", db: "shop", user: "shop_app" };
  const out = { db_address: RDS, db_username: "shop_app", db_name: "shop" };
  let borrowed = 0;
  const f = targetFake();
  const noSecret = await provisionOnpremAwsRelayStep(job, mig, g, out, { env, aws: { exec: f.exec }, borrow: async (fn) => { borrowed++; return fn({ denied: [] }); } });
  assert.equal(noSecret.kind === "failed" && noSecret.failureCode, "RELAY_TARGET_DB_UNKNOWN");
  assert.equal(borrowed + f.calls.length, 0);
  mkdirSync(join(root, M), { recursive: true });
  writeFileSync(join(root, M, "db-secret.json"), JSON.stringify({ db_password: "fake" }), { mode: 0o600 });
  const wrongSide = await provisionOnpremAwsRelayStep(job, mig, g, out, { env, aws: { exec: f.exec },
    borrow: async (fn) => fn({ awsEnv: { source: { AWS_CONFIG_FILE: "/dev/null" } }, denied: [] }) });
  assert.equal(wrongSide.kind === "failed" && wrongSide.failureCode, "RELAY_ROLE_DENIED", "출발 자격으로는 만들지 않는다 (온프레에는 AWS 자격이 없다)");
  const saved: ReplicationEndpoint[][] = [];
  const ok = await provisionOnpremAwsRelayStep(job, mig, g, out, { env, aws: { exec: f.exec, sleep: async () => {}, pollMs: 0, pollTries: 5 },
    borrow: async (fn) => fn({ awsEnv: { target: { AWS_CONFIG_FILE: "/dev/null" } }, denied: [] }),
    existing: [], save: async (r) => { saved.push(r); } });
  assert.equal(ok.kind, "ok", JSON.stringify(ok));
  const d = ok.kind === "ok" ? ok.detail : {};
  assert.deepEqual([d.kind, d.rdsIdentifier, d.entryPort, d.appLogin, d.hostKeyFromConsole], ["onprem-aws", "shop-db-ab12", 15432, "same_as_admin", false]);
  assert.deepEqual(saved[0]!.map((r) => `${r.side}:${r.provider}:${r.port}`), ["source:cnpg:5432", "target:rds:15432"]);
  assert.ok(!JSON.stringify(d).includes("fake") && !JSON.stringify(saved).includes(MK), "감사 detail·줄에 비밀 없음");
  // 22 는 온프레 나가는 IP 에만 연다
  const ssh = f.rules.filter((r) => r.from === 22);
  assert.ok(ssh.length > 0 && ssh.every((r) => r.cidr === `${EGRESS}/32`), JSON.stringify(ssh));
  rmSync(root, { recursive: true, force: true });
});

// 중계기가 막 떴을 때 :15432 가 아직 안 열린 동안(ECONNREFUSED) 앱 로그인 맞추기를 다시 해 본다. SQL 오류는 바로 올린다
test("중계기 부팅 경합: 연결 거절은 기다렸다 다시, 인증·SQL 오류와 시간 초과는 바로 올린다", async () => {
  const { retryConnect } = await import("../src/relay/relay-step.js");
  let t = 0; const now = () => t; const sleep = async (ms: number) => { t += ms; };
  let calls = 0;
  const ok = await retryConnect(async () => { calls++; if (calls < 4) throw Object.assign(new Error("connect ECONNREFUSED 3.3.3.3:15432"), { code: "ECONNREFUSED" }); return "created" as const; },
    { waitSec: 180, now, sleep });
  assert.equal(ok, "created"); assert.equal(calls, 4); assert.equal(t, 15000);
  // 거부: 인증 오류는 다시 안 함
  let auth = 0;
  await assert.rejects(retryConnect(async () => { auth++; throw new Error('password authentication failed for user "svc_admin"'); }, { waitSec: 180, now, sleep }), /password authentication/);
  assert.equal(auth, 1);
  // 거부: 시간이 다 되면 마지막 연결 오류를 올린다
  t = 0;
  await assert.rejects(retryConnect(async () => { throw Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" }); }, { waitSec: 20, now, sleep }), /ETIMEDOUT/);
  assert.ok(t >= 20000 && t <= 25000);
});
