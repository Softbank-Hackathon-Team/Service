// 온프레 이전 중계기 단계 (relay/relay-step.ts · relay/onprem-egress.ts) — 진짜 DB, 가짜 aws·가짜 역할 빌리기
//   Agent facts 의 나가는 IP 읽기(폐기 키·오래된 보고는 안 씀), 명세 ids 에서 출발 RDS 찾기, 끝점 두 줄 쓰기(회사 벽 안),
//   다시 돌면 배달이 채운 칸 유지, 정리 뒤 태그 자원 0, IP 모르면 ONPREM_EGRESS_UNKNOWN 으로 아무것도 안 만듦
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { DEMO_INVENTORY, normalizeV2 } from "@svc/adapters";
import { FakeAws, fakeDeps } from "./fake-aws-relay.js";

const DB = process.env.DATABASE_URL, OWNER = process.env.OWNER_DATABASE_URL;
const skip = !DB || !OWNER ? "DATABASE_URL / OWNER_DATABASE_URL 없음 (DB 시험 건너뜀)" : false;
const MK = "test-master-key-0123456789abcdef-xyz";   // 시험용 가짜 키
const RDS = "shop-db.c1abcdefgh.ap-northeast-2.rds.amazonaws.com";
const ENV = { REPL_SECRET_MASTER_KEY: MK, PLATFORM_EGRESS_CIDRS: "198.51.100.7/32" } as NodeJS.ProcessEnv;
let core: typeof import("@svc/core");
let step: typeof import("../src/relay/relay-step.js");
let egress: typeof import("../src/relay/onprem-egress.js");
let owner: pg.Client;
const T = randomUUID(), U = randomUUID();

before(async () => {
  if (skip) return;
  core = await import("@svc/core");
  step = await import("../src/relay/relay-step.js");
  egress = await import("../src/relay/onprem-egress.js");
  owner = new pg.Client({ connectionString: OWNER }); await owner.connect();
  for (const t of [T, U]) await owner.query("INSERT INTO tenants (id, name) VALUES ($1, 'relay-step')", [t]);
});
after(async () => {
  if (skip) return;
  await core.pool.end(); await owner.end();
});

async function seed(t: string, o: { egressIp?: string | null; externalId?: string | null } = {}) {
  const id = randomUUID(), s = randomUUID(), d = randomUUID();
  await owner.query(`INSERT INTO environments (id, tenant_id, provider, name, connection_status, region, external_id) VALUES
    ($1,$3,'aws','s','connected','ap-northeast-2',$4), ($2,$3,'onprem','o','connected',NULL,NULL)`,
    [s, d, t, o.externalId === undefined ? `ext-${randomBytes(6).toString("hex")}` : o.externalId]);
  await owner.query(`INSERT INTO migrations (id, tenant_id, source_env_id, target_env_id, status) VALUES ($1,$2,$3,$4,'provisioning')`, [id, t, s, d]);
  // 데모 AWS 가져오기 결과 그대로 (ids 에 RDS ARN → shop-db)
  await owner.query(`INSERT INTO spec_versions (tenant_id, migration_id, version, spec, field_meta, spec_v2) VALUES ($1,$2,1,'{}','{}',$3)`,
    [t, id, JSON.stringify(normalizeV2(DEMO_INVENTORY.aws).result)]);
  const k = `ak_${randomBytes(12).toString("hex")}`;
  await owner.query(`INSERT INTO agent_keys (id, tenant_id, env_id) VALUES ($1,$2,$3)`, [k, t, d]);
  if (o.egressIp !== null) await report(t, d, k, o.egressIp ?? "203.0.113.9", 30);
  return { m: { id, status: "provisioning" as const, sourceEnvId: s, targetEnvId: d }, key: k };
}
async function report(t: string, envId: string, k: string, ip: string | undefined, agoSec: number) {
  const body = { kind: "facts", agentVersion: "t", sentAt: "2026-11-05T00:00:00Z", grants: { level: "L0" }, dbs: [], ...(ip ? { egressIp: ip } : {}) };
  await owner.query(`INSERT INTO agent_reports (tenant_id, env_id, key_id, kind, signature, sent_at, received_at, body)
    VALUES ($1,$2,$3,'facts',$4, now() - make_interval(secs => $5), now() - make_interval(secs => $5), $6)`,
    [t, envId, k, randomBytes(16).toString("hex"), agoSec, JSON.stringify(body)]);
}
const borrow = async <R>(fn: (r: { awsEnv?: Record<string, Record<string, string>>; denied: [] }) => Promise<R>) =>
  fn({ awsEnv: { source: { AWS_CONFIG_FILE: "/dev/null" } }, denied: [] });

test("나가는 IP 읽기: 가장 최근 egressIp, 폐기된 키·오래된 보고·칸 없는 보고는 안 씀, 다른 회사는 안 보임", { skip }, async () => {
  const { m, key } = await seed(T, { egressIp: null });
  const read = (t = T, env: NodeJS.ProcessEnv = {}) => core.withTenant(t, (tx) => egress.latestOnpremEgressIp(tx, t, m.targetEnvId, env));
  assert.equal(await read(), undefined);
  await report(T, m.targetEnvId, key, "203.0.113.1", 600);
  await report(T, m.targetEnvId, key, undefined, 10);   // 이번 회차는 IP 를 못 받음 → 앞 것
  assert.equal((await read())?.ip, "203.0.113.1");
  assert.equal(await read(T, { AGENT_FACTS_MAX_AGE_SEC: "300" }), undefined, "오래된 값으로 22 를 열지 않는다");
  const k2 = `ak_${randomBytes(12).toString("hex")}`;
  await owner.query(`INSERT INTO agent_keys (id, tenant_id, env_id, revoked_at) VALUES ($1,$2,$3, now())`, [k2, T, m.targetEnvId]);
  await report(T, m.targetEnvId, k2, "198.51.100.66", 1);
  assert.equal((await read())?.ip, "203.0.113.1", "폐기된 키의 보고는 안 씀");
  assert.equal(await read(U), undefined, "다른 회사");
});

test("단계 정상: 명세에서 출발 RDS 를 찾아 중계기를 만들고 끝점 두 줄을 쓴다. 다시 돌면 같은 자원·배달 칸 유지, 정리하면 태그 자원 0", { skip }, async () => {
  const { m } = await seed(T);
  const f = new FakeAws(RDS, m.id);
  const j = { tenantId: T, migrationId: m.id };
  const facts = await core.withTenant(T, (tx) => step.readRelayFacts(tx, T, m, ENV));
  assert.deepEqual([facts.rdsIdentifier, facts.onpremEgressIp, facts.postgres.length, facts.sourceProvider, facts.targetProvider],
    ["shop-db", "203.0.113.9", 1, "aws", "onprem"]);
  const r1 = await step.provisionRelayStep(j, m, { env: ENV, borrow, aws: fakeDeps(f) });
  assert.equal(r1.kind, "ok", JSON.stringify(r1));
  const [src, dst] = await core.withTenant(T, (tx) => core.replicationEndpointsFor(tx, m.id));
  // 출발 = 중계기 출발 입구 (공개 IP:15432, DB 줄 검사 통과), 진짜 RDS 이름은 tls_servername
  assert.deepEqual([src!.side, src!.host, src!.port, src!.tlsServername, src!.username, src!.dbname, src!.passwordRef.startsWith("env:REPL_SECRET_SRC_")],
    ["source", "203.0.113.50", 15432, RDS, "postgres", "shop_api", true]);
  assert.deepEqual([dst!.side, dst!.host, dst!.peerHost, dst!.relayHost, dst!.username, dst!.passwordRef], ["target", "203.0.113.50", "10.0.1.20", "203.0.113.50", "svc_migrate", "derive:migrate"]);
  assert.match(dst!.relayKnownHosts!, /^203\.0\.113\.50 ssh-ed25519 [A-Za-z0-9+/=]+$/);
  // 배달(deploy)이 채운 칸
  await owner.query(`UPDATE replication_endpoints SET ca_pem = '-----BEGIN CERTIFICATE-----\nx', sslmode = 'verify-full', tls_servername = 'x-rw.app.svc' WHERE migration_id = $1 AND side = 'target'`, [m.id]);
  await owner.query(`UPDATE replication_endpoints SET peer_host = 'db-tunnel.app.svc', peer_port = 5432 WHERE migration_id = $1 AND side = 'source'`, [m.id]);
  const runs = f.ops().filter((o) => o === "ec2 run-instances").length;
  const r2 = await step.provisionRelayStep(j, m, { env: ENV, borrow, aws: fakeDeps(f) });
  assert.equal(r2.kind, "ok");
  assert.equal(f.ops().filter((o) => o === "ec2 run-instances").length, runs, "다시 돌아도 EC2 를 또 안 만듦");
  const [s2, t2] = await core.withTenant(T, (tx) => core.replicationEndpointsFor(tx, m.id));
  assert.deepEqual([s2!.peerHost, t2!.sslmode, t2!.tlsServername], ["db-tunnel.app.svc", "verify-full", "x-rw.app.svc"]);
  // 다른 회사로는 같은 이전 줄이 안 보인다
  assert.deepEqual(await core.withTenant(U, (tx) => core.replicationEndpointsFor(tx, m.id)), []);

  const t = await step.teardownRelayStep(j, m, { env: ENV, borrow, aws: fakeDeps(f) });
  assert.equal(t.kind, "ok");
  assert.equal([...f.insts.values()].filter((x) => x.state !== "terminated").length, 0);
  assert.equal([...f.sgs.keys()].filter((k) => k !== "sg-0rds").length, 0);
  assert.equal(f.rules.filter((r) => r.group === "sg-0rds" && r.egress).length, 0, "RDS 나가기 규칙 걷음");
});

test("단계 거부: 나가는 IP 모름 → ONPREM_EGRESS_UNKNOWN, 시드 환경(external_id 없음) → 건너뜀. 둘 다 aws·끝점 줄 0", { skip }, async () => {
  const a = await seed(T, { egressIp: null });
  const f = new FakeAws(RDS, a.m.id);
  const r = await step.provisionRelayStep({ tenantId: T, migrationId: a.m.id }, a.m, { env: ENV, borrow, aws: fakeDeps(f) });
  assert.equal(r.kind === "failed" && r.failureCode, "ONPREM_EGRESS_UNKNOWN");
  const b = await seed(T, { externalId: null });
  const r2 = await step.provisionRelayStep({ tenantId: T, migrationId: b.m.id }, b.m, { env: ENV, borrow, aws: fakeDeps(f) });
  assert.deepEqual(r2, { kind: "skipped", reason: "source_creds_mock" });
  assert.equal(f.calls.length, 0);
  for (const id of [a.m.id, b.m.id]) assert.deepEqual(await core.withTenant(T, (tx) => core.replicationEndpointsFor(tx, id)), []);
});
