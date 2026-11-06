// GCP ↔ 온프레 중계기 (relay/gcp-relay.ts): 표·문·Cloud SQL 사실·계획·만들기·지우기·끝점 두 줄을 고정한다.
//   진짜 GCP 는 부르지 않는다 (가짜 gcloud = 이 파일의 FakeGcloud)
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ReplicationEndpoint } from "@svc/contracts";
import type { Exec } from "@svc/adapters";
import { relayApplies, relayHome, relayKindOf, relayRoleStep, teardownRelayStep, type RelayFacts } from "../src/relay/relay-step.js";
import {
  buildGcpRelayPlan, cloudSqlPrivateOf, cloudSqlPrivateProblems, cloudSqlRefOfConnectionName, gceRelayStartupScript, gcpOnpremEndpointRows, gcpOnpremGate,
  gcpOnpremRelayPrecheck, gcpRelayFirewalls, gcpRelayName, onpremGcpEndpointRows, prepareOnpremGcpRelayStep, provisionGcpOnpremRelayStep,
  provisionOnpremGcpRelayStep, enableCloudSqlLogicalDecoding, type CloudSqlPrivate,
} from "../src/relay/gcp-relay.js";
import { forwardTarget } from "../src/gitops/replication-delivery.js";
import { deriveSshHostKey, deriveSshKeypair } from "../src/gitops/migration-secrets.js";
import { deriveReplPassword } from "@svc/replication";
import { ensurePlatformEgress } from "../src/relay/platform-egress.js";

// 시험용 가짜 값 (문서용 IP 대역·가짜 프로젝트). 마스터 키는 비밀이 아닌 시험 값
const T = "11111111-1111-4111-8111-111111111111", M = "44444444-4444-4444-8444-444444444444";
const SRC_ENV = "783df2ef-8dbf-4a20-904d-bb02aeb96332";
const PLAT = "198.51.100.7/32", EGRESS = "192.0.2.44", SQL_PRIV = "10.20.0.3", VM_PUB = "203.0.113.60", VM_PRIV = "10.0.0.9";
const MK = "test-master-key-not-a-secret-0123456789";
const PEM = "-----BEGIN CERTIFICATE-----\nMIIBx\n-----END CERTIFICATE-----";
// 사람 입력 없음: 출발 DB 비밀번호 env 가 없다 (워커가 복제 계정을 만든다)
const ENV_OK = { PLATFORM_EGRESS_CIDRS: PLAT, REPL_SECRET_MASTER_KEY: MK, REAL_STS: "1" } as NodeJS.ProcessEnv;
const job = { tenantId: T, migrationId: M };
const mig = { id: M, status: "provisioning" as const, sourceEnvId: SRC_ENV, targetEnvId: randomUUID() };
const facts = (o: Partial<RelayFacts> = {}): RelayFacts => ({
  sourceProvider: "gcp", sourceRegion: null, sourceExternalId: null, targetProvider: "onprem", targetRegion: null, targetExternalId: null,
  sourceAccountId: "src-proj-1", targetAccountId: null,
  postgres: [{ id: "shop-db", db: "shop", user: "shop_app" }], rdsIdentifier: null, cloudSql: { project: "src-proj-1", instance: "shop-db" },
  onpremEgressIp: EGRESS, existing: [], ...o });
const rawSql = (o: Record<string, unknown> = {}) => ({
  region: "asia-northeast3", gceZone: "asia-northeast3-a",
  ipAddresses: [{ type: "PRIVATE", ipAddress: SQL_PRIV }],
  settings: { ipConfiguration: { privateNetwork: "projects/src-proj-1/global/networks/app-vpc", sslMode: "ENCRYPTED_ONLY" },
    databaseFlags: [{ name: "cloudsql.logical_decoding", value: "on" }] },
  serverCaCert: { cert: PEM }, ...o });
const sqlFacts = (): CloudSqlPrivate => cloudSqlPrivateOf({ project: "src-proj-1", instance: "shop-db" }, rawSql());
const SUBNET = "https://www.googleapis.com/compute/v1/projects/src-proj-1/regions/asia-northeast3/subnetworks/app-sub";

/** 가짜 gcloud: VM·방화벽 규칙을 메모리에 둔다. 부른 인자를 남긴다 */
class FakeGcloud {
  calls: string[][] = [];
  fws = new Map<string, { sourceRanges: string[]; description: string; targetTags: string[] }>();
  vms = new Map<string, { labels: Record<string, string>; status: string; target: string; zone: string }>();
  startup: string[] = [];
  users = new Map<string, string>();
  sql: Record<string, unknown> = rawSql();
  patched: string[] = [];
  exec: Exec = async (_cmd, args) => {
    this.calls.push(args);
    const ok = (v: unknown) => ({ code: 0, stdout: JSON.stringify(v), stderr: "", ms: 1 });
    const nf = (what: string) => ({ code: 1, stdout: "", stderr: `ERROR: (gcloud) The resource '${what}' was not found`, ms: 1 });
    const flag = (k: string) => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? "";
    const a = args.join(" ");
    if (a.startsWith("sql instances describe")) return ok(this.sql);
    if (a.startsWith("sql instances patch")) {
      // 진짜처럼: 플래그 목록을 통째 바꾸고 잠깐 재시작 중
      const flags = flag("database-flags").split(",").map((kv) => { const [name, value] = kv.split("="); return { name, value }; });
      const st = this.sql.settings as Record<string, unknown>;
      this.sql = { ...this.sql, state: "MAINTENANCE", settings: { ...st, databaseFlags: flags } };
      this.patched.push(flag("database-flags"));
      return ok({ name: "op-1" }); }
    if (a.startsWith("sql users create")) {
      if (this.users.has(args[3]!)) return { code: 1, stdout: "", stderr: "ERROR: (gcloud.sql.users.create) HTTPError 409: user already exists", ms: 1 };
      this.users.set(args[3]!, flag("password")); return ok({}); }
    if (a.startsWith("sql users set-password")) { this.users.set(args[3]!, flag("password")); return ok({}); }
    if (a.startsWith("sql users delete")) { if (!this.users.delete(args[3]!)) return nf(args[3]!); return ok({}); }
    if (a.startsWith("compute networks subnets list")) return ok([{ selfLink: SUBNET }]);
    if (a.startsWith("compute addresses list")) return ok([{ address: "10.20.0.0", prefixLength: 16, network: "https://www.googleapis.com/compute/v1/projects/src-proj-1/global/networks/app-vpc" },
      { address: "10.99.0.0", prefixLength: 16, network: "https://www.googleapis.com/compute/v1/projects/src-proj-1/global/networks/other" }]);
    if (a.startsWith("compute firewall-rules describe")) { const f = this.fws.get(args[3]!); return f ? ok(f) : nf(args[3]!); }
    if (a.startsWith("compute firewall-rules create")) {
      this.fws.set(args[3]!, { sourceRanges: flag("source-ranges").split(","), description: flag("description"), targetTags: [flag("target-tags")] }); return ok([]); }
    if (a.startsWith("compute firewall-rules update")) { const f = this.fws.get(args[3]!)!; f.sourceRanges = flag("source-ranges").split(","); return ok([]); }
    if (a.startsWith("compute firewall-rules delete")) { this.fws.delete(args[3]!); return ok([]); }
    const inst = (n: string) => { const v = this.vms.get(n)!; return { name: n, status: v.status, labels: v.labels, zone: `projects/src-proj-1/zones/${v.zone}`,
      metadata: { items: [{ key: "svc-relay-target", value: v.target }] }, networkInterfaces: [{ networkIP: VM_PRIV, accessConfigs: [{ natIP: VM_PUB }] }] }; };
    if (a.startsWith("compute instances describe")) return this.vms.has(args[3]!) ? ok(inst(args[3]!)) : nf(args[3]!);
    if (a.startsWith("compute instances create")) {
      const file = flag("metadata-from-file").replace(/^startup-script=/, "");
      this.startup.push(readFileSync(file, "utf8"));
      const labels = Object.fromEntries(flag("labels").split(",").map((kv) => kv.split("=") as [string, string]));
      const target = /svc-relay-target=([^,]+)/.exec(flag("metadata"))![1]!;
      this.vms.set(args[3]!, { labels, status: "RUNNING", target, zone: flag("zone") });
      return ok([inst(args[3]!)]);
    }
    if (a.startsWith("compute instances delete")) { this.vms.delete(args[3]!); return ok([]); }
    if (a.startsWith("compute instances list")) return ok([...this.vms.keys()].filter((n) => this.vms.get(n)!.labels["svc-migration"] === M).map(inst));
    return { code: 2, stdout: "", stderr: `fake gcloud: 모르는 명령 ${a}`, ms: 1 };
  };
}
const borrowWith = (side: "source" | "target") => async <R>(fn: (r: { gcpToken?: Partial<Record<"source" | "target", string>>; denied: { side: string; purpose: string; code: string }[] }) => Promise<R>) =>
  fn({ gcpToken: { [side]: "ya29.fake-token-for-tests" }, denied: [] });

// ── 표·문 ──────────────────────────────────────────────────────────────────────────

test("GCP ↔ 온프레 짝: 표·사는 쪽·빌리는 단계. 진짜 프로젝트 ID 일 때만 진짜 자격으로 본다", () => {
  assert.equal(relayKindOf("gcp", "onprem"), "gcp-onprem");
  assert.equal(relayKindOf("onprem", "gcp"), "onprem-gcp");
  assert.equal(relayHome("gcp-onprem"), "source");
  assert.equal(relayHome("onprem-gcp"), "target");
  assert.equal(relayRoleStep("gcp-onprem"), "relay_gcp");
  assert.equal(relayRoleStep("onprem-gcp"), "relay_gcp_target");
  assert.equal(relayApplies(facts(), ENV_OK), null);
  // 거부: 시드 프로젝트(stub)·REAL_STS=0 은 흉내 자격
  assert.equal(relayApplies(facts({ sourceAccountId: "stub" }), ENV_OK), "source_creds_mock");
  assert.equal(relayApplies(facts(), { ...ENV_OK, REAL_STS: "0" }), "source_creds_mock");
  assert.equal(relayApplies(facts({ sourceProvider: "onprem", targetProvider: "gcp", targetAccountId: "mig-proj-1" }), ENV_OK), null);
});

test("문: pull 모드·온프레 나가는 IP·Cloud SQL·마스터 키·플랫폼 대역이 다 있어야 간다", () => {
  const g = gcpOnpremGate(facts(), ENV_OK);
  assert.equal(g.kind, "go");
  assert.equal(g.kind === "go" && g.relayKind, "gcp-onprem");
  const code = (f: RelayFacts, env: NodeJS.ProcessEnv) => { const x = gcpOnpremGate(f, env); return x.kind === "fail" ? x.failureCode : x.kind === "skip" ? `skip:${x.reason}` : "go"; };
  assert.equal(code(facts({ onpremEgressIp: null }), ENV_OK), "ONPREM_EGRESS_UNKNOWN");
  assert.equal(code(facts({ cloudSql: null }), ENV_OK), "RELAY_SOURCE_DB_UNKNOWN");
  assert.equal(code(facts(), { ...ENV_OK, REPL_SECRET_MASTER_KEY: "short" }), "REPL_SECRET_UNRESOLVED");
  assert.equal(code(facts(), { ...ENV_OK, PLATFORM_EGRESS_CIDRS: "" }), "RELAY_CONFIG_MISSING");
  assert.equal(code(facts(), { ...ENV_OK, ONPREM_FLOOR_VIA_GIT: "0" }), "skip:not_pull_mode");
  assert.equal(code(facts({ postgres: [] }), ENV_OK), "skip:no_postgres");
  assert.equal(code(facts({ targetProvider: "aws" }), ENV_OK), "skip:not_gcp_onprem_relay");
  // 온프레 → GCP 는 Cloud SQL 이 아직 없다 (terraform 이 만든다) → cloudSql 없이 간다
  assert.equal(code(facts({ sourceProvider: "onprem", targetProvider: "gcp", targetAccountId: "mig-proj-1", cloudSql: null }), ENV_OK), "go");
});

// ── Cloud SQL 사실·계획 ────────────────────────────────────────────────────────────────

test("Cloud SQL describe → 사설 IP·VPC·영역·CA·플래그. 사설 IP 없음·논리 디코딩 꺼짐·클라이언트 인증서 요구는 막는다", () => {
  const s = sqlFacts();
  assert.deepEqual([s.privateIp, s.network, s.region, s.zone, s.serverCaPem, s.logicalDecoding, s.clientCertRequired],
    [SQL_PRIV, "projects/src-proj-1/global/networks/app-vpc", "asia-northeast3", "asia-northeast3-a", PEM, true, false]);
  assert.deepEqual(cloudSqlPrivateProblems(s, "source"), []);
  const bad = cloudSqlPrivateOf({ project: "src-proj-1", instance: "x" }, { ipAddresses: [{ type: "PRIMARY", ipAddress: "203.0.113.20" }],
    settings: { ipConfiguration: { sslMode: "TRUSTED_CLIENT_CERTIFICATE_REQUIRED" } } });
  assert.deepEqual(cloudSqlPrivateProblems(bad, "source").map((p) => p.id), ["PC-RELAY-SQL-PRIVATE", "PC-RELAY-SQL-DECODING", "PC-RELAY-SQL-TLS"]);
  // 도착은 논리 디코딩을 안 본다 (구독하는 쪽)
  assert.deepEqual(cloudSqlPrivateProblems({ ...s, logicalDecoding: false }, "target"), []);
  assert.deepEqual(cloudSqlRefOfConnectionName("mig-proj-1:asia-northeast3:shop-db"), { project: "mig-proj-1", instance: "shop-db" });
  assert.equal(cloudSqlRefOfConnectionName("bogus"), null);
});

test("시작 스크립트 = AWS 중계기 user-data + GCE 차이: PermitOpen 은 Cloud SQL 사설 IP, 손님 에이전트가 호스트 키를 안 바꾼다", () => {
  const hostKey = deriveSshHostKey(MK, T, M);
  const s = gceRelayStartupScript({ migrationId: M, dbHost: SQL_PRIV, tunnelPublicKey: deriveSshKeypair(MK, T, M).publicKeyLine, hostKey });
  assert.ok(s.startsWith("#!/bin/bash\n"));
  assert.match(s, new RegExp(`PermitOpen ${SQL_PRIV.replace(/\./g, "\\.")}:5432`));
  assert.match(s, /PermitListen 0\.0\.0\.0:5432/);
  assert.match(s, /set_host_keys = false/);
  assert.match(s, /mkdir -p \/run\/sshd/);
  assert.match(s, new RegExp(`svc-relay-fwd\\.py ${SQL_PRIV.replace(/\./g, "\\.")} 5432 15432`));
  assert.ok(s.indexOf("set_host_keys") < s.indexOf("ssh_host_ed25519_key"), "호스트 키를 쓰기 전에 손님 에이전트를 막는다");
  // 거부: DB 주소에 셸 글자
  assert.throws(() => gceRelayStartupScript({ migrationId: M, dbHost: "10.0.0.1;rm", tunnelPublicKey: deriveSshKeypair(MK, T, M).publicKeyLine, hostKey }));
});

test("방화벽: 22 = 온프레 IP/32 만, 15432 = 플랫폼 대역만, 5432 = 플랫폼 + PSA 대역 (못 읽으면 Cloud SQL 사설 IP/32)", () => {
  const fw = gcpRelayFirewalls({ migrationId: M, onpremEgressIp: EGRESS, platformEgressCidrs: [PLAT], psaRanges: ["10.20.0.0/16"], dbHost: SQL_PRIV });
  assert.deepEqual(fw.map((r) => [r.name, r.port, r.sources]), [
    [`svc-relay-${M}-ssh`, 22, [`${EGRESS}/32`]], [`svc-relay-${M}-entry`, 15432, [PLAT]], [`svc-relay-${M}-pg`, 5432, ["10.20.0.0/16", PLAT]]]);
  const fallback = gcpRelayFirewalls({ migrationId: M, onpremEgressIp: EGRESS, platformEgressCidrs: [PLAT], psaRanges: [], dbHost: SQL_PRIV });
  assert.deepEqual(fallback[2]!.sources, [`${SQL_PRIV}/32`, PLAT]);
  // 거부: 22 를 세상에 열 수 없다
  assert.throws(() => gcpRelayFirewalls({ migrationId: M, onpremEgressIp: "0.0.0.0/0", platformEgressCidrs: [PLAT], psaRanges: [], dbHost: SQL_PRIV }), /IPv4/);
  assert.throws(() => gcpRelayFirewalls({ migrationId: M, onpremEgressIp: EGRESS, platformEgressCidrs: ["0.0.0.0/0"], psaRanges: [], dbHost: SQL_PRIV }), /플랫폼/);
});

test("계획: 공유 VPC(네트워크가 다른 프로젝트)는 아직 거부", () => {
  const base = { kind: "gcp-onprem" as const, migrationId: M, subnetUrl: SUBNET, psaRanges: [], onpremEgressIp: EGRESS, platformEgressCidrs: [PLAT],
    tunnelPublicKey: deriveSshKeypair(MK, T, M).publicKeyLine, hostKey: deriveSshHostKey(MK, T, M) };
  const p = buildGcpRelayPlan({ ...base, sql: sqlFacts() });
  assert.deepEqual([p.project, p.zone, p.instanceName, p.networkTag, p.dbHost], ["src-proj-1", "asia-northeast3-a", gcpRelayName(M), gcpRelayName(M), SQL_PRIV]);
  assert.throws(() => buildGcpRelayPlan({ ...base, sql: { ...sqlFacts(), network: "projects/host-proj-1/global/networks/shared" } }), /공유 VPC/);
});

// ── 끝점 두 줄 ─────────────────────────────────────────────────────────────────────

test("끝점 두 줄 (gcp-onprem): 출발 = 중계 입구 :15432 + 사설 IP 는 tls_servername (터널 목적지), 도착 = 온프레 CNPG 중계기 칸", () => {
  const [s, t] = gcpOnpremEndpointRows({ tenantId: T, migrationId: M, sourceEnvId: SRC_ENV, sql: sqlFacts(), db: "shop", appUser: "shop_app",
    publicIp: VM_PUB, privateIp: VM_PRIV, knownHosts: `${VM_PUB} ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFake`, existing: [] });
  for (const r of [s, t]) ReplicationEndpoint.parse(r);
  assert.deepEqual([s.side, s.provider, s.host, s.port, s.username, s.passwordRef, s.sslmode, s.tlsServername, s.caPem, s.peerHost],
    ["source", "cloudsql", VM_PUB, 15432, "svc_repl_44444444", "derive:cloudsql_repl", "verify-ca", SQL_PRIV, PEM, null]);
  assert.deepEqual([t.side, t.provider, t.host, t.port, t.username, t.passwordRef, t.peerHost, t.relayHost], ["target", "cnpg", VM_PUB, 5432, "svc_migrate", "derive:migrate", VM_PRIV, VM_PUB]);
  // 온프레 터널 정방향 목적지 = 중계 sshd PermitOpen 과 같은 값
  assert.equal(forwardTarget(s), `${SQL_PRIV}:5432`);
});

test("끝점 두 줄 (onprem-gcp): 출발 = 온프레 CNPG 중계기 칸, 도착 = 중계 입구 + tf:db_admin_password. 관리자 계정이 없으면 거부", () => {
  const sql = { ...sqlFacts(), project: "mig-proj-1" };
  const out = { db_admin_username: "svc_admin", db_username: "shop_app", db_name: "shop", db_private_ip: SQL_PRIV };
  const [s, t] = onpremGcpEndpointRows({ tenantId: T, migrationId: M, sql, out, db: "shop", appUser: "shop_app",
    publicIp: VM_PUB, privateIp: VM_PRIV, knownHosts: `${VM_PUB} ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFake`, existing: [] });
  for (const r of [s, t]) ReplicationEndpoint.parse(r);
  assert.deepEqual([s.side, s.provider, s.host, s.port, s.peerHost, s.relayHost], ["source", "cnpg", VM_PUB, 5432, VM_PRIV, VM_PUB]);
  assert.deepEqual([t.side, t.provider, t.host, t.port, t.username, t.passwordRef, t.appRole, t.tlsServername, t.sslmode],
    ["target", "cloudsql", VM_PUB, 15432, "svc_admin", "tf:db_admin_password", "shop_app", SQL_PRIV, "verify-ca"]);
  assert.equal(forwardTarget(t), `${SQL_PRIV}:5432`);
  assert.throws(() => onpremGcpEndpointRows({ tenantId: T, migrationId: M, sql, out: { db_private_ip: SQL_PRIV }, db: "shop", appUser: "shop_app",
    publicIp: VM_PUB, privateIp: VM_PRIV, knownHosts: "x", existing: [] }), /db_admin_username/);
});

// ── 만들기·지우기 ───────────────────────────────────────────────────────────────────

test("만들기 (gcp-onprem): 방화벽 셋 → VM, 끝점 두 줄. 다시 부르면 그대로 쓰고, 정리는 VM·방화벽을 지운다 (남의 규칙은 안 건드림)", async () => {
  const f = new FakeGcloud();
  const saved: ReplicationEndpoint[][] = [];
  const deps = { env: ENV_OK, facts: facts(), exec: f.exec, borrow: borrowWith("source"), readSource: async () => sqlFacts(), existing: [],
    save: async (r: ReplicationEndpoint[]) => { saved.push(r); } };
  const ok = await provisionGcpOnpremRelayStep(job, mig, deps);
  assert.equal(ok.kind, "ok", JSON.stringify(ok));
  const d = ok.kind === "ok" ? ok.detail : {};
  assert.deepEqual([d.kind, d.project, d.zone, d.publicIp, d.privateIp, d.sourceTls], ["gcp-onprem", "src-proj-1", "asia-northeast3-a", VM_PUB, VM_PRIV, "verify-ca"]);
  assert.deepEqual(d.created, [`svc-relay-${M}-ssh`, `svc-relay-${M}-entry`, `svc-relay-${M}-pg`, `svc-relay-${M}`]);
  // 출발 복제 계정: 워커가 만들고, 비밀번호 = 줄의 derive 참조를 푼 값 (사람 입력 없음)
  assert.equal(d.replUser, "svc_repl_44444444:created");
  assert.equal(f.users.get("svc_repl_44444444"), deriveReplPassword(MK, { tenantId: T, migrationId: M, side: "source" }, "cloudsql_repl"));
  assert.ok(!JSON.stringify(d).includes(f.users.get("svc_repl_44444444")!), "감사 detail 에 비밀번호 없음");
  assert.deepEqual(f.fws.get(`svc-relay-${M}-pg`)!.sourceRanges, ["10.20.0.0/16", PLAT], "다른 VPC 의 PSA 대역은 안 넣는다");
  assert.deepEqual(saved[0]!.map((r) => `${r.side}:${r.provider}:${r.port}`), ["source:cloudsql:15432", "target:cnpg:5432"]);
  assert.ok(f.startup[0]!.includes("BEGIN OPENSSH PRIVATE KEY"), "파생 호스트 키는 시작 스크립트 파일로만");
  assert.ok(f.calls.every((c) => !c.join(" ").includes("OPENSSH PRIVATE")), "gcloud 인자에는 개인 키가 없다");
  assert.ok(!JSON.stringify(saved).includes(MK), "줄에 비밀 없음");
  // 다시 부르면 만들지 않는다 (복제 계정은 비밀번호만 맞춤)
  const again = await provisionGcpOnpremRelayStep(job, mig, deps);
  assert.equal(again.kind === "ok" && (again.detail.created as string[]).length, 0);
  assert.equal(again.kind === "ok" && again.detail.replUser, "svc_repl_44444444:updated");
  // 남의 방화벽 규칙(같은 이름, 다른 설명)은 정리가 건드리지 않는다
  f.fws.set(`svc-relay-${M}-ssh`, { sourceRanges: ["0.0.0.0/0"], description: "someone else", targetTags: [] });
  const down = await teardownRelayStep(job, mig, { env: ENV_OK, facts: facts(), borrowGcp: borrowWith("source"), gcpExec: f.exec });
  assert.equal(down.kind, "ok", JSON.stringify(down));
  assert.deepEqual(down.kind === "ok" && down.detail.removed, [`svc-relay-${M}`, `svc-relay-${M}-entry`, `svc-relay-${M}-pg`]);
  assert.equal(down.kind === "ok" && down.detail.replUser, "removed");
  assert.equal(f.users.size, 0);
  assert.deepEqual([...f.fws.keys()], [`svc-relay-${M}-ssh`]);
  assert.equal(f.vms.size, 0);
});

test("만들기 거부: 운영자 env 참조 줄인데 env 없음 → 아무것도 안 부름, 실행 토큰 없음 → RELAY_ROLE_DENIED, 출발 Cloud SQL 이 공개 IP 만 → 막음", async () => {
  const f = new FakeGcloud();
  const base = { facts: facts(), exec: f.exec, readSource: async () => sqlFacts(), existing: [], save: async () => {} };
  const [opRow] = gcpOnpremEndpointRows({ tenantId: T, migrationId: M, sourceEnvId: SRC_ENV, sql: sqlFacts(), db: "shop", appUser: "shop_app",
    publicIp: VM_PUB, privateIp: VM_PRIV, knownHosts: `${VM_PUB} ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFake`, existing: [] });
  const envRow = { ...opRow, username: "postgres", passwordRef: "env:REPL_SECRET_SRC_783DF2EF" };
  const noSecret = await provisionGcpOnpremRelayStep(job, mig, { ...base, facts: facts({ existing: [envRow] }), env: ENV_OK, borrow: borrowWith("source") });
  assert.equal(noSecret.kind === "failed" && noSecret.failureCode, "REPL_SECRET_UNRESOLVED");
  assert.equal(f.calls.length, 0);
  // 운영자 줄이 있고 env 도 있으면 복제 계정을 만들지 않고 그 계정을 쓴다
  const opOk = await provisionGcpOnpremRelayStep(job, mig, { ...base, facts: facts({ existing: [envRow] }), existing: [envRow],
    env: { ...ENV_OK, REPL_SECRET_SRC_783DF2EF: "fake-src-password" }, borrow: borrowWith("source") });
  assert.equal(opOk.kind, "ok", JSON.stringify(opOk));
  assert.equal(f.users.size, 0);
  f.vms.clear(); f.fws.clear(); f.calls = [];
  const noToken = await provisionGcpOnpremRelayStep(job, mig, { ...base, env: ENV_OK, borrow: borrowWith("target") });
  assert.equal(noToken.kind === "failed" && noToken.failureCode, "RELAY_ROLE_DENIED");
  const publicOnly = await provisionGcpOnpremRelayStep(job, mig, { ...base, env: ENV_OK, borrow: borrowWith("source"),
    readSource: async () => cloudSqlPrivateOf({ project: "src-proj-1", instance: "shop-db" }, rawSql({ ipAddresses: [{ type: "PRIMARY", ipAddress: "203.0.113.20" }] })) });
  assert.equal(publicOnly.kind === "failed" && publicOnly.failureCode, "RELAY_SOURCE_DB_UNKNOWN");
  assert.equal(f.vms.size + f.fws.size, 0, "막히면 자원을 만들지 않는다");
});

test("만들기 (onprem-gcp): terraform 뒤 도착 Cloud SQL VPC 에 중계기 + 끝점 + 앱 로그인 역할. 비밀번호 파일이 없으면 안 빌림", async () => {
  const root = mkdtempSync(join(tmpdir(), "onprem-gcp-"));
  const env = { ...ENV_OK, TF_WORK_DIR: root } as NodeJS.ProcessEnv;
  const of = facts({ sourceProvider: "onprem", targetProvider: "gcp", targetAccountId: "mig-proj-1", cloudSql: null });
  const g = await prepareOnpremGcpRelayStep(job, mig, { env, facts: of });
  assert.equal(g?.kind, "go");
  assert.equal(await prepareOnpremGcpRelayStep(job, mig, { env, facts: facts() }), null, "다른 짝이면 null");
  const f = new FakeGcloud();
  f.sql = rawSql({ settings: { ipConfiguration: { privateNetwork: "projects/mig-proj-1/global/networks/env-vpc" }, databaseFlags: [] } });
  const out = { db_connection_name: "mig-proj-1:asia-northeast3:shop-db", db_private_ip: SQL_PRIV, db_admin_username: "svc_admin", db_username: "shop_app", db_name: "shop" };
  let borrowed = 0;
  const go = g as Extract<NonNullable<typeof g>, { kind: "go" }>;
  const noSecret = await provisionOnpremGcpRelayStep(job, mig, go, out, { env, exec: f.exec, borrow: async (fn) => { borrowed++; return borrowWith("target")(fn); } });
  assert.equal(noSecret.kind === "failed" && noSecret.failureCode, "RELAY_TARGET_DB_UNKNOWN");
  assert.equal(borrowed + f.calls.length, 0);
  mkdirSync(join(root, M), { recursive: true });
  writeFileSync(join(root, M, "db-secret.json"), JSON.stringify({ db_password: "fake-app", db_admin_password: "fake-admin" }), { mode: 0o600 });
  const saved: ReplicationEndpoint[][] = [];
  const logins: string[] = [];
  const ok = await provisionOnpremGcpRelayStep(job, mig, go, out, { env, exec: f.exec, borrow: borrowWith("target"), existing: [],
    save: async (r) => { saved.push(r); }, appLogin: async (t) => { logins.push(`${t.host}:${t.port}:${t.appRole}`); return "created"; } });
  assert.equal(ok.kind, "ok", JSON.stringify(ok));
  const d = ok.kind === "ok" ? ok.detail : {};
  assert.deepEqual([d.kind, d.project, d.appLogin, d.targetTls], ["onprem-gcp", "mig-proj-1", "created", "verify-ca"]);
  assert.deepEqual(saved[0]!.map((r) => `${r.side}:${r.provider}:${r.port}`), ["source:cnpg:5432", "target:cloudsql:15432"]);
  assert.deepEqual(logins, [`${VM_PUB}:15432:shop_app`]);
  assert.ok(f.calls.some((c) => c.join(" ").startsWith("compute instances create") && c.includes("--project=mig-proj-1")));
  assert.ok(!JSON.stringify(d).includes("fake-admin") && !JSON.stringify(saved).includes("fake-admin"), "감사 detail·줄에 비밀 없음");
  // 정리: 도착 이전 전용 프로젝트에서 지운다
  const down = await teardownRelayStep(job, mig, { env, facts: of, borrowGcp: borrowWith("target"), gcpExec: f.exec });
  assert.equal(down.kind === "ok" && down.detail.project, "mig-proj-1");
  assert.equal(f.vms.size + f.fws.size, 0);
  rmSync(root, { recursive: true, force: true });
});

test("사전 점검 (gcp-onprem): 출발 Cloud SQL 이 사설 IP·논리 디코딩이 없으면 막고, 다른 짝은 아무것도 안 낸다", async () => {
  const f = new FakeGcloud();
  f.sql = rawSql({ ipAddresses: [], settings: { ipConfiguration: {}, databaseFlags: [] } });
  const items = await gcpOnpremRelayPrecheck(job, mig, { gcpToken: { source: "ya29.fake-token-for-tests" } }, ENV_OK, { facts: facts(), exec: f.exec });
  // 논리 디코딩은 apply 가 자동으로 켠다 → 알림(warn). 자동을 끈 배포만 막는다
  assert.deepEqual(items.map((i) => `${i.id}:${i.level}`), ["PC-RELAY-SQL-PRIVATE:block", "PC-RELAY-SQL-DECODING:warn"]);
  const off = await gcpOnpremRelayPrecheck(job, mig, { gcpToken: { source: "ya29.fake-token-for-tests" } }, { ...ENV_OK, RELAY_AUTO_DB_FLAGS: "0" }, { facts: facts(), exec: f.exec });
  assert.deepEqual(off.map((i) => `${i.id}:${i.level}`), ["PC-RELAY-SQL-PRIVATE:block", "PC-RELAY-SQL-DECODING:block"]);
  f.sql = rawSql();
  assert.deepEqual(await gcpOnpremRelayPrecheck(job, mig, { gcpToken: { source: "ya29.fake-token-for-tests" } }, ENV_OK, { facts: facts(), exec: f.exec }), []);
  assert.deepEqual(await gcpOnpremRelayPrecheck(job, mig, undefined, ENV_OK, { facts: facts({ targetProvider: "aws" }) }), []);
  const noEgress = await gcpOnpremRelayPrecheck(job, mig, undefined, ENV_OK, { facts: facts({ onpremEgressIp: null }) });
  assert.deepEqual(noEgress.map((i) => i.id), ["PC-RELAY-GCP-ONPREM"]);
});

test("플랫폼 나가는 IP: 비어 있으면 알아내 /32 로, 운영자 값·끔은 그대로, 이상한 응답은 실패", async () => {
  const env: NodeJS.ProcessEnv = {};
  assert.deepEqual(await ensurePlatformEgress(env, async () => "198.51.100.23\n"), { kind: "set", cidr: "198.51.100.23/32" });
  assert.equal(env.PLATFORM_EGRESS_CIDRS, "198.51.100.23/32");
  assert.deepEqual(await ensurePlatformEgress({ PLATFORM_EGRESS_CIDRS: PLAT }, async () => { throw new Error("부르면 안 됨"); }), { kind: "kept" });
  assert.deepEqual(await ensurePlatformEgress({ PLATFORM_EGRESS_AUTO: "0" }, async () => { throw new Error("부르면 안 됨"); }), { kind: "off" });
  const bad: NodeJS.ProcessEnv = {};
  assert.equal((await ensurePlatformEgress(bad, async () => "<html>")).kind, "failed");
  assert.equal(bad.PLATFORM_EGRESS_CIDRS, undefined);
});

test("연결 스크립트: 두 프로젝트 모두 svc-operate 에 중계기 역할, 역할 파일에 gcp-relay.ts 가 부르는 권한이 있다", () => {
  const sh = readFileSync(new URL("../../../infra/onboarding/gcp-connect.sh", import.meta.url), "utf8");
  assert.equal(sh.match(/ensure_project_binding "\$\{OPERATE_SA\}" "projects\/\$\{P\}\/roles\/platform_relay"/g)?.length, 2);
  const perms = readFileSync(new URL("../../../infra/permissions/gcp-relay-custom-role.yaml", import.meta.url), "utf8").split("\n").filter((l) => l.startsWith("- ")).map((l) => l.slice(2));
  for (const p of ["compute.instances.create", "compute.instances.delete", "compute.firewalls.create", "compute.firewalls.delete", "compute.subnetworks.use",
    "compute.subnetworks.useExternalIp", "compute.networks.updatePolicy", "compute.globalAddresses.list", "cloudsql.users.create", "cloudsql.users.delete", "cloudsql.instances.get",
    "cloudsql.instances.update"])
    assert.ok(perms.includes(p), p);
  // 거부: IAM 정책 바꾸기·Cloud SQL 인스턴스 지우기는 없다 (update 는 논리 디코딩 플래그 켜기용)
  assert.ok(!perms.some((p) => p.endsWith(".setIamPolicy") || p === "cloudsql.instances.delete"));
});

test("출발 논리 디코딩 꺼짐: 만들기가 지금 플래그를 지키며 켜고 재시작을 기다린다. 끈 배포는 막고, 쉼표 값은 덮어쓰지 않는다", async () => {
  const off = () => rawSql({ settings: { ipConfiguration: { privateNetwork: "projects/src-proj-1/global/networks/app-vpc", sslMode: "ENCRYPTED_ONLY" },
    databaseFlags: [{ name: "max_connections", value: "200" }, { name: "cloudsql.logical_decoding", value: "off" }] } });
  const f = new FakeGcloud();
  f.sql = off();
  let waits = 0;
  // 두 번째 읽기에서 재시작이 끝난다
  const sleep = async () => { waits++; f.sql = { ...f.sql, state: "RUNNABLE" }; };
  const ref = { project: "src-proj-1", instance: "shop-db" };
  const base = { facts: facts(), exec: f.exec, borrow: borrowWith("source"), existing: [], save: async () => {}, flagWait: { sleep },
    readSource: async () => cloudSqlPrivateOf(ref, f.sql) };
  const ok = await provisionGcpOnpremRelayStep(job, mig, { ...base, env: ENV_OK });
  assert.equal(ok.kind, "ok", JSON.stringify(ok));
  assert.equal(ok.kind === "ok" && ok.detail.logicalDecoding, "enabled");
  assert.deepEqual(f.patched, ["max_connections=200,cloudsql.logical_decoding=on"], "다른 플래그는 그대로 같이 준다");
  assert.ok(f.calls.some((c) => c[2] === "patch" && c.includes("--async")));
  assert.equal(waits, 1);
  // 이미 켜져 있으면 patch 하지 않는다
  const again = await provisionGcpOnpremRelayStep(job, mig, { ...base, env: ENV_OK });
  assert.equal(again.kind === "ok" && again.detail.logicalDecoding, undefined);
  assert.equal(f.patched.length, 1);
  // 거부: 자동을 끈 배포는 patch 없이 막는다
  const g2 = new FakeGcloud(); g2.sql = off();
  const no = await provisionGcpOnpremRelayStep(job, mig, { ...base, exec: g2.exec, readSource: async () => cloudSqlPrivateOf(ref, g2.sql), env: { ...ENV_OK, RELAY_AUTO_DB_FLAGS: "0" } });
  assert.equal(no.kind === "failed" && no.failureCode, "RELAY_SOURCE_DB_UNKNOWN");
  assert.equal(g2.patched.length + g2.vms.size, 0);
  // 거부: 다른 플래그 값에 쉼표가 있으면 목록을 깨뜨리므로 안 건드린다
  const g3 = new FakeGcloud();
  const comma: CloudSqlPrivate = { ...cloudSqlPrivateOf(ref, off()), flags: [{ name: "search_path", value: "a,b" }] };
  await assert.rejects(enableCloudSqlLogicalDecoding({ env: {}, exec: g3.exec }, comma, { sleep }), /쉼표/);
  assert.equal(g3.patched.length, 0);
  // 거부: 시간 안에 안 켜지면 멈춘다
  const g4 = new FakeGcloud(); g4.sql = off();
  await assert.rejects(enableCloudSqlLogicalDecoding({ env: {}, exec: g4.exec }, cloudSqlPrivateOf(ref, g4.sql), { sleep: async () => {}, maxWaitMs: 0 }), /시간 안에/);
});
