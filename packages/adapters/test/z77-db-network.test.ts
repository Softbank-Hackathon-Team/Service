// Z77: 데모 DB 네트워크 변수 (DB_PUBLIC·DB_PEER_CIDRS·DB_DISPOSABLE·DB_RELAY). terraform·클라우드 호출 없음
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cidrProblem, createRealTerraformRunner, DbNetworkError, dbNetworkFromEnv, DEMO_SPEC, targetBuilderFor, withDbNetworkV2, withReplicationNetworkV2,
  type Exec } from "../src/index.js";

const tfOf = (p: "aws" | "gcp") => targetBuilderFor(p).toTerraformV2(DEMO_SPEC, { envId: "33333333-3333-4333-8333-333333333333", provider: p, region: "default",
  tenantId: "11111111-1111-4111-8111-111111111111", migrationId: "22222222-2222-4222-8222-222222222222" } as never);
const MAC = "203.0.113.7/32";

test("아무것도 안 켜면 null, Terraform 호출도 같은 객체 그대로 (계획 지문 안 바뀜)", () => {
  assert.equal(dbNetworkFromEnv("aws", {}), null);
  const tf = tfOf("aws");
  assert.equal(withDbNetworkV2(tf, "aws", {}), tf);
  assert.equal(withDbNetworkV2(tf, "onprem", {}), tf);
});

test("aws DB_PUBLIC=1: 공개 + 허용 목록 + 공개 서브넷 자리표시", () => {
  const n = dbNetworkFromEnv("aws", { DB_PUBLIC: "1", DB_PEER_CIDRS: `${MAC}, 198.51.100.9/32` })!;
  assert.deepEqual(n.vars, { db_public: true, db_peer_cidrs_json: JSON.stringify([MAC, "198.51.100.9/32"]), db_public_subnet_ids_json: "<env:dbPublicSubnetIdsJson>" });
  assert.equal(n.summary.public, true);
  const tf = withDbNetworkV2(tfOf("aws"), "aws", { DB_PUBLIC: "1", DB_PEER_CIDRS: MAC });
  const [pg] = JSON.parse(String(tf.vars.postgres_json));
  assert.equal(pg.public, true);
  assert.deepEqual(JSON.parse(pg.peer_cidrs_json), [MAC]);
  assert.equal(tf.vars.vpc_id, tfOf("aws").vars.vpc_id);
});

test("gcp DB_PUBLIC=1 + DB_DISPOSABLE=1: authorized_networks 값 + 삭제 보호 끔, 서브넷 자리표시 없음", () => {
  const n = dbNetworkFromEnv("gcp", { DB_PUBLIC: "1", DB_PEER_CIDRS: MAC, DB_DISPOSABLE: "1" })!;
  assert.deepEqual(n.vars, { db_public: true, db_peer_cidrs_json: JSON.stringify([MAC]), db_deletion_protection: false });
});

test("넓은 범위·빈 허용 목록·잘못된 조합은 DB_NETWORK_INVALID", () => {
  const bad: [string, NodeJS.ProcessEnv, "aws" | "gcp" | "onprem"][] = [
    ["0.0.0.0/0", { DB_PUBLIC: "1", DB_PEER_CIDRS: "0.0.0.0/0" }, "aws"],
    ["/16", { DB_PUBLIC: "1", DB_PEER_CIDRS: "10.1.0.0/16" }, "gcp"],
    ["빈 목록", { DB_PUBLIC: "1" }, "aws"],
    ["모양", { DB_PUBLIC: "1", DB_PEER_CIDRS: "203.0.113.7" }, "aws"],
  ];
  for (const [name, env, p] of bad) {
    assert.throws(() => dbNetworkFromEnv(p, env), (e: unknown) => e instanceof DbNetworkError && e.code === "DB_NETWORK_INVALID", name);
  }
  assert.equal(cidrProblem(MAC), null);
  assert.match(cidrProblem("256.1.1.1/32")!, /255/);
});

test("중계기 이전 덧씌우기: repl_public + 복제 허용 주소 + app_login_sql. 앱 공개(public·peer_cidrs_json)는 그대로, 길 없으면 같은 객체, 넓은 범위는 거부", () => {
  const tf = { vars: { postgres_json: JSON.stringify([{ id: "db", public: false, peer_cidrs_json: JSON.stringify(["10.9.0.0/24"]) }]), app_name: "shop" } };
  assert.equal(withReplicationNetworkV2(tf, null), tf);
  assert.equal(withReplicationNetworkV2(tf, { peerCidrs: [], appLoginSql: true }), tf);
  const out = withReplicationNetworkV2(tf, { peerCidrs: ["203.0.113.50/32", "198.51.100.7/32"], appLoginSql: true });
  assert.deepEqual(JSON.parse(String(out.vars.postgres_json)), [{ id: "db", public: false, peer_cidrs_json: JSON.stringify(["10.9.0.0/24"]),
    repl_public: true, repl_peer_cidrs_json: JSON.stringify(["198.51.100.7/32", "203.0.113.50/32"]), app_login_sql: true }]);
  assert.equal(out.vars.app_name, "shop");
  assert.throws(() => withReplicationNetworkV2(tf, { peerCidrs: ["0.0.0.0/0"], appLoginSql: true }), DbNetworkError);
});

test("Cloud SQL 서버 CA 출력은 db-ca.pem 파일로 빼고 경로만 남긴다 (감사 기록에 PEM 안 들어감)", async () => {
  const PEM = "-----BEGIN CERTIFICATE-----\nMIIfake\n-----END CERTIFICATE-----";
  const exec: Exec = async (_c, args) => ({ code: 0, ms: 1, stderr: "",
    stdout: args.includes("output") ? JSON.stringify({ db_public_ip: { value: "34.1.2.3" }, db_server_ca_cert: { value: PEM } }) : "ok" });
  const root = mkdtempSync(join(tmpdir(), "z77-"));
  const r = createRealTerraformRunner({ exec, workRoot: root, env: { TF_FETCH_DB_SECRET: "0" } });
  const mid = "4a8c0000-0000-4000-8000-0000000000dd";
  const out = await r.apply("gcp", mid, { a: 1 });
  assert.equal(out.ok, true);
  assert.equal(out.tfOutputs.db_server_ca_cert, undefined);
  assert.equal(out.tfOutputs.db_ca_file, join(root, mid, "db-ca.pem"));
  assert.equal(readFileSync(join(root, mid, "db-ca.pem"), "utf8"), `${PEM}\n`);
  assert.equal(JSON.parse(readFileSync(join(root, mid, "outputs.json"), "utf8")).db_server_ca_cert, undefined);
});

// Z38 REVIEW-5 Z77-1: 워커 .env 하나로 모든 이전을 계획하므로, 클라우드가 아닌 도착에는 손대지 않는다 (던지지 않음)
test("onprem·azure_mock 도착은 DB_PUBLIC 을 켜도 아무것도 안 더한다 (데모 A·smoke-azure 가 안 깨짐)", () => {
  for (const p of ["onprem", "azure_mock"] as const) {
    assert.equal(dbNetworkFromEnv(p, { DB_PUBLIC: "1", DB_PEER_CIDRS: MAC, DB_DISPOSABLE: "1" }), null, p);
    assert.equal(dbNetworkFromEnv(p, { DB_PUBLIC: "1", DB_PEER_CIDRS: "0.0.0.0/0" }), null, p);
  }
});
