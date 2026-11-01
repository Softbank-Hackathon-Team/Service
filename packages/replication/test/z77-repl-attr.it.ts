// Z77 (맥 실측 00:01Z 전환 C5 뒤 "must be superuser or replication role"): Cloud SQL 관리자 역할만으로는 슬롯을 못 만든다
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { ensureReplicationAttr, precheck, type Endpoint } from "../src/index.js";
import { SOURCE, TARGET, q, reachable } from "./harness.js";

const up = (await reachable(SOURCE)) && (await reachable(TARGET));
const skip = up ? false : "docker Postgres(55432/55433)가 안 떠 있음: npm run db:up";
const as = (user: string, pw: string, provider: Endpoint["provider"] = "cloudsql"): Endpoint => {
  const u = new URL(TARGET.adminUrl); u.username = user; u.password = pw;
  return { ...TARGET, label: `dst-${user}`, provider, adminUrl: u.toString() };
};

before(async () => {
  if (!up) return;
  await q(TARGET, `ALTER DATABASE app RESET default_transaction_read_only`);
  await q(TARGET, `DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cloudsqlsuperuser') THEN CREATE ROLE cloudsqlsuperuser NOLOGIN; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'z77_csql') THEN CREATE ROLE z77_csql LOGIN PASSWORD 'p' CREATEROLE; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'z77_repl') THEN CREATE ROLE z77_repl LOGIN PASSWORD 'p' REPLICATION; END IF;
    END $$; GRANT cloudsqlsuperuser TO z77_csql; ALTER ROLE z77_csql NOREPLICATION`);
});
after(async () => { if (up) await q(TARGET, `DROP ROLE IF EXISTS z77_csql; DROP ROLE IF EXISTS z77_repl`).catch(() => undefined); });

test("cloudsql 이 아니면 손대지 않는다", { skip }, async () => {
  assert.equal((await ensureReplicationAttr(as("z77_csql", "p", "postgres"))).result, "skipped");
});

test("이미 REPLICATION·superuser 면 already", { skip }, async () => {
  assert.equal((await ensureReplicationAttr(as("z77_repl", "p"))).result, "already");
  assert.equal((await ensureReplicationAttr({ ...TARGET, provider: "cloudsql" })).result, "already");
});

test("cloudsqlsuperuser 만 있고 REPLICATION 이 없으면: 줄 수 없는 서버에선 failed, precheck DB-04 가 멈춘다", { skip }, async () => {
  const e = as("z77_csql", "p");
  const r = await ensureReplicationAttr(e);
  // 일반 PG16 은 superuser 가 아니면 REPLICATION 을 못 준다 (Cloud SQL 은 cloudsqlsuperuser 에게 허용 【추정, 맥에서 확인】)
  assert.equal(r.result, "failed");
  assert.match(r.error!, /permission denied|must be superuser|REPLICATION/i);
  // precheck 은 관리형(cloudsql)에 TLS 없이 붙으면 연결 전에 멈추므로(NET-TLS0), 같은 계정을 일반 postgres 로 넘겨 DB-04 만 본다
  const pc = await precheck(SOURCE, as("z77_csql", "p", "postgres"));
  const t = pc.checks.find((c) => c.id === "DB-04" && c.side === "target")!;
  assert.equal(t.ok, false, "예전엔 cloudsqlsuperuser 만으로 통과했다");
  assert.match(t.hint!, /REPLICATION/);
  assert.match(t.detail, /rdsReplication=false/);
});
