// PF-E3 (FM-APP-07): 초기 복사가 기다림 시간보다 오래 걸려도 sync 가 던지지 않고 "복사 중(copying)"으로 알려 준다.
//   구독 작업자가 멈춘(비활성) 경우는 copying 이 아니다 → 워커가 예전처럼 실패로 센다. 진짜 Postgres 두 개(harness)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Migration } from "../src/index.js";
import { SOURCE, TARGET, TABLES, q, reachable, resetAndSeed } from "./harness.js";

let skip: string | false = false;
const m = new Migration({ key: "pfe3", source: SOURCE, target: TARGET, tables: TABLES });
before(async () => {
  if (!(await reachable(SOURCE)) || !(await reachable(TARGET))) { skip = "DB 두 개 없음 (IT_SOURCE_URL·IT_TARGET_URL)"; return; }
  await resetAndSeed(400_000);
});
after(async () => { if (!skip) await m.teardown().catch(() => undefined); });

test("PF-E3: 기다림 1ms 안에 복사가 안 끝나면 던지지 않고 copying=true, 판정은 INITIAL_COPY_NOT_DONE", async (t) => {
  if (skip) return t.skip(skip);
  const r0 = await m.sync({ waitCopyMs: 0, samples: 0 });
  assert.equal(r0.created, true);
  // PF-E12: 표 복사 일꾼이 아직 안 떴으면 "자리 부족 멈춤"과 구별이 안 된다 → 일꾼이 뜰 때까지 기다린 뒤 본다
  for (let i = 0; i < 100; i++) {
    if ((await q(TARGET, `SELECT 1 FROM pg_stat_subscription WHERE subname=$1 AND relid IS NOT NULL AND pid IS NOT NULL`, [m.names.fwd])).length) break;
    await new Promise((x) => setTimeout(x, 20));
  }
  const r = await m.sync({ waitCopyMs: 1, samples: 1 });
  if (r.copy.done) return t.skip("복사가 1ms 안에 끝남 (너무 빠른 기계)");
  assert.equal(r.copying, true, JSON.stringify(r.copy));
  assert.equal(r.gate.ready, false);
  assert.ok(r.gate.reasons.some((x) => x.startsWith("INITIAL_COPY_NOT_DONE")), r.gate.reasons.join());
});

test("PF-E3 정상: 다시 부르면(기본 기다림) 복사가 끝나 copying 없음·판정 통과", async (t) => {
  if (skip) return t.skip(skip);
  const r = await m.sync();
  assert.equal(r.copying, undefined);
  assert.equal(r.copy.done, true);
  assert.equal(r.gate.ready, true, r.gate.reasons.join());
});

test("PF-E3 거부: 구독이 멈춰 있으면(작업자 없음) 복사가 안 끝나도 copying 아님 = 워커는 보통 실패로 센다", async (t) => {
  if (skip) return t.skip(skip);
  await m.teardown();
  await q(TARGET, `TRUNCATE orders, customers`);
  const r0 = await m.sync({ waitCopyMs: 0, samples: 0 });
  assert.equal(r0.created, true);
  await q(TARGET, `ALTER SUBSCRIPTION ${m.names.fwd} DISABLE`);
  await new Promise((r) => setTimeout(r, 300));
  const r = await m.sync({ waitCopyMs: 200, samples: 1 });
  if (r.copy.done) return t.skip("비활성 전에 복사가 끝남");
  assert.equal(r.copying, undefined, JSON.stringify(r.copy));
  assert.equal(r.gate.ready, false);
});
