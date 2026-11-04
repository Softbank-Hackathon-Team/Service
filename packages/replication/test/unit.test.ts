import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_GATE, judgeCutoverReady, namesFor, type LagSample } from "../src/index.js";
import { assertName } from "../src/sql.js";

const s = (ms: number, worker = true, bytes = 0): LagSample => ({ markerMs: ms, slot: { bytes, active: true, workerRunning: worker } });
const done = { tables: 3, ready: 3, states: { r: 3 }, done: true };

test("판정: 초기 복사 끝 + 지연 3번 연속 기준 아래면 전환 가능", () => {
  const r = judgeCutoverReady(done, [s(5000), s(20), s(30), s(40)]);
  assert.equal(r.ready, true);
  assert.deepEqual(r.lastLags, [20, 30, 40]);
});

test("판정: 마지막 3번 중 하나라도 느리면 불가", () => {
  const r = judgeCutoverReady(done, [s(20), s(1500), s(30)]);
  assert.equal(r.ready, false);
  assert.match(r.reasons.join(), /LAG_OVER_LIMIT/);
});

test("판정: 초기 복사 중이면 불가, 이유에 진행률", () => {
  const r = judgeCutoverReady({ tables: 3, ready: 1, states: { r: 1, d: 2 }, done: false }, []);
  assert.equal(r.ready, false);
  assert.match(r.reasons.join(), /INITIAL_COPY_NOT_DONE 1\/3/);
});

test("판정: 적용 워커가 멈췄거나 슬롯 지연이 크면 불가", () => {
  assert.match(judgeCutoverReady(done, [s(1), s(1), s(1, false)]).reasons.join(), /APPLY_WORKER_NOT_RUNNING/);
  assert.match(judgeCutoverReady(done, [s(1), s(1), s(1, true, DEFAULT_GATE.maxSlotBytes! + 1)]).reasons.join(), /SLOT_LAG_OVER_LIMIT/);
});

test("이름: 이전 키에서 방향별 이름, 위험한 문자는 막힘", () => {
  assert.deepEqual(namesFor("mig-01"), { fwd: "repl_mig_01_fwd", rev: "repl_mig_01_rev" });
  assert.throws(() => assertName('x"; DROP TABLE t; --'));
  assert.deepEqual(namesFor("9ABC-0d"), { fwd: "repl_9abc_0d_fwd", rev: "repl_9abc_0d_rev" });   // uuid는 숫자로 시작 가능
  assert.equal(namesFor("a99dda60-4dcb-4ee3-a3cc-605c0f0534af").fwd.length <= 63, true);
  assert.throws(() => namesFor(""));
});

// Z52 (Q16): 슬롯 WAL 안전장치 판정
const w = (walStatus: string | null, safeWalBytes: number | null = null): LagSample =>
  ({ markerMs: 10, slot: { bytes: 0, active: true, workerRunning: true, walStatus, safeWalBytes } });
const copied = { tables: 2, ready: 2, states: { r: 2 }, done: true };

test("Z52 슬롯이 lost면 보류 + fatal (재시도해도 소용없음)", () => {
  const r = judgeCutoverReady(copied, [w("reserved"), w("reserved"), w("lost")]);
  assert.equal(r.ready, false); assert.equal(r.fatal, true); assert.match(r.reasons.join(), /SLOT_LOST/);
});
test("Z52 unreserved면 보류, fatal 아님", () => {
  const r = judgeCutoverReady(copied, [w("reserved"), w("unreserved"), w("reserved")]);
  assert.equal(r.ready, false); assert.equal(r.fatal, undefined); assert.match(r.reasons.join(), /SLOT_WAL_UNRESERVED/);
});
test("Z52 safe_wal_size가 64MB 미만이면 보류, null(무제한)이면 통과", () => {
  assert.match(judgeCutoverReady(copied, [w("reserved", 1e9), w("reserved", 1e9), w("extended", 1024)]).reasons.join(), /SLOT_SAFE_WAL_LOW/);
  assert.equal(judgeCutoverReady(copied, [w("reserved"), w("reserved"), w("reserved")]).ready, true);
  assert.equal(judgeCutoverReady(copied, [w("reserved", 1e9), w("reserved", 1e9), w("reserved", 1e9)]).ready, true);
});

test("PF-E7 (FM-APP-16): 구독 접속 문자열에 connect_timeout 기본 10초, 이미 있거나 0 이면 그대로", async () => {
  const { withConnectTimeout } = await import("../src/repluser.js");
  assert.equal(withConnectTimeout("postgres://u:p@h:5432/db", {}), "postgres://u:p@h:5432/db?connect_timeout=10");
  assert.equal(withConnectTimeout("postgres://u:p@h/db?sslmode=require", {}), "postgres://u:p@h/db?sslmode=require&connect_timeout=10");
  assert.equal(withConnectTimeout("postgres://h/db?connect_timeout=3", {}), "postgres://h/db?connect_timeout=3");
  assert.equal(withConnectTimeout("postgres://h/db", { REPL_PEER_CONNECT_TIMEOUT_SEC: "0" }), "postgres://h/db");
  assert.equal(withConnectTimeout("host=h dbname=db", {}), "host=h dbname=db");
});

test("PF-E13 (FM-APP-24): 빈 값 REPL_* 는 기본값 (지연 한도 0ms·앱 계정 빈 이름이 안 됨)", async () => {
  const { replicationFromEnv } = await import("../src/worker.js");
  const m = replicationFromEnv("00000000-0000-4000-8000-0000000000e1", {
    REPL_SOURCE_URL: "postgres://u:p@h:5432/a", REPL_TARGET_URL: "postgres://u:p@h2:5432/a",
    REPL_MAX_LAG_MS: "", REPL_GATE_SAMPLES: "", REPL_TABLES: "", REPL_SOURCE_APP_ROLE: "", REPL_SOURCE_PROVIDER: "", REPL_TARGET_LABEL: "",
  })!;
  const cfg = (m as unknown as { cfg: { gate: { maxLagMs: number; consecutive: number }; tables?: string[]; source: { appRole: string; provider: string }; target: { label: string } } }).cfg;
  assert.equal(cfg.gate.maxLagMs, 500, "PF-E14: 기본은 T21 한도(500)와 같다");
  assert.equal(cfg.gate.consecutive, 3);
  assert.equal(cfg.tables, undefined);
  assert.equal(cfg.source.appRole, "app_user");
  assert.equal(cfg.source.provider, "postgres");
  assert.equal(cfg.target.label, "repl_target");
});

test("PF-E14 (FM-APP-25): 판정 지연 한도는 T21 한도(REPL_MAX_MARKER_RTT_MS)를 넘지 않는다", async () => {
  const { replicationFromEnv } = await import("../src/worker.js");
  const base = { REPL_SOURCE_URL: "postgres://u:p@h:5432/a", REPL_TARGET_URL: "postgres://u:p@h2:5432/a" };
  const lag = (env: Record<string, string>) => (replicationFromEnv("00000000-0000-4000-8000-0000000000e2", { ...base, ...env }) as unknown as { cfg: { gate: { maxLagMs: number } } }).cfg.gate.maxLagMs;
  assert.equal(lag({ REPL_MAX_LAG_MS: "1000" }), 500, "1000 을 줘도 T21 기본 500 으로 묶임");
  assert.equal(lag({ REPL_MAX_LAG_MS: "300" }), 300, "더 엄하면 그대로");
  assert.equal(lag({ REPL_MAX_MARKER_RTT_MS: "1500" }), 1500, "T21 한도를 올리면 판정 기본도 같이");
});

test("PF-E22 (FM-APP-hunt-deploy-db-02): {tf:} 를 못 채웠거나 빈 값이면 ReplConfigError (예전: 'Invalid URL' 로 재시도)", async () => {
  const { replicationFromEnv, ReplConfigError } = await import("../src/worker.js");
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const id = "00000000-0000-4000-8000-0000000000e3";
  const dir = mkdtempSync(join(tmpdir(), "pfe22-"));
  const f = join(dir, "facts.json");
  writeFileSync(f, JSON.stringify({ db_address: "", db_name: "", db_username: "u", db_password: "p" }));
  const base = { REPL_SOURCE_URL: "postgres://u:p@h:5432/a", TF_WORK_DIR: dir, REPL_FACTS_FILES: f };
  assert.throws(() => replicationFromEnv(id, { ...base, REPL_TARGET_URL: "postgres://{tf:db_username}:{tf:db_password}@{tf:db_address}:5432/{tf:db_name}" }),
    (e: unknown) => e instanceof ReplConfigError && e.code === "REPL_TF_FACTS_MISSING" && /REPL_TARGET_URL/.test((e as Error).message));
  assert.throws(() => replicationFromEnv(id, { ...base, REPL_TARGET_URL: "postgres://u:p@h:5432/{tf:no_such_key}" }),
    (e: unknown) => e instanceof ReplConfigError && /no_such_key/.test((e as Error).message));
  // 정상: 다 채워지면 그대로
  writeFileSync(f, JSON.stringify({ db_address: "db.example", db_name: "shop", db_username: "u", db_password: "p" }));
  assert.ok(replicationFromEnv(id, { ...base, REPL_TARGET_URL: "postgres://{tf:db_username}:{tf:db_password}@{tf:db_address}:5432/{tf:db_name}" }));
});
