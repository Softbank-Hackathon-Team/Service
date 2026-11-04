// PF-E23 (FM-APP-30): 컷오버 직후 롤백해도 쓰기 멈춤이 수 초가 되지 않는다 (멈춤 전에 역방향 적용 일꾼을 기다림)
// PF-E24 (FM-APP-29): 추정 행 수가 한도를 넘으면 멈춤 안 행 수 비교를 뺀다 (멈춤이 표 크기에 비례하지 않게). 진짜 Postgres 두 개
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { Migration, switchover } from "../src/index.js";
import { SOURCE, TARGET, TABLES, q, reachable, resetAndSeed } from "./harness.js";

const up = (await reachable(SOURCE)) && (await reachable(TARGET));
const skip = up ? false : "Postgres 두 개(55432/55433) 없음";
const m = new Migration({ key: "pfe23", source: SOURCE, target: TARGET, tables: TABLES });

before(async () => { if (up) await resetAndSeed(2000); });
after(async () => { if (up) await m.teardown().catch(() => undefined); });

test("PF-E23: 컷오버 바로 뒤 롤백 — 일꾼을 멈춤 전에 기다려 쓰기 멈춤 1초 미만", { skip }, async () => {
  assert.equal((await m.sync()).gate.ready, true);
  const c = await m.cutover();
  assert.equal(c.ok, true, JSON.stringify(c));
  const r = await m.rollback({ teardown: false });
  assert.equal(r.kind, "after_cutover");
  assert.equal(r.result?.ok, true, JSON.stringify(r.result));
  assert.ok(r.result!.pauseMs < 1000, `pause ${r.result!.pauseMs}ms (예전 ~5초)`);
});

test("PF-E24: 행 수 한도 0 이면 멈춤 안 비교를 빼고(측정값에 남김) 그래도 전환은 된다", { skip }, async () => {
  await m.teardown();
  await resetAndSeed(2000);
  assert.equal((await m.sync()).gate.ready, true);
  await q(SOURCE, "ANALYZE orders; ANALYZE customers");
  const tables = TABLES.map((name) => ({ schema: "public", name }));
  const r = await switchover({ from: SOURCE, to: TARGET, current: m.names.fwd, reverse: m.names.rev, tables, verifyCountsMaxRows: 0 });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(r.measures.some((x) => x.name === "row_count_verify_skipped_est_rows" && x.value > 0), JSON.stringify(r.measures));
});

test("PF-E26 (RV-10): C6 바로 뒤 출발 관리자 연결이 끊겨도 역방향 구독을 다시 붙여 컷오버가 성공한다", { skip }, async () => {
  await m.teardown();
  await resetAndSeed(500);
  assert.equal((await m.sync()).gate.ready, true);
  const tables = TABLES.map((name) => ({ schema: "public", name }));
  const hooks = {
    pause: async () => {},
    resume: async (e: { label: string }) => {
      // 도착으로 풀어 준 순간 출발 쪽 관리자 세션을 끊는다 (일시 끊김 흉내)
      if (e.label === TARGET.label) await q(SOURCE, `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE datname = current_database() AND backend_type = 'client backend' AND pid <> pg_backend_pid() AND usename = current_user`);
    },
  };
  const r = await switchover({ from: SOURCE, to: TARGET, current: m.names.fwd, reverse: m.names.rev, tables, hooks });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(r.measures.some((x) => x.name === "reverse_subscribe_retry"), JSON.stringify(r.measures));
  assert.equal(await m.phase(), "reverse");
});
