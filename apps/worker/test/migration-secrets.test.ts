// 이전별 비밀 파생 + SealedSecret 봉인 (gitops/migration-secrets.ts, gitops/sealing-cert.ts)
// 비밀 값은 출력하지 않는다: 단언 실패 메시지에도 값이 안 나가게 길이·일치 여부만 비교한다
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { X509Certificate, constants, createDecipheriv, createPrivateKey, privateDecrypt } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Tx } from "@svc/core";
import {
  cnpgServerDnsNames, derivePassword, deriveSshKeypair, issueServerCert, sealedSecretValues, sealingPublicKey, sealSecretValue,
} from "../src/gitops/migration-secrets.js";
import { latestSealingCert } from "../src/gitops/sealing-cert.js";

// 시험용 가짜 마스터 키 (실제 값 아님)
const MK = "test-master-key-not-a-secret-0123456789";

const has = (bin: string, args: string[]) => { try { execFileSync(bin, args, { stdio: "ignore" }); return true; } catch { return false; } };
const OPENSSL = has("openssl", ["version"]);
const SSH_KEYGEN = has("sh", ["-c", "command -v ssh-keygen"]);
const noOpenssl = OPENSSL ? false : "openssl CLI 가 이 기계에 없다 (워커 이미지에는 들어 있다)";

// 시험 전용: RSA 키 + 자체 서명 인증서를 openssl 로 만든다 (Node 에는 X.509 만드는 API 가 없다)
function rsaTestCert(days = 30): { certPem: string; keyPem: string } {
  const d = mkdtempSync(join(tmpdir(), "svc-seal-test-"));
  try {
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(d, "k.pem"), "-out", join(d, "c.pem"),
      "-days", String(days), "-subj", "/CN=sealed-secret-test"], { stdio: "ignore" });
    return { certPem: readFileSync(join(d, "c.pem"), "utf8"), keyPem: readFileSync(join(d, "k.pem"), "utf8") };
  } finally { rmSync(d, { recursive: true, force: true }); }
}

// 시험 전용 복호: upstream pkg/crypto/crypto.go singleDecrypt 와 같은 순서
function hybridDecrypt(keyPem: string, b64: string, label: string): Buffer {
  const ct = Buffer.from(b64, "base64");
  const n = ct.readUInt16BE(0);
  const sessionKey = privateDecrypt({ key: createPrivateKey(keyPem), padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256", oaepLabel: Buffer.from(label) },
    ct.subarray(2, 2 + n));
  const body = ct.subarray(2 + n);
  const d = createDecipheriv("aes-256-gcm", sessionKey, Buffer.alloc(12));
  d.setAuthTag(body.subarray(body.length - 16));
  return Buffer.concat([d.update(body.subarray(0, body.length - 16)), d.final()]);
}

test("derivePassword: 정해진 식(HMAC-SHA256 → base64url → 32자) 그대로, 목적이 다르면 다른 값", () => {
  const p = derivePassword(MK, "t-1", "m-1", "target", "repl-password");
  // 기대값은 openssl 로 따로 계산했다: printf '%s' 't-1:m-1:target:repl-password' | openssl dgst -sha256 -hmac <MK> -binary | base64 | tr '+/' '-_' | tr -d '=' | cut -c1-32
  assert.ok(p === "bLhcHWsERaKc0FRJL6ZWLgLKD-si7ppv", "packages/replication 의 derive: 와 같은 식이어야 한다");
  assert.equal(p.length, 32);
  assert.ok(derivePassword(MK, "t-1", "m-1", "target", "ssh") !== p);
  assert.ok(derivePassword(MK, "t-1", "m-2", "target", "repl-password") !== p);
});

test("derivePassword·deriveSshKeypair: 마스터 키가 32자보다 짧으면 거부", () => {
  assert.throws(() => derivePassword("short", "t", "m", "target", "x"), /^MigrationSecretError: MASTER_KEY_TOO_SHORT/);
  assert.throws(() => deriveSshKeypair("x".repeat(31), "t", "m"), /MASTER_KEY_TOO_SHORT/);
});

test("deriveSshKeypair: 결정적 ed25519, ssh-keygen -y 가 개인 키를 받아 같은 공개 키를 낸다", { skip: SSH_KEYGEN ? false : "ssh-keygen 이 없다" }, () => {
  const a = deriveSshKeypair(MK, "t-1", "m-1");
  const b = deriveSshKeypair(MK, "t-1", "m-1");
  assert.ok(a.privateKeyOpenssh === b.privateKeyOpenssh, "같은 입력이면 같은 키");
  assert.ok(deriveSshKeypair(MK, "t-1", "m-2").publicKeyLine !== a.publicKeyLine, "이전이 다르면 다른 키");
  assert.match(a.publicKeyLine, /^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI[A-Za-z0-9+/]+=* svc-migration-m-1$/);
  assert.match(a.privateKeyOpenssh, /^-----BEGIN OPENSSH PRIVATE KEY-----\n[A-Za-z0-9+/=\n]+\n-----END OPENSSH PRIVATE KEY-----\n$/);
  const d = mkdtempSync(join(tmpdir(), "svc-ssh-test-"));
  try {
    writeFileSync(join(d, "id"), a.privateKeyOpenssh, { mode: 0o600 });
    const out = execFileSync("ssh-keygen", ["-y", "-f", join(d, "id")], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    // ssh-keygen -y 는 "ssh-ed25519 <b64> <comment>" 를 낸다 (comment 는 판에 따라 빠질 수 있어 앞 두 칸만 비교)
    assert.equal(out.split(" ").slice(0, 2).join(" "), a.publicKeyLine.split(" ").slice(0, 2).join(" "));
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("issueServerCert: CA 가 서명한 서버 인증서, CNPG 세 Service 의 SAN 12개, CA 개인 키는 결과에 없다", { skip: noOpenssl }, async () => {
  const dnsNames = cnpgServerDnsNames("shop-db", "app-shop");
  assert.equal(dnsNames.length, 12);
  assert.ok(dnsNames.includes("shop-db-ro.app-shop.svc.cluster.local") && dnsNames.includes("shop-db-r.app-shop"));
  const r = await issueServerCert({ cnName: "shop-db-rw", dnsNames, days: 30 });
  assert.deepEqual(Object.keys(r).sort(), ["caCertPem", "serverCertPem", "serverKeyPem"]);
  const ca = new X509Certificate(r.caCertPem), srv = new X509Certificate(r.serverCertPem);
  assert.equal(ca.ca, true);
  assert.equal(srv.ca, false);
  assert.ok(srv.verify(ca.publicKey));
  assert.ok(srv.checkIssued(ca));
  assert.ok(srv.checkPrivateKey(createPrivateKey(r.serverKeyPem)));
  assert.match(srv.subject, /CN=shop-db-rw/);
  for (const n of dnsNames) assert.ok(srv.checkHost(n), `SAN ${n}`);
  assert.equal(srv.checkHost("evil.example.com"), undefined);
  // caSeed 가 같으면 CA 키가 같다 (같은 CA 로 다시 발급 가능), 서버 키는 매번 새로
  const seed = Buffer.alloc(32, 7);
  const s1 = await issueServerCert({ caSeed: seed, cnName: "shop-db-rw", dnsNames, days: 1 });
  const s2 = await issueServerCert({ caSeed: seed, cnName: "shop-db-rw", dnsNames, days: 1 });
  assert.ok(new X509Certificate(s1.caCertPem).publicKey.equals(new X509Certificate(s2.caCertPem).publicKey));
  assert.ok(s1.serverKeyPem !== s2.serverKeyPem);
});

test("issueServerCert 거부: 이름에 openssl 구문을 끼우면 막고, openssl 이 없으면 OPENSSL_MISSING", async () => {
  await assert.rejects(issueServerCert({ cnName: "x/O=evil", dnsNames: ["a"], days: 1 }), /CERT_NAME_INVALID/);
  await assert.rejects(issueServerCert({ cnName: "a", dnsNames: ["a,DNS:evil.com"], days: 1 }), /CERT_NAME_INVALID/);
  await assert.rejects(issueServerCert({ cnName: "a", dnsNames: ["a"], days: 0 }), /CERT_DAYS_INVALID/);
  await assert.rejects(issueServerCert({ cnName: "a", dnsNames: ["a"], days: 1 }, { opensslBin: "/nonexistent/openssl" }),
    (e: Error) => e.message.startsWith("OPENSSL_MISSING"));
});

test("sealSecretValue: strict 범위 혼합 암호화를 같은 방식 복호로 되돌린다 + 차트 값 모양", { skip: noOpenssl }, () => {
  const { certPem, keyPem } = rsaTestCert();
  const pw = derivePassword(MK, "t-1", "m-1", "target", "repl-password");
  const sealed = sealSecretValue(certPem, "app-shop", "repl-creds", Buffer.from(pw));
  const raw = Buffer.from(sealed, "base64");
  assert.equal(raw.readUInt16BE(0), 256, "RSA-2048 암호문 길이 머리 (uint16 BE)");
  assert.equal(raw.length, 2 + 256 + pw.length + 16, "길이 || RSA || GCM 암호문 + 태그 16");
  assert.ok(hybridDecrypt(keyPem, sealed, "app-shop/repl-creds").toString() === pw, "되돌린 값이 같아야 한다");
  // 같은 값도 봉인할 때마다 다르다 (무작위 세션 키)
  assert.ok(sealSecretValue(certPem, "app-shop", "repl-creds", Buffer.from(pw)) !== sealed);

  const v = sealedSecretValues(certPem, "app-shop", "repl-creds", { username: "svc_repl", password: Buffer.from(pw) });
  assert.equal(v.name, "repl-creds");
  assert.deepEqual(Object.keys(v.encryptedData), ["password", "username"]);
  assert.equal(hybridDecrypt(keyPem, v.encryptedData.username!, "app-shop/repl-creds").toString(), "svc_repl");
});

test("sealSecretValue 거부: 다른 이름(label)으로는 안 풀리고, 만료·RSA 아님·틀린 이름은 봉인 전에 막는다", { skip: noOpenssl }, () => {
  const { certPem, keyPem } = rsaTestCert();
  const sealed = sealSecretValue(certPem, "app-shop", "repl-creds", Buffer.from("x"));
  assert.throws(() => hybridDecrypt(keyPem, sealed, "app-shop/other"));
  assert.throws(() => hybridDecrypt(keyPem, sealed, "other-ns/repl-creds"));
  assert.throws(() => sealingPublicKey(certPem, new Date(Date.now() + 40 * 86400_000)), /SEALING_CERT_EXPIRED/);
  assert.throws(() => sealSecretValue("not a cert", "app-shop", "s", Buffer.from("x")), /SEALING_CERT_INVALID/);
  assert.throws(() => sealSecretValue(certPem, "", "s", Buffer.from("x")), /SEALED_NAME_INVALID/);
  assert.throws(() => sealedSecretValues(certPem, "app-shop", "s", { "bad/key": "x" }), /SEALED_KEY_INVALID/);
});

// 실제 컨트롤러(sealed-secrets v0.40.0) 인증서를 읽는지. 인증서 파일은 레포에 넣지 않는다 → SEALING_CERT_FILE 이 있을 때만
const REAL = process.env.SEALING_CERT_FILE;
test("sealSecretValue: 실제 sealed-secrets 컨트롤러 인증서(RSA 4096)를 읽어 봉인한다", { skip: REAL && existsSync(REAL) ? false : "SEALING_CERT_FILE 없음 (실제 컨트롤러 인증서로만 확인하는 시험)" }, () => {
  const certPem = readFileSync(REAL!, "utf8");
  assert.equal(sealingPublicKey(certPem).asymmetricKeyDetails?.modulusLength, 4096);
  const raw = Buffer.from(sealSecretValue(certPem, "app-shop", "repl-creds", Buffer.from("x")), "base64");
  assert.equal(raw.readUInt16BE(0), 512);
});

// latestSealingCert: 가짜 tx (SQL 은 DB 시험 몫, 여기서는 고르는 규칙과 매개변수)
const fakeTx = (rows: unknown[], seen: unknown[][] = []) => ({ query: async (_sql: string, params: unknown[]) => { seen.push(params); return { rows }; } }) as unknown as Tx;
const factsBody = (sealing?: unknown) => ({ kind: "facts", agentVersion: "t", sentAt: "2026-11-05T00:00:00Z", grants: { level: "L0" }, dbs: [], ...(sealing ? { sealing } : {}) });

test("latestSealingCert: 가장 최근 facts 의 sealing 칸을 회사·환경 매개변수로 읽는다", { skip: noOpenssl }, async () => {
  const { certPem } = rsaTestCert();
  const seen: unknown[][] = [];
  const r = await latestSealingCert(fakeTx([{ body: factsBody({ certPem, fetchedAt: "2026-11-05T00:00:00Z" }), received_at: new Date("2026-11-05T00:00:01Z") }], seen), "T", "E");
  assert.equal(r?.certPem, certPem);
  assert.equal(r?.receivedAt, "2026-11-05T00:00:01.000Z");
  assert.deepEqual(seen[0], ["T", "E"]);
});

test("latestSealingCert 거부: 보고 없음 · sealing 칸 없음 · 인증서가 아님 · 만료 → undefined", { skip: noOpenssl }, async () => {
  const { certPem } = rsaTestCert(1);
  const at = new Date();
  assert.equal(await latestSealingCert(fakeTx([]), "T", "E"), undefined);
  assert.equal(await latestSealingCert(fakeTx([{ body: factsBody(), received_at: at }]), "T", "E"), undefined);
  assert.equal(await latestSealingCert(fakeTx([{ body: factsBody({ certPem: "-----BEGIN CERTIFICATE-----\nzzz\n", fetchedAt: at.toISOString() }), received_at: at }]), "T", "E"), undefined);
  assert.equal(await latestSealingCert(fakeTx([{ body: factsBody({ certPem, fetchedAt: at.toISOString() }), received_at: at }]), "T", "E", new Date(Date.now() + 3 * 86400_000)), undefined);
});
