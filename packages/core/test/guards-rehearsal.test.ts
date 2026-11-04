// T20 리허설 근거: SANDBOX_REHEARSAL=on 이면 deploying → syncing 에 rehearsal 근거가 있어야 한다 (통과·재사용·건너뜀 이유).
//   꺼져 있으면(기본) 예전 조건 그대로 (argoHealthy + securityParity)
import { test } from "node:test";
import assert from "node:assert/strict";
import { RehearsalEvidence } from "@svc/contracts";
import { checkGuard, type GuardFacts } from "../src/guards.js";

const facts: GuardFacts = {
  status: "deploying", pausedFrom: null, failedAtStatus: null, rollbackWindowOver: false,
  sourceEnvId: "s", targetEnvId: "t", sourceConn: "connected", targetConn: "connected",
  specVersion: 1, specNeedsReview: 0, plan: null, locks: { total: 2, live: 2, reservedLive: 0 },
};
const healthy = { argoHealthy: true, securityParity: true } as const;

function withSwitch<T>(value: string | undefined, f: () => T): T {
  const prev = process.env.SANDBOX_REHEARSAL;
  if (value === undefined) delete process.env.SANDBOX_REHEARSAL; else process.env.SANDBOX_REHEARSAL = value;
  try { return f(); } finally { if (prev === undefined) delete process.env.SANDBOX_REHEARSAL; else process.env.SANDBOX_REHEARSAL = prev; }
}

test("리허설 켬: rehearsal 근거 없이 deploying → syncing 은 막힌다", () => {
  const why = withSwitch("on", () => checkGuard("deploying", "syncing", { facts, ev: healthy }));
  assert.match(why ?? "", /rehearsal evidence required/);
});

test("리허설 켬: 근거 값 하나하나(통과·재사용·건너뜀 이유)는 통과, Argo·보안 조건은 그대로 본다", () => {
  for (const r of RehearsalEvidence.options)
    assert.equal(withSwitch("on", () => checkGuard("deploying", "syncing", { facts, ev: { ...healthy, rehearsal: r } })), null, r);
  assert.match(withSwitch("on", () => checkGuard("deploying", "syncing", { facts, ev: { securityParity: true, rehearsal: "passed" } })) ?? "", /argoHealthy/);
});

test("리허설 끔(기본·off): 예전 근거만으로 통과", () => {
  assert.equal(withSwitch(undefined, () => checkGuard("deploying", "syncing", { facts, ev: healthy })), null);
  assert.equal(withSwitch("off", () => checkGuard("deploying", "syncing", { facts, ev: healthy })), null);
});
