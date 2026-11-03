import { test } from "node:test";
import assert from "node:assert/strict";
import { startApiReaper } from "../src/reaper.js";

const quiet = { info: () => {}, error: () => {} };

test("API_REAPER=1 이면 청소 작업을 한 번 등록하고 true", async () => {
  let n = 0;
  const on = await startApiReaper({ env: { API_REAPER: "1" }, log: quiet, load: async () => ({ registerLeaseJobs: async () => { n++; } }) });
  assert.equal(on, true);
  assert.equal(n, 1);
});

test("깃발이 없거나 1 이 아니면 불러오지도 않는다 (기본 off)", async () => {
  let loaded = 0;
  const load = async () => { loaded++; return { registerLeaseJobs: async () => {} }; };
  assert.equal(await startApiReaper({ env: {}, log: quiet, load }), false);
  assert.equal(await startApiReaper({ env: { API_REAPER: "0" }, log: quiet, load }), false);
  assert.equal(loaded, 0);
});

test("불러오기가 실패해도 던지지 않고 false (api 는 계속 뜬다)", async () => {
  const errs: string[] = [];
  const on = await startApiReaper({ env: { API_REAPER: "1" }, log: { info: () => {}, error: (m) => errs.push(m) },
    load: async () => { throw new Error("module not found"); } });
  assert.equal(on, false);
  assert.match(errs[0]!, /module not found/);
});

test("실제 청소 모듈이 registerLeaseJobs 를 내보낸다 (개발 실행 경로)", async () => {
  const m = await import("../../worker/src/lease/index.js");
  assert.equal(typeof m.registerLeaseJobs, "function");
});
