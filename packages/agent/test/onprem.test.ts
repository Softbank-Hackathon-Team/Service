import { test } from "node:test";
import assert from "node:assert/strict";
import { acceptAgentReport, AgentReportRejected, memoryKeyRegistry, stubOnpremAgent, toDeployResult } from "../src/index.js";

const T = "11111111-1111-4111-8111-111111111111";
const E = "33333333-3333-4333-8333-333333333333";
const M = "44444444-4444-4444-8444-444444444444";
const keys = memoryKeyRegistry({ k1: { tenantId: T, envId: E, secret: "s3cret" } });
const agent = stubOnpremAgent({ keyId: "k1", secret: "s3cret" });
const now = new Date("2026-11-07T01:00:00Z");
const rejected = (code: string) => (e: unknown) => e instanceof AgentReportRejected && e.code === code;

test("서명된 보고 셋(살아 있음, 보안, 배포)을 받고 회사·환경은 키에서 붙인다", async () => {
  for (const r of [agent.heartbeat(now), agent.security(now, true), agent.deployed(now, M, "sha256:abc")]) {
    const got = await acceptAgentReport(r.headers, r.body, keys, now);
    assert.equal(got.tenantId, T); assert.equal(got.envId, E);
  }
  const d = agent.deployed(now, M, "sha256:abc");
  const { report } = await acceptAgentReport(d.headers, d.body, keys, now);
  assert.equal(report.kind, "deploy");
  if (report.kind === "deploy") assert.equal(toDeployResult(report).status, "applied");
});

test("변조·모르는 키·오래된 시각·본문에 회사 번호 끼워 넣기는 거부", async () => {
  const r = agent.heartbeat(now);
  await assert.rejects(acceptAgentReport(r.headers, r.body.replace("true", "false"), keys, now), rejected("AGENT_BAD_SIGNATURE"));
  await assert.rejects(acceptAgentReport({ ...r.headers, keyId: "nope" }, r.body, keys, now), rejected("AGENT_KEY_UNKNOWN"));
  await assert.rejects(acceptAgentReport(r.headers, r.body, keys, new Date(now.getTime() + 301_000)), rejected("AGENT_TS_SKEW"));
  // 본문에 tenantId 를 넣으면 strict 모양 검사에서 막힌다 (회사는 키로만 정한다)
  const forged = stubOnpremAgent({ keyId: "k1", secret: "s3cret" });
  const body = JSON.stringify({ ...JSON.parse(forged.heartbeat(now).body), tenantId: "99999999-9999-4999-8999-999999999999" });
  const { signReport } = await import("../src/index.js");
  const ts = String(Math.floor(now.getTime() / 1000));
  await assert.rejects(acceptAgentReport({ keyId: "k1", timestamp: ts, signature: signReport("s3cret", Number(ts), body) }, body, keys, now),
    rejected("AGENT_BAD_SHAPE"));
});
