// PF-E12 (FM-APP-21): 도착에 남은 구독이 논리 복제 일꾼 자리(max_logical_replication_workers, 기본 4)를 채우면 새 구독의 초기 복사가
//   i 상태에서 안 움직인다. 점검 DB-07 이 미리 잡고, sync 는 "복사 중"으로 오래 기다리지 않고 이유(일꾼 수·상태)를 남긴다. 진짜 Postgres 두 개
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { Migration, precheck } from "../src/index.js";
import { SOURCE, TARGET, TABLES, q, reachable, resetAndSeed, sleep } from "./harness.js";

const up = (await reachable(SOURCE)) && (await reachable(TARGET));
let skip: string | false = up ? false : "Postgres 두 개(55432/55433) 없음";
const m = new Migration({ key: "pfe12", source: SOURCE, target: TARGET, tables: TABLES });
let fillers: string[] = [];
const peer = SOURCE.peerUrl ?? SOURCE.adminUrl;   // hdd-04: harness 와 같은 주소 (IT_SOURCE_PEER_URL 이 없으면 docker 망 src:5432)

async function dropFillers() {
  for (const n of fillers) {
    await q(TARGET, `DROP SUBSCRIPTION IF EXISTS ${n}`).catch(() => undefined);
    await q(SOURCE, `SELECT pg_drop_replication_slot(slot_name) FROM pg_replication_slots WHERE slot_name=$1 AND NOT active`, [n]).catch(() => undefined);
    await q(SOURCE, `DROP PUBLICATION IF EXISTS ${n}`).catch(() => undefined);
  }
}
before(async () => {
  if (!up) return;
  await resetAndSeed(200);
  const [r] = await q(TARGET, `SELECT least(current_setting('max_logical_replication_workers')::int, current_setting('max_worker_processes')::int) mx,
    (SELECT count(*)::int FROM pg_subscription WHERE subenabled) n`);
  const k = r.mx - r.n - 1;   // 적용 일꾼 1자리만 남긴다
  if (k < 1 || k > 12) { skip = `일꾼 자리 ${r.mx}, 켜진 구독 ${r.n} → 시험 모양이 안 맞음`; return; }
  fillers = Array.from({ length: k }, (_, i) => `pfe12_fill_${i}`);
  await dropFillers();
  for (const n of fillers) {
    await q(SOURCE, `CREATE PUBLICATION ${n}`);
    await q(TARGET, `CREATE SUBSCRIPTION ${n} CONNECTION '${peer}' PUBLICATION ${n}`);
  }
  await sleep(1500);
});
after(async () => { if (up && !skip) { await m.teardown().catch(() => undefined); await dropFillers(); } });

test("PF-E12 거부: 일꾼 자리가 1개뿐이면 점검 DB-07(target) 실패, 이유에 남은 자리·다른 구독 수", { skip }, async (t) => {
  if (skip) return t.skip(skip);
  const r = await m.precheck();
  const c = r.checks.find((x) => x.id === "DB-07" && x.side === "target")!;
  assert.equal(c.ok, false, c.detail);
  assert.match(c.detail, /남은 자리 1 .*필요 2/);
  assert.equal(r.ok, false);
});

test("PF-E12: 자리 부족으로 복사가 안 시작되면 copying 아님 + 이유에 tablesync=0 · 일꾼 자리 부족 안내", { skip }, async (t) => {
  if (skip) return t.skip(skip);
  const r = await m.sync({ waitCopyMs: 3000, samples: 0 });
  if (r.copy.done) return t.skip("복사가 끝남 (자리가 생김)");
  assert.equal(r.copying, undefined);
  assert.ok(r.gate.reasons.some((x) => /COPY_WORKERS .*tablesync=0.*일꾼 자리 부족/.test(x)), r.gate.reasons.join(" | "));
});

test("PF-E12 정상: 남은 구독을 지우면 DB-07 통과, 같은 sync 가 복사를 끝내 ready", { skip }, async (t) => {
  if (skip) return t.skip(skip);
  await dropFillers(); fillers = [];
  const c = (await m.precheck()).checks.find((x) => x.id === "DB-07" && x.side === "target")!;
  assert.equal(c.ok, true, c.detail);
  const r = await m.sync();
  assert.equal(r.gate.ready, true, r.gate.reasons.join(" | "));
});
