// Z77: 복제 끝점 TLS (CA 파일, verify-full/verify-ca/require). DB 없이 설정 모양만 본다
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clientConfig, endpointFromEnv, peerTlsProblem } from "../src/index.js";
import { resolveTfRefs } from "../src/tf-facts.js";

const dir = mkdtempSync(join(tmpdir(), "z77-tls-"));
const CA = join(dir, "db-ca-bundle.pem");
writeFileSync(CA, "-----BEGIN CERTIFICATE-----\nMIIfake\n-----END CERTIFICATE-----\n");
const URL_T = "postgres://app:pw@shop.abc.ap-northeast-2.rds.amazonaws.com:5432/shop?sslmode=require";

test("TLS 변수가 없으면 예전과 똑같다 (접속 문자열 그대로, ssl 객체 없음)", () => {
  const e = endpointFromEnv("REPL_TARGET", { REPL_TARGET_URL: URL_T });
  assert.equal(e.tls, undefined);
  assert.deepEqual(clientConfig(e, {}), { application_name: "svc-replication", keepAlive: true, keepAliveInitialDelayMillis: 10_000, connectionTimeoutMillis: 20_000, connectionString: URL_T });
});

test("CA 파일만 주면 verify-full: CA 를 싣고 이름까지 확인, 문자열 안 sslmode 는 뺀다", () => {
  const e = endpointFromEnv("REPL_TARGET", { REPL_TARGET_URL: URL_T, REPL_CA_FILE: CA });
  assert.deepEqual(e.tls, { mode: "verify-full", caFile: CA });
  const c = clientConfig(e);
  assert.equal(String(c.connectionString).includes("sslmode"), false);
  const ssl = c.ssl as { ca: string; rejectUnauthorized: boolean; checkServerIdentity?: unknown };
  assert.match(ssl.ca, /BEGIN CERTIFICATE/);
  assert.equal(ssl.rejectUnauthorized, true);
  assert.equal(ssl.checkServerIdentity, undefined);
});

test("verify-ca 는 CA 만 확인 (Cloud SQL 공인 IP), 쪽별 값이 전체 값보다 먼저", () => {
  const e = endpointFromEnv("REPL_TARGET", { REPL_TARGET_URL: URL_T, REPL_CA_FILE: "/nope", REPL_TARGET_CA_FILE: CA, REPL_TARGET_SSLMODE: "verify-ca" });
  const ssl = clientConfig(e).ssl as { rejectUnauthorized: boolean; checkServerIdentity: () => undefined };
  assert.equal(ssl.rejectUnauthorized, true);
  assert.equal(typeof ssl.checkServerIdentity, "function");
});

test("한쪽만 끄기(disable), 잘못된 값, CA 없는 verify-full 은 막는다", () => {
  assert.equal(endpointFromEnv("REPL_SOURCE", { REPL_SOURCE_URL: "postgres://l/x", REPL_CA_FILE: CA, REPL_SOURCE_SSLMODE: "disable" }).tls, undefined);
  assert.throws(() => endpointFromEnv("REPL_TARGET", { REPL_TARGET_URL: URL_T, REPL_SSLMODE: "prefer" }), /verify-full/);
  const e = endpointFromEnv("REPL_TARGET", { REPL_TARGET_URL: URL_T, REPL_SSLMODE: "verify-full" });
  assert.throws(() => clientConfig(e), /CA 파일/);
  assert.throws(() => clientConfig(endpointFromEnv("REPL_TARGET", { REPL_TARGET_URL: URL_T, REPL_CA_FILE: join(dir, "missing.pem") })), /못 읽었다/);
});

test("TLS 를 켠 끝점의 PEER_URL 은 sslmode=require 이상이어야 한다", () => {
  const ok = endpointFromEnv("REPL_TARGET", { REPL_TARGET_URL: URL_T, REPL_CA_FILE: CA, REPL_TARGET_PEER_URL: `${URL_T}` });
  assert.equal(peerTlsProblem(ok), null);
  const bad = endpointFromEnv("REPL_TARGET", { REPL_TARGET_URL: "postgres://a@h/x", REPL_CA_FILE: CA });
  assert.match(peerTlsProblem(bad)!, /sslmode=require/);
  assert.equal(peerTlsProblem(endpointFromEnv("REPL_TARGET", { REPL_TARGET_URL: "postgres://a@h/x" })), null);
});

test("{tf:db_ca_file}·{tf:relay_private_ip} 는 terraform 출력으로 채운다 (CA 경로는 퍼센트 인코딩 안 함)", () => {
  const env = resolveTfRefs({ REPL_TARGET_CA_FILE: "{tf:db_ca_file}", REPL_SOURCE_PEER_URL: "postgres://repl:pw@{tf:relay_private_ip}:{tf:relay_port}/shop?sslmode=require" },
    "4a8c0000-0000-4000-8000-0000000000dd", { db_ca_file: "/w/x/db-ca.pem", relay_private_ip: "10.40.1.23", relay_port: "15432" });
  assert.equal(env.REPL_TARGET_CA_FILE, "/w/x/db-ca.pem");
  assert.equal(env.REPL_SOURCE_PEER_URL, "postgres://repl:pw@10.40.1.23:15432/shop?sslmode=require");
});
