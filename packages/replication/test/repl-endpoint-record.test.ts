// DECISION(team): 끝점은 이전마다 DB 행으로 (2026-11-05, 보안·온프레 영역)
// password_ref 문법·유도, 줄 → Endpoint(접속 문자열·peerUrl·TLS), 줄로 Migration 만들기, TCP 도달 확인 (DB 없이)
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import {
  parsePasswordRef, deriveReplPassword, resolvePasswordRef, endpointFromRecord, replicationFromRecords, ReplConfigError,
  clientConfig, peerTlsProblem, peerPathProblem, workerTlsProblem, endpointAddress, tcpReachProblem, sourceLinkRoleOf, type EndpointRecord,
} from "../src/index.js";

const T = "11111111-1111-4111-8111-111111111111", M = "22222222-2222-4222-8222-222222222222";
const MASTER = "test-master-key-0123456789abcdef-xyz";   // 시험용 가짜 키 (36자)
const scope = { tenantId: T, migrationId: M, side: "source" as const };
const PEM = "-----BEGIN CERTIFICATE-----\nMIIBfake\n-----END CERTIFICATE-----\n";
const rec = (o: Partial<EndpointRecord> = {}): EndpointRecord => ({
  tenantId: T, migrationId: M, side: "source", label: "src", provider: "postgres", host: "db.internal", port: 5432, dbname: "shop",
  username: "admin", passwordRef: "derive:admin", peerHost: null, peerPort: null, appRole: "shop_app", fenceRoles: [], schemaName: null,
  sslmode: null, tlsServername: null, caPem: null, ...o,
});

test("derive: 같은 입력이면 같은 값 (고정 벡터), 쪽·용도가 다르면 다른 값, base64url 32자", () => {
  const v = deriveReplPassword(MASTER, scope, "admin");
  // 기대값은 node:crypto 로 따로 계산 (HMAC-SHA256 base64url 앞 32자)
  assert.equal(v, "Yvg8jbwu4wVH1KrSUpw1NTG07_O0fy1G");
  assert.match(v, /^[A-Za-z0-9_-]{32}$/);
  assert.notEqual(deriveReplPassword(MASTER, { ...scope, side: "target" }, "admin"), v);
  assert.notEqual(deriveReplPassword(MASTER, scope, "repl"), v);
  assert.equal(resolvePasswordRef("derive:admin", scope, { REPL_SECRET_MASTER_KEY: MASTER }), v);
});

test("derive 거부: 마스터 키가 없거나 32자 미만이면 분명한 오류", () => {
  assert.throws(() => resolvePasswordRef("derive:admin", scope, {}), /REPL_SECRET_MASTER_KEY 가 없다/);
  assert.throws(() => resolvePasswordRef("derive:admin", scope, { REPL_SECRET_MASTER_KEY: "short" }), /32자 이상/);
});

test("env: 참조는 REPL_SECRET_* 만. env:DATABASE_URL·진짜 비밀번호 글자는 거부하고 오류에 값을 안 싣는다", () => {
  assert.deepEqual(parsePasswordRef("env:REPL_SECRET_SRC_PW"), { kind: "env", name: "REPL_SECRET_SRC_PW" });
  assert.equal(resolvePasswordRef("env:REPL_SECRET_SRC_PW", scope, { REPL_SECRET_SRC_PW: "pw-1" }), "pw-1");
  assert.throws(() => resolvePasswordRef("env:DATABASE_URL", scope, { DATABASE_URL: "postgres://secret" }), /REPL_SECRET_/);
  assert.throws(() => parsePasswordRef("env:repl_secret_x"), /REPL_SECRET_/);
  assert.throws(() => resolvePasswordRef("env:REPL_SECRET_MISSING", scope, {}), /없거나 비었다/);
  try { parsePasswordRef("hunter2-real-password"); assert.fail("거부해야 한다"); }
  catch (e) { assert.doesNotMatch((e as Error).message, /hunter2/); }
});

test("줄 → Endpoint: 계정·비밀번호 URL 인코딩, peerUrl(peer_host + sslmode=require), TLS 문제 없음", () => {
  const env = { REPL_SECRET_SRC_PW: "p@ss:w/rd?#%" };
  const e = endpointFromRecord(rec({ username: "repl@admin", passwordRef: "env:REPL_SECRET_SRC_PW", peerHost: "10.0.0.5", peerPort: 6432,
    sslmode: "verify-full", caPem: PEM, tlsServername: "db.example.com", fenceRoles: ["batch"], schemaName: "app" }), env);
  const u = new URL(e.adminUrl);
  assert.equal(decodeURIComponent(u.username), "repl@admin");
  assert.equal(decodeURIComponent(u.password), "p@ss:w/rd?#%");
  assert.equal(u.hostname, "db.internal"); assert.equal(u.port, "5432"); assert.equal(u.pathname, "/shop");
  const p = new URL(e.peerUrl!);
  assert.equal(p.hostname, "10.0.0.5"); assert.equal(p.port, "6432"); assert.equal(p.searchParams.get("sslmode"), "require");
  assert.equal(decodeURIComponent(p.password), "p@ss:w/rd?#%");
  assert.equal(e.origin, "db"); assert.deepEqual(e.fenceRoles, ["batch"]); assert.equal(e.schema, "app");
  assert.deepEqual(e.tls, { mode: "verify-full", caPem: PEM, servername: "db.example.com" });
  assert.equal(peerTlsProblem(e), null);
  assert.equal(workerTlsProblem(e), null);
  assert.deepEqual(endpointAddress(e), { host: "db.internal", port: 5432 });
});

test("줄 → Endpoint: sslmode 없으면 TLS·peerUrl 없음 (예전 평문 꼴), 공개 peer 는 peerPathProblem 이 잡는다", () => {
  const plain = endpointFromRecord(rec(), { REPL_SECRET_MASTER_KEY: MASTER });
  assert.equal(plain.tls, undefined); assert.equal(plain.peerUrl, undefined);
  const pub = endpointFromRecord(rec({ peerHost: "34.1.2.3" }), { REPL_SECRET_MASTER_KEY: MASTER });
  assert.match(peerPathProblem(pub, { ...pub, provider: "cloudsql" }) ?? "", /34\.1\.2\.3/);
  // IPv6 주소는 대괄호로 감싼다
  assert.equal(endpointAddress(endpointFromRecord(rec({ host: "fd00::5" }), { REPL_SECRET_MASTER_KEY: MASTER })).host, "fd00::5");
});

test("clientConfig: ca_pem·tls_servername 이 pg ssl 객체(ca·servername)로 간다. ca 없이 verify-full 은 거부", () => {
  const e = endpointFromRecord(rec({ host: "10.9.8.7", sslmode: "verify-full", caPem: PEM, tlsServername: "db.example.com" }),
    { REPL_SECRET_MASTER_KEY: MASTER });
  const cfg = clientConfig(e, {});
  const ssl = cfg.ssl as { ca?: string; servername?: string; rejectUnauthorized?: boolean };
  assert.equal(ssl.ca, PEM); assert.equal(ssl.servername, "db.example.com"); assert.equal(ssl.rejectUnauthorized, true);
  assert.doesNotMatch(String(cfg.connectionString), /sslmode/);
  // ca_pem 이 없고 REPL_CA_FILE 도 없으면 예전처럼 거부
  const noCa = endpointFromRecord(rec({ sslmode: "verify-full" }), { REPL_SECRET_MASTER_KEY: MASTER });
  assert.throws(() => clientConfig(noCa, {}), /CA 파일\(REPL_CA_FILE\) 또는 ca_pem/);
  // ca_pem 이 없으면 공용 CA 묶음 REPL_CA_FILE 을 쓴다
  assert.equal(endpointFromRecord(rec({ sslmode: "verify-ca" }), { REPL_SECRET_MASTER_KEY: MASTER, REPL_CA_FILE: "/x/ca.pem" }).tls?.caFile, "/x/ca.pem");
});

test("replicationFromRecords: 두 줄 → 줄 끝점(출발 울타리에 링크 계정), 줄 없음 → null, 조절값은 env", () => {
  const env = { REPL_SECRET_MASTER_KEY: MASTER, REPL_TABLES: "orders, customers" };
  assert.equal(replicationFromRecords(M, [], env), null);
  const m = replicationFromRecords(M, [rec(), rec({ side: "target", label: "dst", host: "dst.internal" })], env)!;
  assert.equal(m.cfg.source.origin, "db"); assert.equal(m.cfg.target.origin, "db");
  assert.equal(new URL(m.cfg.target.adminUrl).hostname, "dst.internal");
  assert.ok(m.cfg.source.fenceRoles?.includes(sourceLinkRoleOf(M)));
  assert.deepEqual(m.cfg.tables, ["orders", "customers"]);
  // 쪽마다 비밀번호가 다르다 (같은 derive:admin 이어도 side 가 글에 들어간다)
  assert.notEqual(new URL(m.cfg.source.adminUrl).password, new URL(m.cfg.target.adminUrl).password);
});

test("replicationFromRecords 거부: 한쪽만 → REPL_ENDPOINT_INCOMPLETE, 다른 이전 줄 → 거부, 비밀 못 풂 → REPL_SECRET_UNRESOLVED", () => {
  const code = (fn: () => unknown) => { try { fn(); return "none"; } catch (e) { assert.ok(e instanceof ReplConfigError); return e.code; } };
  assert.equal(code(() => replicationFromRecords(M, [rec()], { REPL_SECRET_MASTER_KEY: MASTER })), "REPL_ENDPOINT_INCOMPLETE");
  assert.equal(code(() => replicationFromRecords(M, [rec(), rec({ side: "target", migrationId: T })], { REPL_SECRET_MASTER_KEY: MASTER })), "REPL_ENDPOINT_INCOMPLETE");
  assert.equal(code(() => replicationFromRecords(M, [rec(), rec({ side: "target" })], {})), "REPL_SECRET_UNRESOLVED");
});

test("tcpReachProblem: 열린 포트는 null, 닫힌 포트는 이유 글자", async () => {
  const srv = createServer((s) => s.destroy());
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as { port: number }).port;
  assert.equal(await tcpReachProblem("127.0.0.1", port, 2000), null);
  await new Promise<void>((r) => srv.close(() => r()));
  assert.ok(await tcpReachProblem("127.0.0.1", port, 2000));
});

// 출발 RDS 관리 비밀 (aws-sm:). 이 패키지는 클라우드를 안 부른다: 워커가 미리 읽은 Map 에서 꺼내기만
const SM_ARN = "arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:rds!db-0a1b2c3d-AbCdEf";
test("aws-sm: RDS 관리 비밀 ARN 만 받고, 워커가 읽어 둔 값(Map)으로 풀린다", () => {
  assert.deepEqual(parsePasswordRef(`aws-sm:${SM_ARN}`), { kind: "aws-sm", arn: SM_ARN });
  assert.equal(resolvePasswordRef(`aws-sm:${SM_ARN}`, scope, {}, new Map([[SM_ARN, "pw-sm"]])), "pw-sm");
  const e = endpointFromRecord(rec({ provider: "rds", passwordRef: `aws-sm:${SM_ARN}`, peerHost: "10.0.0.5" }), {}, new Map([[SM_ARN, "pw-sm"]]));
  assert.match(e.adminUrl, /:pw-sm@/);
  // 관리 비밀(마스터 비밀번호)은 구독 접속 문자열에 넣지 않는다 → 이 끝점은 늘 전용 복제 계정
  assert.equal(e.ephemeralPeerUser, true);
  assert.equal(endpointFromRecord(rec(), { REPL_SECRET_MASTER_KEY: MASTER }).ephemeralPeerUser, undefined);
});

test("거부: 다른 비밀·Aurora 클러스터 비밀은 문법 오류, 워커가 못 읽어 온 값이면 REPL_SECRET_UNRESOLVED (값 없음)", () => {
  for (const bad of ["aws-sm:arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:prod/app-AbCdEf",
    "aws-sm:arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:rds!cluster-x", "aws-sm:*"])
    assert.throws(() => parsePasswordRef(bad), /RDS 관리 비밀 ARN/, bad);
  assert.throws(() => resolvePasswordRef(`aws-sm:${SM_ARN}`, scope, {}), /읽어 오지 못했다/);
  const recs = [rec({ provider: "rds", passwordRef: `aws-sm:${SM_ARN}` }), rec({ side: "target", label: "dst" })];
  assert.throws(() => replicationFromRecords(M, recs, { REPL_SECRET_MASTER_KEY: MASTER }),
    (e: unknown) => e instanceof ReplConfigError && e.code === "REPL_SECRET_UNRESOLVED" && !e.message.includes("pw-sm"));
  assert.ok(replicationFromRecords(M, recs, { REPL_SECRET_MASTER_KEY: MASTER }, new Map([[SM_ARN, "pw-sm"]])));
});

// 도착 클라우드 DB 관리자 (tf:). 실행기가 이전 작업 폴더 db-secret.json(0600)에 둔 값을 {tf:키} 와 같은 폴더 규칙으로 읽는다
test("tf: _password 키만 받고 이전 작업 폴더 db-secret.json 에서 풀린다. 다른 키·없는 값은 거부 (오류에 값 없음)", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = mkdtempSync(join(tmpdir(), "tf-ref-"));
  mkdirSync(join(root, "t-11111111", M), { recursive: true });
  writeFileSync(join(root, "t-11111111", M, "outputs.json"), JSON.stringify({ db_admin_username: "svc_admin_0123456789", db_address: "10.0.0.9" }));
  writeFileSync(join(root, "t-11111111", M, "db-secret.json"), JSON.stringify({ db_password: "app-pw", db_admin_password: "adm-pw" }), { mode: 0o600 });
  const env = { TF_WORK_DIR: root };
  assert.deepEqual(parsePasswordRef("tf:db_admin_password"), { kind: "tf", key: "db_admin_password" });
  assert.equal(resolvePasswordRef("tf:db_admin_password", { ...scope, side: "target" }, env), "adm-pw");
  for (const bad of ["tf:db_address", "tf:db_admin_username", "tf:", "tf:../x_password"]) assert.throws(() => parsePasswordRef(bad), /tf:|문법/, bad);
  assert.throws(() => resolvePasswordRef("tf:db_admin_password", { ...scope, migrationId: "33333333-3333-4333-8333-333333333333" }, env), /db-secret\.json/);
  const e = endpointFromRecord(rec({ side: "target", provider: "cloudsql", username: "svc_admin_0123456789", passwordRef: "tf:db_admin_password",
    host: "34.64.1.2", peerHost: "10.0.1.20", peerPort: 5432, sslmode: "verify-ca", caPem: PEM }), env);
  assert.ok(e.adminUrl.startsWith("postgres://svc_admin_0123456789:adm-pw@34.64.1.2:5432/shop"));
  assert.ok(e.peerUrl!.startsWith("postgres://svc_admin_0123456789:adm-pw@10.0.1.20:5432/shop?sslmode=require"));
  assert.equal(e.tls?.mode, "verify-ca");
});
