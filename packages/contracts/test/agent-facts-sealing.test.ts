// facts 보고의 sealing 칸 (sealed-secrets 공개 봉인 인증서). 선택 칸이라 예전 Agent 보고도 받는다
import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentReport } from "../src/index.js";

const base = { kind: "facts", agentVersion: "t", sentAt: "2026-11-05T00:00:00Z", grants: { level: "L0" }, dbs: [] };
const cert = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n";

test("facts.sealing: 있으면 인증서 PEM + 받은 시각, 없어도 된다 (예전 Agent)", () => {
  assert.ok(AgentReport.safeParse(base).success);
  assert.ok(AgentReport.safeParse({ ...base, sealing: { certPem: cert, fetchedAt: "2026-11-05T00:00:00Z" } }).success);
});

test("facts.sealing 거부: 인증서가 아닌 PEM · 너무 긴 값 · 모르는 칸 · 시각 없음", () => {
  const bad = (sealing: unknown) => !AgentReport.safeParse({ ...base, sealing }).success;
  assert.ok(bad({ certPem: "-----BEGIN PRIVATE KEY-----\n", fetchedAt: "2026-11-05T00:00:00Z" }));
  assert.ok(bad({ certPem: cert + "A".repeat(16384), fetchedAt: "2026-11-05T00:00:00Z" }));
  assert.ok(bad({ certPem: cert, fetchedAt: "2026-11-05T00:00:00Z", key: "x" }));
  assert.ok(bad({ certPem: cert }));
});
