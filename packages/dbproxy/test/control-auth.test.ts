// Z38 REVIEW-4 P-1·P-3: 제어 포트 토큰 강제 + 붙잡기 최대 기본값
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as proxy from "../src/proxy.js";
import * as pgb from "../src/pgbouncer-control.js";

const SRC = (f: string) => fileURLToPath(new URL(`../src/${f}`, import.meta.url));

for (const [name, m] of [["proxy", proxy], ["pgbouncer-control", pgb]] as const) {
  test(`${name}: 밖에 연 제어 포트 + 토큰 없음은 거부, 루프백·토큰·명시 허용은 통과`, () => {
    assert.equal(m.checkControlAuth("0.0.0.0", undefined, {}).ok, false);
    assert.equal(m.checkControlAuth("10.0.0.5", undefined, {}).ok, false);
    assert.equal(m.checkControlAuth("::", undefined, {}).ok, false);
    assert.deepEqual(m.checkControlAuth("127.0.0.1", undefined, {}), { ok: true });
    assert.deepEqual(m.checkControlAuth("::1", undefined, {}), { ok: true });
    assert.deepEqual(m.checkControlAuth("localhost", undefined, {}), { ok: true });
    assert.deepEqual(m.checkControlAuth("0.0.0.0", "t0k", {}), { ok: true });
    const v = m.checkControlAuth("0.0.0.0", undefined, { DBPROXY_INSECURE_NO_TOKEN: "1" });
    assert.equal(v.ok, true);
    assert.match((v as { warn?: string }).warn ?? "", /without DBPROXY_TOKEN/);
  });

  test(`${name}: 붙잡기 최대 기본 25초 (최악 컷오버 드레인 2 + 따라잡기 10 보다 넉넉히)`, () => {
    assert.equal(m.configFromEnv({}).opts.holdMaxMs, 25_000);
    assert.equal(m.configFromEnv({ DBPROXY_HOLD_MAX_MS: "40000" }).opts.holdMaxMs, 40_000);
  });

  test(`${name}: 실제 실행 — 0.0.0.0 + 토큰 없음이면 종료 코드 2 로 안 뜬다`, () => {
    const file = name === "proxy" ? "proxy.ts" : "pgbouncer-control.ts";
    const env = { PATH: process.env.PATH, NODE_NO_WARNINGS: "1", DBPROXY_CONTROL_HOST: "0.0.0.0", DBPROXY_PORT: "0", DBPROXY_CONTROL_PORT: "0" };
    const r = spawnSync(process.execPath, [SRC(file)], { env, encoding: "utf8", timeout: 15_000 });
    assert.equal(r.status, 2, `stdout=${r.stdout} stderr=${r.stderr}`);
    assert.match(r.stderr, /refusing to open control port on 0\.0\.0\.0/);
  });
}
