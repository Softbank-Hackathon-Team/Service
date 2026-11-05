// 온프레 CNPG 이전 배달물 (db 0050 relay_*·sealed_material + deploy replicationDeliveryStep):
//   중계기 칸 저장·거부(도착 줄에만, 주소·호스트 키 같이, 개인 키 거부), 배포 단계가 끝점 줄에 되쓰기(회사 벽 안),
//   다시 렌더하면 저장된 봉인 값을 그대로 (같은 값 바이트), 운영자가 도착 줄을 다시 set 해도 봉인 값은 남고 CA 가 비면 다시 발급
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { ReplicationEndpoint } from "@svc/contracts";
import { DEMO_SPEC, STUB_TF_OUTPUTS, stubTfOutputsV2 } from "@svc/adapters";
import type { DeployInput } from "../src/gitops/index.js";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const hasOpenssl = (() => { try { execFileSync("openssl", ["version"], { stdio: "ignore" }); return true; } catch { return false; } })();
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;
const MK = "test-master-key-0123456789abcdef-xyz";   // 시험용 가짜 키
const KNOWN = "203.0.113.7 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeHostKeyForRenderOnly";
const RDS = "shop.abc123.ap-northeast-2.rds.amazonaws.com";
let core: typeof import("@svc/core");
let deploy: typeof import("../src/jobs/deploy.js");
let gitops: typeof import("../src/gitops/index.js");
let planMod: typeof import("../src/jobs/plan.js");
let precheck: typeof import("../src/jobs/precheck.js");
let owner: pg.Client;
const T = randomUUID(), U = randomUUID();

before(async () => {
  if (skip) return;
  core = await import("@svc/core");
  deploy = await import("../src/jobs/deploy.js");
  gitops = await import("../src/gitops/index.js");
  planMod = await import("../src/jobs/plan.js");
  precheck = await import("../src/jobs/precheck.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  for (const t of [T, U]) await owner.query("INSERT INTO tenants (id, name) VALUES ($1, 'repl-delivery')", [t]);
});
after(async () => {
  if (skip) return;
  await core.pool.end(); await owner.end();
});

async function seed(t: string) {
  const id = randomUUID(), s = randomUUID(), d = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status) VALUES ($1,$3,'aws','s','connected'), ($2,$3,'onprem','o','connected')`, [s, d, t]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status) VALUES ($1,$2,$3,$4,'deploying')`, [id, t, s, d]);
  return { id, targetEnvId: d };
}
const ep = (t: string, m: string, side: "source" | "target", o: Partial<ReplicationEndpoint> = {}): ReplicationEndpoint => ({
  tenantId: t, migrationId: m, side, label: `${side}-db`, provider: side === "source" ? "rds" : "cnpg", host: side === "source" ? RDS : "203.0.113.7",
  port: 5432, dbname: "shop", username: side === "source" ? "repl_admin" : "svc_migrate", passwordRef: side === "source" ? "env:REPL_SECRET_SRC_X" : "derive:migrate",
  peerHost: side === "target" ? "10.0.1.20" : null, peerPort: side === "target" ? 5432 : null, appRole: "app_user", fenceRoles: [], schemaName: null,
  sslmode: "require", tlsServername: null, caPem: null,
  relayHost: side === "target" ? "203.0.113.7" : null, relayKnownHosts: side === "target" ? KNOWN : null, relayPort: 22, ...o,
});
const put = (t: string, e: ReplicationEndpoint) => core.withTenant(t, (tx) => core.upsertReplicationEndpoint(tx, e));

test("중계기 칸: 도착 줄에 저장·읽기, 출발 줄·주소만·개인 키는 표(CHECK)와 계약이 거부", { skip }, async () => {
  const { id: M } = await seed(T);
  await put(T, ep(T, M, "source")); await put(T, ep(T, M, "target", { relayPort: 2222 }));
  const rows = await core.withTenant(T, (tx) => core.replicationEndpointsFor(tx, M));
  assert.deepEqual(rows.map((r) => [r.side, r.relayHost, r.relayKnownHosts, r.relayPort]),
    [["source", null, null, 22], ["target", "203.0.113.7", KNOWN, 2222]]);
  const raw = (cols: string, vals: string) => owner.query(`INSERT INTO replication_endpoints (tenant_id, migration_id, side, label, provider, host, port, dbname, username, password_ref${cols})
    VALUES ($1,$2,'source','x','postgres','h',5432,'d','u','derive:x'${vals})`, [T, M]);
  await owner.query("DELETE FROM replication_endpoints WHERE migration_id = $1 AND side = 'source'", [M]);
  await assert.rejects(raw(", relay_host, relay_known_hosts", ", 'r', 'r ssh-ed25519 AAAA'"), /replication_endpoints_relay_side/);
  await assert.rejects(raw(", sealed_material", ", '{}'::jsonb"), /replication_endpoints_relay_side/);
  await owner.query("DELETE FROM replication_endpoints WHERE migration_id = $1", [M]);
  const rawT = (cols: string, vals: string) => owner.query(`INSERT INTO replication_endpoints (tenant_id, migration_id, side, label, provider, host, port, dbname, username, password_ref${cols})
    VALUES ($1,$2,'target','x','cnpg','h',5432,'d','u','derive:x'${vals})`, [T, M]);
  await assert.rejects(rawT(", relay_host", ", '203.0.113.7'"), /replication_endpoints_relay_pair/);
  await assert.rejects(rawT(", relay_host, relay_known_hosts", ", 'h', '-----BEGIN OPENSSH PRIVATE KEY-----'"), /check constraint/);
  assert.equal(ReplicationEndpoint.safeParse(ep(T, M, "source", { relayHost: "1.2.3.4", relayKnownHosts: KNOWN })).success, false);
  assert.equal(ReplicationEndpoint.safeParse(ep(T, M, "target", { relayKnownHosts: null })).success, false);
  assert.equal(ReplicationEndpoint.safeParse(ep(T, M, "target", { relayKnownHosts: "-----BEGIN OPENSSH PRIVATE KEY-----\nabc" })).success, false);
});

// 데모 3티어 명세 → 온프레 도착 배포 입력 (계획 지문까지 진짜)
function onpremInput(tenantId: string, migrationId: string, targetEnvId: string): DeployInput {
  const plan = planMod.buildPlanDoc({ planId: randomUUID(), migrationId, spec: DEMO_SPEC, target: { envId: targetEnvId, provider: "onprem", region: "default" },
    precheck: precheck.stubPrecheck(), now: new Date() });
  return { tenantId, spec: DEMO_SPEC, plan, target: { envId: targetEnvId, provider: "onprem" as const, region: "default", accountId: null },
    tfOutputs: { ...STUB_TF_OUTPUTS, ...stubTfOutputsV2(DEMO_SPEC), "link.shop-db.host": "unused" } };
}
function sealingCert(): string {
  const d = mkdtempSync(join(tmpdir(), "svc-deliv-db-"));
  try {
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(d, "k.pem"), "-out", join(d, "c.pem"),
      "-days", "30", "-subj", "/CN=sealed-secret-test"], { stdio: "ignore" });
    return readFileSync(join(d, "c.pem"), "utf8");
  } finally { rmSync(d, { recursive: true, force: true }); }
}

test("배포 단계: 줄에 되쓰고(도착 CA·verify-full·봉인 값, 출발 peer=터널) 다시 렌더하면 같은 값 바이트. 다른 회사는 못 씀", { skip: skip || (!hasOpenssl && "openssl 없음") }, async () => {
  const { id: M, targetEnvId } = await seed(T);
  await put(T, ep(T, M, "source")); await put(T, ep(T, M, "target"));
  const cert = sealingCert();
  const job = { tenantId: T, requestId: `r-deliv-${M.slice(0, 8)}`, migrationId: M };
  const facts = async () => core.withTenant(T, async (tx) => ({
    records: await core.replicationEndpointsFor(tx, M), stored: await core.replicationSealedMaterialFor(tx, M), sealingCertPem: cert }));
  const env = { REPL_SECRET_MASTER_KEY: MK };
  const valuesOf = (i: DeployInput) => JSON.stringify(gitops.withDelivery(gitops.filledValues(i), i.replication!));

  const i1 = onpremInput(T, M, targetEnvId);
  const r1 = await deploy.replicationDeliveryStep(job, i1, await facts(), env);
  assert.ok(!("outcome" in r1), JSON.stringify("outcome" in r1 ? r1.outcome.detail : null));
  if ("outcome" in r1) return;
  assert.deepEqual(r1.warnings, []);
  assert.equal((r1.detail as { reused: boolean }).reused, false);
  assert.equal((r1.detail as { sourcePeerSet: boolean }).sourcePeerSet, true);
  const ns = String(gitops.filledValues(i1).namespace);
  const cnpg = gitops.replicationCnpgs(gitops.filledValues(i1))[0]!.name;
  const [src, dst] = await core.withTenant(T, (tx) => core.replicationEndpointsFor(tx, M));
  assert.deepEqual([src!.peerHost, src!.peerPort], [`db-tunnel.${ns}.svc`, 5432]);
  assert.deepEqual([dst!.sslmode, dst!.tlsServername], ["verify-full", `${cnpg}-rw.${ns}.svc`]);
  assert.match(dst!.caPem!, /BEGIN CERTIFICATE/);
  const stored = await core.withTenant(T, (tx) => core.replicationSealedMaterialFor(tx, M));
  assert.deepEqual(stored!.sealedSecrets.map((s) => s.name), [`${cnpg}-migrate`, `${cnpg}-server-ca`, `${cnpg}-server-tls`, "db-tunnel-key"]);

  // 다시 렌더 (리허설 뒤 커밋 작업, 재개): 저장된 봉인 값 그대로 → 같은 값 바이트, 줄은 안 바꿈
  const i2 = onpremInput(T, M, targetEnvId);
  i2.plan = i1.plan;
  const r2 = await deploy.replicationDeliveryStep(job, i2, await facts(), env);
  assert.ok(!("outcome" in r2));
  if ("outcome" in r2) return;
  assert.deepEqual([(r2.detail as { reused: boolean }).reused, (r2.detail as { rowsUpdated: boolean }).rowsUpdated], [true, false]);
  assert.equal(valuesOf(i2), valuesOf(i1));

  // 운영자가 도착 줄을 다시 set (ca_pem 비움) → 봉인 값 칸은 남지만 CA 가 달라 다시 발급·봉인
  await put(T, ep(T, M, "target"));
  assert.ok(await core.withTenant(T, (tx) => core.replicationSealedMaterialFor(tx, M)), "upsert 는 sealed_material 을 안 지운다");
  const i3 = onpremInput(T, M, targetEnvId);
  i3.plan = i1.plan;
  const r3 = await deploy.replicationDeliveryStep(job, i3, await facts(), env);
  assert.ok(!("outcome" in r3) && (r3.detail as { reused: boolean }).reused === false);
  assert.notEqual(valuesOf(i3), valuesOf(i1));

  // 다른 회사: 같은 이전 번호로 되쓰기 → 줄이 안 보여 오류 (RLS)
  await assert.rejects(core.withTenant(U, (tx) => core.recordReplicationDelivery(tx, { migrationId: M,
    target: { caPem: dst!.caPem!, tlsServername: "evil.example", sealed: stored! } })), /도착 줄이 이 회사에 없다/);
  const after = await core.withTenant(T, (tx) => core.replicationEndpointsFor(tx, M));
  assert.notEqual(after[1]!.tlsServername, "evil.example");
});

test("배포 단계 거부: 봉인 인증서 없음 → paused SEALING_CERT_MISSING, 줄은 안 바뀜. 줄 없음 → 값 그대로 + 경고", { skip }, async () => {
  const { id: M, targetEnvId } = await seed(T);
  const job = { tenantId: T, requestId: `r-deliv-${M.slice(0, 8)}`, migrationId: M };
  const none = await deploy.replicationDeliveryStep(job, onpremInput(T, M, targetEnvId), { records: [], stored: null, sealingCertPem: null }, { REPL_SECRET_MASTER_KEY: MK });
  assert.ok(!("outcome" in none));
  if (!("outcome" in none)) { assert.equal(none.detail, undefined); assert.match(none.warnings[0]!, /복제 끝점 줄/); }
  await put(T, ep(T, M, "source")); await put(T, ep(T, M, "target"));
  const records = await core.withTenant(T, (tx) => core.replicationEndpointsFor(tx, M));
  const i = onpremInput(T, M, targetEnvId);
  const r = await deploy.replicationDeliveryStep(job, i, { records, stored: null, sealingCertPem: null }, { REPL_SECRET_MASTER_KEY: MK });
  assert.ok("outcome" in r);
  if ("outcome" in r) {
    assert.deepEqual([r.outcome.to, r.outcome.failureCode], ["paused", "SEALING_CERT_MISSING"]);
    assert.equal((r.outcome.detail as { deploy: { error: string } }).deploy.error, "SEALING_CERT_MISSING");
  }
  assert.equal(i.replication, undefined, "값에 아무것도 안 넣었다");
  const rows = await core.withTenant(T, (tx) => core.replicationEndpointsFor(tx, M));
  assert.deepEqual(rows.map((x) => [x.peerHost, x.caPem, x.sslmode]), [[null, null, "require"], ["10.0.1.20", null, "require"]]);
});
