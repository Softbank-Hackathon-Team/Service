// PF FM-ORC-14: 잠금을 잃어 terraform 을 멈출 때 SIGINT 뒤 바로(10초) SIGKILL 하지 않는다 → 진행 중 생성을 끝내고 state 를 쓸 시간
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnExec, stopGraceMs } from "../src/terraform/real-runner.js";

test("PF FM-ORC-14 정상: 기본 유예 20분, TF_STOP_GRACE_SEC 로 바꿈", () => {
  assert.equal(stopGraceMs({}), 1_200_000);
  assert.equal(stopGraceMs({ TF_STOP_GRACE_SEC: "5" }), 5_000);
});

test("PF FM-ORC-14: SIGINT 를 받은 프로세스가 정리(2초)를 끝내고 스스로 끝날 때까지 기다린다 (예전 10초 안에서도 같지만 유예가 env 를 따름)", async () => {
  const prev = process.env.TF_STOP_GRACE_SEC;
  process.env.TF_STOP_GRACE_SEC = "30";
  try {
    const ac = new AbortController();
    // terraform 흉내: INT 를 받으면 2초 정리 뒤 state 를 쓴 표시를 찍고 0 으로 끝남
    const run = spawnExec("sh", ["-c", "trap 'sleep 2; echo state-written; exit 0' INT; while :; do sleep 0.2; done"],
      { cwd: process.cwd(), env: { PATH: process.env.PATH }, timeoutMs: 60_000, signal: ac.signal });
    setTimeout(() => ac.abort(), 300);
    const r = await run;
    assert.match(r.stdout, /state-written/, "SIGKILL 로 끊기지 않고 정리 끝까지 감");
    assert.equal(r.code, 0);
  } finally { if (prev === undefined) delete process.env.TF_STOP_GRACE_SEC; else process.env.TF_STOP_GRACE_SEC = prev; }
});

test("PF FM-ORC-14 거부: 유예를 넘기면 그래도 SIGKILL (영원히 매달리지 않음)", async () => {
  const prev = process.env.TF_STOP_GRACE_SEC;
  process.env.TF_STOP_GRACE_SEC = "1";
  try {
    const ac = new AbortController();
    const run = spawnExec("sh", ["-c", "trap '' INT; while :; do sleep 0.2; done"],
      { cwd: process.cwd(), env: { PATH: process.env.PATH }, timeoutMs: 60_000, signal: ac.signal });
    setTimeout(() => ac.abort(), 200);
    const t0 = Date.now();
    const r = await run;
    assert.ok(Date.now() - t0 < 5000);
    assert.notEqual(r.code, 0);
  } finally { if (prev === undefined) delete process.env.TF_STOP_GRACE_SEC; else process.env.TF_STOP_GRACE_SEC = prev; }
});
