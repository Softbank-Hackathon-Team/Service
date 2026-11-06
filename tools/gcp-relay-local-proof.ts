// AWS→GCP 중계기 복제 길을 로컬에서 끝까지 돌려 보는 도구 (DRAFT(ai), 클라우드 자원 없음).
//   출발 RDS 자리·도착 Cloud SQL 자리 = TLS 켠 Postgres 컨테이너 둘, 중계기 = aws-relay.ts 의 RELAY_FORWARDER_PY 그대로 (호스트에서 두 입구)
//   끝점 두 줄은 relay-step gcpEndpointRows 로 만들고(도착 관리자 password_ref tf:db_admin_password), 복제는 @svc/replication 그대로
//   (스키마 복사 → 점검 → 정방향 → 컷오버 → 역방향 → 정리). 같은 DB 로 두 번째 이전을 한 번 더 돌려 남은 것이 없는지 본다.
// 실행 (컨테이너는 사람이 띄운다. README 대신 이 줄):
//   PROOF_SRC=postgres://postgres:postgres@127.0.0.1:56432/shop PROOF_DST=postgres://postgres:postgres@127.0.0.1:56433/shop PROOF_CA=<CA PEM 경로> \
//   node --import tsx tools/gcp-relay-local-proof.ts
// 로컬과 진짜의 차이 (보고서에 적는다): 컨테이너는 호스트 입구에 host.docker.internal 로 붙는다, 역방향 입구 포트 25432(진짜는 중계 사설 IP:5432),
//   출발 비밀번호는 env: 참조(진짜는 aws-sm), 도착 관리자는 superuser(진짜는 cloudsqlsuperuser + REPLICATION)
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { NO_TRAFFIC_HOOKS, replicationFromRecords, type EndpointRecord } from "@svc/replication";
import { RELAY_FORWARDER_PY } from "../apps/worker/src/relay/aws-relay.js";
import { ensureTargetAppLogin, gcpEndpointRows } from "../apps/worker/src/relay/relay-step.js";

const SRC = process.env.PROOF_SRC ?? "postgres://postgres:postgres@127.0.0.1:56432/shop";
const DST = process.env.PROOF_DST ?? "postgres://postgres:postgres@127.0.0.1:56433/shop";
const CA = readFileSync(process.env.PROOF_CA ?? "", "utf8");
const FWD = 15432, REV = 25432, PEER_HOST = process.env.PROOF_PEER_HOST ?? "host.docker.internal";
const T = "11111111-1111-4111-8111-111111111111";
const ADMIN = "svc_admin_0123456789", ADMIN_PW = "admin-pw-local", APP = "shop_app", APP_PW = "app-pw-local";
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 23), ...a);

async function sql(url: string, q: string, args: unknown[] = []) {
  const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await c.connect();
  try { return (await c.query(q, args)).rows; } finally { await c.end(); }
}
const portOf = (u: string) => Number(new URL(u).port);
const asUser = (u: string, user: string, pw: string) => { const x = new URL(u); x.username = user; x.password = pw; return x.toString(); };

function relay(upPort: number, listen: number): ChildProcess {
  const dir = mkdtempSync(join(tmpdir(), "relay-fwd-"));
  writeFileSync(join(dir, "fwd.py"), RELAY_FORWARDER_PY);
  return spawn("python3", [join(dir, "fwd.py"), "127.0.0.1", String(upPort), String(listen)], { stdio: "inherit" });
}

async function resetDbs() {
  await sql(SRC, `SET default_transaction_read_only = off; ALTER DATABASE shop RESET default_transaction_read_only; DROP SCHEMA IF EXISTS _repl CASCADE; DROP TABLE IF EXISTS orders, customers;
    DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${APP}') THEN CREATE ROLE ${APP} LOGIN PASSWORD 'src-app'; END IF; END $$;
    CREATE TABLE customers (id bigserial PRIMARY KEY, name text NOT NULL);
    CREATE TABLE orders (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, customer_id bigint NOT NULL REFERENCES customers(id), amount int NOT NULL);
    GRANT SELECT, INSERT, UPDATE, DELETE ON customers, orders TO ${APP}; GRANT USAGE ON SEQUENCE customers_id_seq, orders_id_seq TO ${APP};
    INSERT INTO customers (name) SELECT 'c' || g FROM generate_series(1, 200) g;
    INSERT INTO orders (customer_id, amount) SELECT 1 + (g % 200), g FROM generate_series(1, 1000) g;`);
  await sql(DST, `SET default_transaction_read_only = off; ALTER DATABASE shop RESET default_transaction_read_only; DROP SCHEMA IF EXISTS _repl CASCADE; DROP TABLE IF EXISTS orders, customers;
    DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${ADMIN}') THEN CREATE ROLE ${ADMIN} LOGIN SUPERUSER PASSWORD '${ADMIN_PW}'; END IF; END $$;
    DROP OWNED BY ${APP}; DROP ROLE IF EXISTS ${APP};`).catch(async () => {
    await sql(DST, `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${ADMIN}') THEN CREATE ROLE ${ADMIN} LOGIN SUPERUSER PASSWORD '${ADMIN_PW}'; END IF; END $$;`);
  });
}

async function leftovers(url: string) {
  return (await sql(url, `SELECT (SELECT count(*) FROM pg_replication_slots)::int slots, (SELECT count(*) FROM pg_publication)::int pubs,
    (SELECT count(*) FROM pg_subscription)::int subs, (SELECT count(*) FROM pg_roles WHERE rolname LIKE 'repl\\_%\\_u')::int repl_users`))[0];
}

async function waitFor<T>(what: string, fn: () => Promise<T | undefined>, ms = 60_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn().catch(() => undefined);
    if (v !== undefined) return v;
    if (Date.now() - t0 > ms) throw new Error(`timeout: ${what}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function oneMigration(round: number) {
  const mid = randomUUID();
  const tfRoot = mkdtempSync(join(tmpdir(), "tfw-"));
  const dir = join(tfRoot, `t-${T.slice(0, 8)}`, mid);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "outputs.json"), JSON.stringify({ db_admin_username: ADMIN, db_username: APP, db_name: "shop", db_server_ca_cert: CA }));
  writeFileSync(join(dir, "db-secret.json"), JSON.stringify({ db_password: APP_PW, db_admin_password: ADMIN_PW }), { mode: 0o600 });
  const env = { ...process.env, TF_WORK_DIR: tfRoot, REPL_SECRET_LOCALSRC: "postgres", REPL_COPY_SCHEMA: "1", REPL_SUBSCRIBE_TIMEOUT_SEC: "30" };

  const rds = { identifier: "sample-shop-db", endpoint: "sample-shop-db.local", port: 5432, vpcId: "vpc-local", securityGroupIds: ["sg-local"],
    masterUsername: "postgres", dbName: "shop", masterSecretArn: null };
  const [s0, t0] = gcpEndpointRows({ tenantId: T, migrationId: mid, sourceEnvId: "783df2ef-8dbf-4a20-904d-bb02aeb96332", rds, db: "shop", appUser: APP,
    publicIp: "127.0.0.1", privateIp: PEER_HOST, cloudSql: { publicIp: "127.0.0.1", outgoingIp: "127.0.0.2" },
    out: JSON.parse(readFileSync(join(dir, "outputs.json"), "utf8")), existing: [] });
  // 로컬 차이만 덮는다: 출발 비밀번호 env:, 컨테이너가 호스트 입구로 붙는 이름, 도착 컨테이너 포트·역방향 입구 포트
  const source: EndpointRecord = { ...s0, passwordRef: "env:REPL_SECRET_LOCALSRC", port: FWD, peerHost: PEER_HOST, peerPort: FWD, tlsServername: null };
  const target: EndpointRecord = { ...t0, port: portOf(DST), peerPort: REV };
  log(`[${round}] rows: source ${source.host}:${source.port} (peer ${source.peerHost}:${source.peerPort}, ${source.sslmode}), target ${target.host}:${target.port} `
    + `${target.username}/${target.passwordRef} (${target.sslmode}, peer ${target.peerHost}:${target.peerPort}) app=${target.appRole}`);

  log(`[${round}] app login on target:`, await ensureTargetAppLogin({ ...t0, port: portOf(DST) }, env));
  const m = replicationFromRecords(mid, [source, target], env)!;
  assert.equal(m.cfg.target.tls?.mode, "verify-ca");
  const copy = await m.prepareTarget();
  log(`[${round}] schema copy:`, copy?.created);
  const pc = await m.precheck();
  const bad = pc.checks.filter((c) => !c.ok && c.level !== "warn");
  log(`[${round}] precheck ok=${pc.ok}`, bad.map((c) => `${c.side}:${c.id} ${c.detail}`));
  assert.ok(pc.ok, "precheck");

  let r = await m.sync({ waitCopyMs: 30_000 });
  for (let k = 0; !r.gate.ready && k < 20; k++) { await new Promise((x) => setTimeout(x, 1000)); r = await m.sync({ waitCopyMs: 30_000 }); }
  log(`[${round}] sync gate ready=${r.gate.ready} copy=${JSON.stringify(r.copy)} lag=${r.measures.find((x) => x.name === "replication_lag_ms")?.value}ms`);
  assert.ok(r.gate.ready, `gate: ${r.gate.reasons.join(",")}`);

  await sql(SRC, `INSERT INTO orders (customer_id, amount) VALUES (7, 424242)`);
  const fwd = await waitFor("forward row on target", async () => {
    const x = await sql(asUser(DST, ADMIN, ADMIN_PW), `SELECT count(*)::int n FROM orders WHERE amount = 424242`);
    return x[0].n === 1 ? x[0].n : undefined;
  });
  log(`[${round}] L1+L3 forward: new source row visible on target (n=${fwd})`);
  const fsub = await sql(DST, `SELECT subname, subconninfo ~ ':${FWD}' AS via_relay, subconninfo ~ 'sslmode=require' AS tls FROM pg_subscription`);
  const fssl = await sql(SRC, `SELECT count(*) FILTER (WHERE s.ssl)::int tls, count(*)::int n FROM pg_stat_ssl s JOIN pg_stat_activity a USING (pid) WHERE a.backend_type = 'walsender'`);
  log(`[${round}] target subscription`, fsub.map((x) => ({ name: x.subname, viaRelay: x.via_relay, tls: x.tls })), "source walsender TLS", fssl[0]);
  assert.ok(fsub.length === 1 && fsub[0].via_relay && fsub[0].tls && fssl[0].n >= 1 && fssl[0].tls === fssl[0].n, "정방향 구독이 중계 입구로, TLS 로");
  const ev = await m.catchUpEvidence({ waitMs: 3000 });
  log(`[${round}] counts`, ev.counts, `rowCountMatch=${ev.rowCountMatch}`);

  const cut = await m.cutover({ hooks: NO_TRAFFIC_HOOKS, maxCatchupMs: 10_000 });
  log(`[${round}] cutover ok=${cut.ok} pauseMs=${cut.ok ? Math.round(cut.pauseMs) : "-"}`, cut.ok ? "" : JSON.stringify(cut).slice(0, 400));
  assert.ok(cut.ok, "cutover");
  assert.equal(await m.phase(), "reverse");

  // 컷오버 뒤 앱(도착 앱 로그인 역할, 비밀번호 = 앱 비밀 그릇 값)이 도착에 쓴다 → 롤백 창 역방향(L4: 출발 RDS → 중계 역방향 입구 → 도착)으로 출발에 온다
  await sql(asUser(DST, APP, APP_PW), `INSERT INTO orders (customer_id, amount) VALUES (9, 777777)`);
  const rev = await waitFor("reverse row on source", async () => {
    const x = await sql(SRC, `SELECT count(*)::int n FROM orders WHERE amount = 777777`);
    return x[0].n === 1 ? x[0].n : undefined;
  });
  log(`[${round}] L4 reverse: app write on target (as ${APP}) visible on source (n=${rev})`);
  const subs = await sql(SRC, `SELECT subname, subconninfo ~ ':${REV}' AS via_relay, subconninfo ~ 'sslmode=require' AS tls FROM pg_subscription`);
  log(`[${round}] source subscription`, subs.map((s) => ({ name: s.subname, viaRelay: s.via_relay, tls: s.tls })));
  const tlsSeen = await sql(DST, `SELECT count(*) FILTER (WHERE s.ssl)::int tls, count(*)::int n FROM pg_stat_ssl s JOIN pg_stat_activity a USING (pid) WHERE a.backend_type = 'walsender'`);
  log(`[${round}] target walsender sessions over TLS:`, tlsSeen[0]);
  assert.ok(subs.length === 1 && subs[0].via_relay && subs[0].tls && tlsSeen[0].n >= 1 && tlsSeen[0].tls === tlsSeen[0].n, "역방향 구독이 중계 역방향 입구로, TLS 로");

  const td = await m.teardown();
  log(`[${round}] teardown removed`, td.removed);
  const left = { source: await leftovers(SRC), target: await leftovers(DST), api: await m.leftovers() };
  log(`[${round}] leftovers`, left);
  assert.deepEqual([left.source, left.target, left.api], [{ slots: 0, pubs: 0, subs: 0, repl_users: 0 }, { slots: 0, pubs: 0, subs: 0, repl_users: 0 }, []]);
}

const relays = [relay(portOf(SRC), FWD), relay(portOf(DST), REV)];
try {
  await new Promise((r) => setTimeout(r, 800));
  await resetDbs();
  await oneMigration(1);
  // 같은 출발 DB 를 팀이 되돌린 뒤(도착 표·앱 계정 지움) 두 번째 이전: 점검부터 다시 통과해야 한다
  await resetDbs();
  await oneMigration(2);
  log("PROOF OK");
} finally {
  for (const p of relays) p.kill();
}
