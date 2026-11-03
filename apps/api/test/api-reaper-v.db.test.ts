// V(PA7): API 리퍼 검증 — 경계(깃발 값), 실제 pg-boss 에 등록, 두 번 켜도 스케줄 하나
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { QUEUES } from "@svc/contracts";
import { startApiReaper } from "../src/reaper.js";

const DB = process.env.DATABASE_URL;
const skip = !DB ? "DATABASE_URL 없음 (DB 시험 건너뜀)" : false;
const quiet = { info: () => {}, error: () => {} };
let core: typeof import("@svc/core");

before(async () => {
  if (skip) return;
  core = await import("@svc/core");
  await core.startBoss();
});
after(async () => {
  if (skip) return;
  await core.boss.stop({ graceful: false }); await core.pool.end();
});

test("경계: 정확히 \"1\" 만 켠다 (true·공백·2 는 꺼짐, 불러오지도 않음)", async () => {
  let loaded = 0;
  const load = async () => { loaded++; return { registerLeaseJobs: async () => {} }; };
  for (const v of ["true", " 1", "1 ", "2", "", "on"])
    assert.equal(await startApiReaper({ env: { API_REAPER: v }, log: quiet, load }), false, `API_REAPER=${JSON.stringify(v)}`);
  assert.equal(loaded, 0);
});

test("실제 pg-boss 에 청소 스케줄이 등록되고, 두 번 켜도(api+worker 둘 다) 스케줄은 하나", { skip }, async () => {
  const names = async () => (await core.boss.getSchedules()).filter((s) => s.name === QUEUES.leaseReaper);
  assert.equal(await startApiReaper({ env: { API_REAPER: "1" }, log: quiet }), true);   // 기본 불러오기 = 실제 worker 코드
  assert.equal((await names()).length, 1);
  assert.equal(await startApiReaper({ env: { API_REAPER: "1" }, log: quiet }), true);
  assert.equal((await names()).length, 1);
});
