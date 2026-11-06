// 온프레 CNPG 이전 배달물 (gitops/replication-delivery.ts): 끝점 줄이 있으면 값에 서버 인증서·봉인 비밀·터널을 넣고,
//   다시 렌더해도 같은 바이트(저장된 봉인 값 재사용), 줄이 없으면 값 그대로, 봉인 인증서가 없으면 SEALING_CERT_MISSING,
//   정리 값(ensure absent·터널 빼기), 실제 차트 렌더, CLI pubkey 파생
// 비밀 값은 출력하지 않는다: 단언은 일치 여부만 본다
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { X509Certificate, constants, createDecipheriv, createPrivateKey, privateDecrypt } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAllDocuments } from "yaml";
import { ChartValues, type HelmValues, type ReplicationEndpoint } from "@svc/contracts";
import {
  DB_TUNNEL_IMAGE, commitReplicationCleanup, decideDelivery, replicationCnpgs, withDelivery, withoutDelivery, type DeliveryFacts,
} from "../src/gitops/replication-delivery.js";
import { derivePassword, deriveSshKeypair, issueServerCert, type ServerCertInput } from "../src/gitops/migration-secrets.js";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const MK = "test-master-key-not-a-secret-0123456789";   // 시험용 가짜 마스터 키
const T = "9f8e7d6c-0000-4000-8000-000000000001", M = "4a8c0000-0000-4000-8000-000000000001";
const RDS = "shop.abc123.ap-northeast-2.rds.amazonaws.com";
const KNOWN = "203.0.113.7 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeHostKeyForRenderOnly";

const has = (bin: string, args: string[]) => { try { execFileSync(bin, args, { stdio: "ignore" }); return true; } catch { return false; } };
const noOpenssl = has("openssl", ["version"]) ? false : "openssl CLI 가 이 기계에 없다";
const noHelm = has("helm", ["version", "--short"]) ? false : "helm 이 없다";

// 시험 전용 sealed-secrets 컨트롤러 흉내: RSA 키 + 자체 서명 인증서 (migration-secrets.test.ts 와 같은 방법)
function rsaTestCert(): { certPem: string; keyPem: string } {
  const d = mkdtempSync(join(tmpdir(), "svc-deliv-seal-"));
  try {
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(d, "k.pem"), "-out", join(d, "c.pem"),
      "-days", "30", "-subj", "/CN=sealed-secret-test"], { stdio: "ignore" });
    return { certPem: readFileSync(join(d, "c.pem"), "utf8"), keyPem: readFileSync(join(d, "k.pem"), "utf8") };
  } finally { rmSync(d, { recursive: true, force: true }); }
}
// upstream pkg/crypto/crypto.go singleDecrypt 와 같은 순서
function unseal(keyPem: string, b64: string, label: string): string {
  const ct = Buffer.from(b64, "base64");
  const n = ct.readUInt16BE(0);
  const key = privateDecrypt({ key: createPrivateKey(keyPem), padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256", oaepLabel: Buffer.from(label) }, ct.subarray(2, 2 + n));
  const body = ct.subarray(2 + n);
  const d = createDecipheriv("aes-256-gcm", key, Buffer.alloc(12));
  d.setAuthTag(body.subarray(body.length - 16));
  return Buffer.concat([d.update(body.subarray(0, body.length - 16)), d.final()]).toString("utf8");
}

// 어댑터가 내는 온프레 값 모양 (deploy/ci/values/v2-onprem-migrate.json 에서 워커가 더하는 칸을 뺀 것)
function baseValues(): HelmValues {
  const v = JSON.parse(readFileSync(join(ROOT, "deploy/ci/values/v2-onprem-migrate.json"), "utf8")) as HelmValues & { postgres: Array<Record<string, unknown>> };
  delete v.dbTunnel; delete v.sealedSecrets;
  v.postgres = v.postgres.map(({ certificates: _c, ...p }) => ({ ...p, replication: { enabled: true, role: "svc_migrate", passwordSecret: "shop-db-migrate" } }));
  return v;
}
const ep = (side: "source" | "target", o: Partial<ReplicationEndpoint> = {}): ReplicationEndpoint => ({
  tenantId: T, migrationId: M, side, label: `${side}-db`, provider: side === "source" ? "rds" : "cnpg",
  host: side === "source" ? RDS : "203.0.113.7", port: 5432, dbname: "shop",
  username: side === "source" ? "repl_admin" : "svc_migrate", passwordRef: side === "source" ? "env:REPL_SECRET_SRC_4A8C0000" : "derive:migrate",
  peerHost: side === "target" ? "10.0.1.20" : null, peerPort: side === "target" ? 5432 : null, appRole: "app_user", fenceRoles: [], schemaName: null,
  sslmode: "require", tlsServername: null, caPem: null,
  relayHost: side === "target" ? "203.0.113.7" : null, relayKnownHosts: side === "target" ? KNOWN : null, relayPort: 22, ...o,
});
const facts = (o: Partial<DeliveryFacts> = {}): DeliveryFacts => ({
  provider: "onprem", pullMode: true, values: baseValues(), tenantId: T, migrationId: M,
  records: [ep("source"), ep("target")], stored: null, sealingCertPem: null, masterKey: MK, ...o,
});
// 실제 openssl 발급을 세며 부른다 (다시 렌더할 때 발급하지 않는지 본다)
function countingIssue() {
  const calls: ServerCertInput[] = [];
  return { calls, issue: (i: ServerCertInput) => { calls.push(i); return issueServerCert(i); } };
}

test("끝점 줄 두 개 → 값에 서버 인증서·봉인 비밀 4개·터널, 차트 계약 통과, 봉인 값은 파생 값과 같고, 끝점 줄에 되쓸 값", { skip: noOpenssl }, async () => {
  const seal = rsaTestCert();
  const c = countingIssue();
  const d = await decideDelivery(facts({ sealingCertPem: seal.certPem }), { issue: c.issue });
  assert.equal(d.kind, "ok");
  if (d.kind !== "ok") return;
  assert.deepEqual(d.warnings, []);
  assert.equal(c.calls.length, 1);
  assert.deepEqual([c.calls[0]!.cnName, c.calls[0]!.days, c.calls[0]!.caSeed?.length], ["shop-db-rw", 365, 32]);
  const v = withDelivery(baseValues(), d.delivery);
  assert.ok(ChartValues.safeParse(v).success, "차트 값 계약을 지난다");
  const pg = (v.postgres as Array<Record<string, unknown>>)[0]!;
  assert.deepEqual(pg.certificates, { serverCASecret: "shop-db-server-ca", serverTLSSecret: "shop-db-server-tls" });
  assert.deepEqual(v.dbTunnel, { relay: { host: "203.0.113.7", port: 22, knownHosts: KNOWN }, keySecret: "db-tunnel-key",
    forward: { target: `${RDS}:5432` }, reverse: { enabled: true, cnpgName: "shop-db" }, image: DB_TUNNEL_IMAGE });
  const sealed = Object.fromEntries((v.sealedSecrets as Array<{ name: string; type?: string; encryptedData: Record<string, string> }>).map((s) => [s.name, s]));
  assert.deepEqual(Object.keys(sealed), ["shop-db-migrate", "shop-db-server-ca", "shop-db-server-tls", "db-tunnel-key"]);
  assert.deepEqual([sealed["shop-db-migrate"]!.type, sealed["shop-db-server-tls"]!.type, sealed["shop-db-server-ca"]!.type], ["kubernetes.io/basic-auth", "kubernetes.io/tls", undefined]);
  const open = (name: string, key: string) => unseal(seal.keyPem, sealed[name]!.encryptedData[key]!, `app-shop/${name}`);
  assert.ok(open("shop-db-migrate", "password") === derivePassword(MK, T, M, "target", "migrate"), "봉인한 비밀번호 = 워커 derive:migrate 값");
  assert.equal(open("shop-db-migrate", "username"), "svc_migrate");
  assert.ok(open("db-tunnel-key", "id") === deriveSshKeypair(MK, T, M).privateKeyOpenssh, "터널 키 = CLI pubkey 의 짝");
  const ca = new X509Certificate(open("shop-db-server-ca", "ca.crt"));
  const srv = new X509Certificate(open("shop-db-server-tls", "tls.crt"));
  assert.ok(srv.verify(ca.publicKey) && srv.checkPrivateKey(createPrivateKey(open("shop-db-server-tls", "tls.key"))));
  assert.ok(srv.checkHost("shop-db-rw.app-shop.svc"), "워커가 확인할 이름이 SAN 에 있다");
  const w = d.delivery.write!;
  assert.equal(w.target.caPem, ca.toString());
  assert.equal(w.target.tlsServername, "shop-db-rw.app-shop.svc");
  assert.deepEqual(w.sourcePeer, { host: "db-tunnel.app-shop.svc", port: 5432 });
  assert.equal(w.target.sealed.sealedSecrets.length, 4);
});

test("다시 렌더: 지문이 같으면 저장된 봉인 값을 그대로 (같은 바이트, 발급 0번). 봉인 인증서가 바뀌거나 CA 가 곧 만료면 다시 봉인", { skip: noOpenssl }, async () => {
  const seal = rsaTestCert();
  const c = countingIssue();
  const first = await decideDelivery(facts({ sealingCertPem: seal.certPem }), { issue: c.issue });
  assert.equal(first.kind, "ok");
  if (first.kind !== "ok") return;
  const w = first.delivery.write!;
  // 배포 단계가 되쓴 뒤의 줄 (recordReplicationDelivery 와 같은 결과)
  const rows = [ep("source", { peerHost: w.sourcePeer!.host, peerPort: 5432 }),
    ep("target", { caPem: w.target.caPem, tlsServername: w.target.tlsServername, sslmode: "verify-full" })];
  // 저장 칸은 jsonb 라 읽어 오면 키 순서가 바뀐다 → 순서를 뒤집은 값으로도 같은 바이트여야 한다
  const reorder = (x: unknown): unknown => Array.isArray(x) ? x.map(reorder)
    : x && typeof x === "object" ? Object.fromEntries(Object.entries(x).reverse().map(([k, y]) => [k, reorder(y)])) : x;
  const fromJsonb = reorder(structuredClone(w.target.sealed)) as typeof w.target.sealed;
  const again = await decideDelivery(facts({ sealingCertPem: seal.certPem, records: rows, stored: fromJsonb }), { issue: c.issue });
  assert.equal(again.kind, "ok");
  if (again.kind !== "ok") return;
  assert.equal(c.calls.length, 1, "다시 발급하지 않는다");
  assert.equal(again.delivery.reused, true);
  assert.equal(again.delivery.write, null, "줄이 이미 맞으면 되쓰지 않는다");
  assert.equal(JSON.stringify(withDelivery(baseValues(), again.delivery)), JSON.stringify(withDelivery(baseValues(), first.delivery)), "같은 값 바이트");

  const other = rsaTestCert();   // 컨트롤러가 바뀜 (다시 설치 등) → 다시 봉인
  const resealed = await decideDelivery(facts({ sealingCertPem: other.certPem, records: rows, stored: w.target.sealed }), { issue: c.issue });
  assert.ok(resealed.kind === "ok" && !resealed.delivery.reused && resealed.delivery.write);
  assert.equal(c.calls.length, 2);
  const late = new Date(Date.now() + 340 * 86_400_000);   // 365일 CA 의 남은 날 < 30
  const renewed = await decideDelivery(facts({ sealingCertPem: seal.certPem, records: rows, stored: w.target.sealed, now: late }), { issue: c.issue });
  assert.ok(renewed.kind === "ok" && !renewed.delivery.reused);
  // 운영자가 도착 줄을 다시 set 해 ca_pem 이 비면 → 다시 발급 (저장 값의 CA 와 줄의 CA 가 다르면 쓰지 않는다)
  const cleared = await decideDelivery(facts({ sealingCertPem: seal.certPem, records: [rows[0]!, ep("target")], stored: w.target.sealed }), { issue: c.issue });
  assert.ok(cleared.kind === "ok" && !cleared.delivery.reused);
});

test("끝점 줄이 없으면 값을 그대로 두고 경고 한 줄 (로컬 데모). 온프레가 아니면 아무것도 안 함", async () => {
  const none = await decideDelivery(facts({ records: [] }));
  assert.equal(none.kind, "none");
  assert.match(none.warnings[0]!, /복제 끝점 줄\(replication_endpoints\)이 없다/);
  const half = await decideDelivery(facts({ records: [ep("source")] }));
  assert.equal(half.kind, "none");
  assert.match(half.warnings[0]!, /한쪽만/);
  assert.deepEqual(await decideDelivery(facts({ provider: "aws" })), { kind: "none", warnings: [] });
  const push = await decideDelivery(facts({ pullMode: false }));
  assert.equal(push.kind, "none");
  assert.match(push.warnings[0]!, /ONPREM_FLOOR_VIA_GIT=0/);
  const noRepl = baseValues();
  (noRepl.postgres as Array<Record<string, unknown>>)[0]!.replication = { enabled: false };
  assert.deepEqual(await decideDelivery(facts({ values: noRepl })), { kind: "none", warnings: [] });
});

test("거부: 봉인 인증서 없음 SEALING_CERT_MISSING, 마스터 키 없음 REPL_SECRET_UNRESOLVED, 중계기 칸 없음·출발 포트 5432 아님 REPL_DELIVERY_FAILED", async () => {
  const missing = await decideDelivery(facts({ sealingCertPem: null }));
  assert.equal(missing.kind, "stop");
  if (missing.kind === "stop") {
    assert.equal(missing.code, "SEALING_CERT_MISSING");
    assert.match(missing.reason, /봉인 인증서가 없다/);
  }
  const noKey = await decideDelivery(facts({ masterKey: undefined, sealingCertPem: "x" }));
  assert.ok(noKey.kind === "stop" && noKey.code === "REPL_SECRET_UNRESOLVED");
  const shortKey = await decideDelivery(facts({ masterKey: "short", sealingCertPem: "x" }));
  assert.ok(shortKey.kind === "stop" && shortKey.code === "REPL_SECRET_UNRESOLVED");
  const noRelay = await decideDelivery(facts({ sealingCertPem: "x", records: [ep("source"), ep("target", { relayHost: null, relayKnownHosts: null })] }));
  assert.ok(noRelay.kind === "stop" && noRelay.code === "REPL_DELIVERY_FAILED" && /relay_host/.test(noRelay.reason));
  const badPort = await decideDelivery(facts({ sealingCertPem: "x", records: [ep("source", { port: 6432 }), ep("target")] }));
  assert.ok(badPort.kind === "stop" && badPort.code === "REPL_DELIVERY_FAILED");
  const two = baseValues();
  const pgs = two.postgres as Array<Record<string, unknown>>;
  two.postgres = [...pgs, { ...pgs[0]!, id: "db2", name: "shop-db2" }];
  const ambiguous = await decideDelivery(facts({ values: two, sealingCertPem: "x" }));
  assert.ok(ambiguous.kind === "stop" && ambiguous.code === "REPL_DELIVERY_FAILED" && /2개/.test(ambiguous.reason));
  // 경고: 도착 줄 계정이 차트 이전 역할과 다르면 (봉인 비밀번호로 못 붙는다)
  const wrongUser = await decideDelivery(facts({ sealingCertPem: "not a pem", records: [ep("source"), ep("target", { username: "postgres" })] }));
  assert.ok(wrongUser.kind === "stop" && wrongUser.code === "SEALING_CERT_MISSING", "읽을 수 없는 봉인 인증서도 SEALING_CERT_MISSING");
  assert.match(wrongUser.warnings.join(" "), /도착 줄 계정이 postgres/);
});

// 배달물을 넣은 값 (봉인 값은 가짜 글자, 정리·렌더 시험용)
function deliveredValues(): HelmValues {
  const v = baseValues();
  const cnpg = replicationCnpgs(v)[0]!;
  const fake = (name: string, type: string | undefined, keys: string[]) => ({ name, ...(type ? { type } : {}), encryptedData: Object.fromEntries(keys.map((k) => [k, "AgBFakeSealedForRenderOnly"])) });
  return withDelivery(v, { cnpg, reused: true, write: null,
    certificates: { serverCASecret: "shop-db-server-ca", serverTLSSecret: "shop-db-server-tls" },
    sealedSecrets: [fake("shop-db-migrate", "kubernetes.io/basic-auth", ["username", "password"]), fake("shop-db-server-ca", undefined, ["ca.crt"]),
      fake("shop-db-server-tls", "kubernetes.io/tls", ["tls.crt", "tls.key"]), fake("db-tunnel-key", undefined, ["id"])],
    dbTunnel: { relay: { host: "203.0.113.7", port: 22, knownHosts: KNOWN }, keySecret: "db-tunnel-key", forward: { target: `${RDS}:5432` },
      reverse: { enabled: true, cnpgName: "shop-db" }, image: DB_TUNNEL_IMAGE } });
}

test("정리 값: 이전 역할 ensure=absent (칸은 남김), 터널·터널 키·역할 비밀번호 봉인 빼기, 서버 인증서는 남김. 두 번째는 할 일 없음", () => {
  const v = withoutDelivery(deliveredValues())!;
  assert.ok(v);
  assert.ok(ChartValues.safeParse(v).success);
  const pg = (v.postgres as Array<{ replication: Record<string, unknown>; certificates?: unknown }>)[0]!;
  assert.deepEqual(pg.replication, { enabled: true, role: "svc_migrate", passwordSecret: "shop-db-migrate", ensure: "absent" });
  assert.deepEqual(pg.certificates, { serverCASecret: "shop-db-server-ca", serverTLSSecret: "shop-db-server-tls" });
  assert.equal(v.dbTunnel, undefined);
  assert.deepEqual((v.sealedSecrets as Array<{ name: string }>).map((s) => s.name), ["shop-db-server-ca", "shop-db-server-tls"]);
  assert.equal(withoutDelivery(v), null, "이미 정리했으면 커밋 없음");
  assert.equal(withoutDelivery(baseValues()), null, "배달물이 없던 값(로컬 데모)은 건드리지 않는다");
});

test("정리 커밋: 묶음 값을 읽어 cleanup 으로 커밋, 할 일 없으면 건너뜀, 실패는 결과에만 (정리를 막지 않음)", async () => {
  const b = { tenant: "t-9f8e7d6c", app: "shop", env: "onprem-k3s" as const };
  const commits: Array<{ kind: string; values: HelmValues }> = [];
  const repo = (values: HelmValues) => ({
    readValues: async () => values, readPlan: async () => ({ planId: "p" }) as never,
    commitBundle: async (kind: string, _b: unknown, v: HelmValues) => { commits.push({ kind, values: v }); return { commit: "c0ffee", bundleSha256: "x", resources: [], changed: true }; },
  }) as unknown as Parameters<typeof commitReplicationCleanup>[1];
  assert.deepEqual(await commitReplicationCleanup(b, repo(deliveredValues())), { commit: "c0ffee" });
  assert.equal(commits[0]!.kind, "cleanup");
  assert.equal(commits[0]!.values.dbTunnel, undefined);
  assert.deepEqual(await commitReplicationCleanup(b, repo(baseValues())), { skipped: "no_delivery" });
  assert.deepEqual(await commitReplicationCleanup(null, repo(deliveredValues())), { skipped: "no_gitops" });
  const broken = { readValues: async () => { throw new Error("ENOENT values.yaml"); } } as unknown as Parameters<typeof commitReplicationCleanup>[1];
  assert.deepEqual(await commitReplicationCleanup(b, broken), { error: "ENOENT values.yaml" });
  assert.equal(commits.length, 1);
});

test("터널 이미지 = deploy/helm/onprem-db-tunnel 의 다이제스트 고정 이미지", () => {
  const y = readFileSync(join(ROOT, "deploy/helm/onprem-db-tunnel/values.yaml"), "utf8");
  assert.equal(/^image: (\S+)$/m.exec(y)?.[1], DB_TUNNEL_IMAGE);
});

test("실제 차트 렌더: 배달 값 → SealedSecret 4·db-tunnel·Cluster certificates, 정리 값 → 터널 없음·역할 absent", { skip: noHelm }, () => {
  const render = (v: HelmValues) => {
    const d = mkdtempSync(join(tmpdir(), "svc-deliv-helm-"));
    try {
      writeFileSync(join(d, "values.json"), JSON.stringify(v));
      const out = execFileSync("helm", ["template", "shop", join(ROOT, "gitops/charts/app"), "-f", join(d, "values.json"), "--namespace", "app-shop"], { encoding: "utf8" });
      return parseAllDocuments(out).map((x) => x.toJS()).filter(Boolean) as Array<{ kind: string; metadata: { name: string }; spec?: any }>;
    } finally { rmSync(d, { recursive: true, force: true }); }
  };
  const on = render(deliveredValues());
  assert.deepEqual(on.filter((x) => x.kind === "SealedSecret").map((x) => x.metadata.name).sort(),
    ["db-tunnel-key", "shop-db-migrate", "shop-db-server-ca", "shop-db-server-tls"]);
  assert.ok(on.some((x) => x.kind === "Deployment" && x.metadata.name === "db-tunnel"));
  const cl = on.find((x) => x.kind === "Cluster")!;
  assert.deepEqual(cl.spec.certificates, { serverCASecret: "shop-db-server-ca", serverTLSSecret: "shop-db-server-tls" });
  assert.equal(cl.spec.managed.roles[0].ensure, "present");
  const off = render(withoutDelivery(deliveredValues())!);
  assert.ok(!off.some((x) => x.metadata.name === "db-tunnel"), "터널 Deployment·Service·NetworkPolicy 없음");
  assert.deepEqual(off.filter((x) => x.kind === "SealedSecret").map((x) => x.metadata.name).sort(), ["shop-db-server-ca", "shop-db-server-tls"]);
  const role = off.find((x) => x.kind === "Cluster")!.spec.managed.roles[0];
  assert.deepEqual([role.name, role.ensure, role.passwordSecret], ["svc_migrate", "absent", undefined]);
});

test("CLI pubkey: 같은 입력이면 같은 공개 키 한 줄 (워커가 봉인하는 개인 키의 짝). 마스터 키가 짧으면 거부", () => {
  const run = (env: Record<string, string>) => spawnSync(process.execPath, ["--import", "tsx", "tools/repl-endpoint.ts", "pubkey", "--tenant", T, "--migration", M],
    { cwd: ROOT, encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env } });
  const a = run({ REPL_SECRET_MASTER_KEY: MK }), b = run({ REPL_SECRET_MASTER_KEY: MK });
  assert.equal(a.status, 0, a.stderr);
  assert.equal(a.stdout.trim(), deriveSshKeypair(MK, T, M).publicKeyLine);
  assert.equal(b.stdout, a.stdout);
  assert.match(a.stdout, /^ssh-ed25519 \S+ svc-migration-4a8c0000-0000-4000-8000-000000000001\n$/);
  assert.ok(!/PRIVATE/.test(a.stdout + a.stderr), "개인 키는 안 찍는다");
  const bad = run({ REPL_SECRET_MASTER_KEY: "short" });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /MASTER_KEY_TOO_SHORT/);
});
