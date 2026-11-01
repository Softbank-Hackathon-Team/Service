// PR 전 게이트·Agent 보고 우회 시도 시험 (THREAT-MODEL.md T-AI-*, T-AG-*).
// 각 경우는 base(이미지 줄 그대로)에 덧붙여, 다른 규칙(GATE-04)에 우연히 걸리지 않게 한다.
// 막혀야 하는데 지금 STUB 게이트가 못 막는 것은 { todo } 로 표시한다.
// todo 시험은 실패해도 전체 결과를 깨지 않고 "# todo N" 으로 남는다. 고치면 todo 를 지운다
import { test } from "node:test";
import assert from "node:assert/strict";
import { gateChanges, acceptAgentReport, signReport, memoryKeyRegistry } from "../src/index.js";

const P = "deploy/web.yaml";
const base = "kind: Deployment\nspec:\n  template:\n    spec:\n      containers:\n        - image: reg.example/web@sha256:aa\n";
const gate = (after: string, path = P) => gateChanges(new Map([[P, base]]), new Map([[path, after]]));

test("막힘: deploy/ 밖 파일, Secret 종류, privileged, 이미지 저장소 변경", () => {
  assert.equal(gate(base + "# x\n", ".github/workflows/ci.yaml").ok, false);
  assert.equal(gate(base + "---\nkind: Secret\ndata: {}\n").ok, false);
  assert.equal(gate(base + "          securityContext: { privileged: true }\n").ok, false);
  assert.equal(gate(base.replace("reg.example", "evil.example")).ok, false);
});

test("우회: kind 값에 따옴표 (kind: \"Secret\")", { todo: "GATE-02 줄 검사 → YAML 파싱 필요" }, () => {
  assert.equal(gate(base + '---\nkind: "Secret"\ndata: {}\n').ok, false);
});
test("막힘: 한 파일에 문서 여러 개 (--- 뒤 ClusterRoleBinding)", () => {
  assert.equal(gate(base + "---\nkind: ClusterRoleBinding\n").ok, false);
});
test("우회: hostNetwork·hostPath·hostPID", { todo: "GATE-03 확장 (Kyverno restricted 와 같은 목록)" }, () => {
  assert.equal(gate(base + "      hostNetwork: true\n").ok, false);
  assert.equal(gate(base + "      volumes: [{ name: h, hostPath: { path: / } }]\n").ok, false);
});
test("우회: capabilities add SYS_ADMIN, allowPrivilegeEscalation true", { todo: "GATE-03 확장" }, () => {
  assert.equal(gate(base + "          securityContext: { capabilities: { add: [SYS_ADMIN] } }\n").ok, false);
  assert.equal(gate(base + "          securityContext: { allowPrivilegeEscalation: true }\n").ok, false);
});
test("우회: 새 파일에서 다른 이미지 저장소", { todo: "GATE-04 는 기존 파일만 비교. 새 파일은 허용 저장소 목록으로 봐야 한다" }, () => {
  const r = gateChanges(new Map(), new Map([["deploy/new.yaml", "kind: Deployment\n  image: evil.example/x:1\n"]]));
  assert.equal(r.ok, false);
});

// 온프레 Agent 보고
const SECRET = "test-only-not-a-real-secret";
const keys = memoryKeyRegistry({ k1: { tenantId: "11111111-1111-4111-8111-111111111111", envId: "22222222-2222-4222-8222-222222222222", secret: SECRET } });
const body = JSON.stringify({ kind: "heartbeat", agentVersion: "0.1", sentAt: "2026-10-31T00:00:00Z", k3sVersion: "v1.31", cnpg: null });
const now = new Date("2026-10-31T00:00:00Z");
const ts = Math.floor(now.getTime() / 1000);

test("막힘: 본문을 바꾸면 서명 불일치, 본문에 tenantId 넣으면 모양 오류", async () => {
  const sig = signReport(SECRET, ts, body);
  await assert.rejects(acceptAgentReport({ keyId: "k1", signature: sig, timestamp: String(ts) }, body.replace("0.1", "0.2"), keys, now),
    { code: "AGENT_BAD_SIGNATURE" });
  const evil = JSON.stringify({ ...JSON.parse(body), tenantId: "33333333-3333-4333-8333-333333333333" });
  await assert.rejects(acceptAgentReport({ keyId: "k1", signature: signReport(SECRET, ts, evil), timestamp: String(ts) }, evil, keys, now),
    { code: "AGENT_BAD_SHAPE" });
});
test("막힘: 6분 지난 보고", async () => {
  const old = ts - 360;
  await assert.rejects(acceptAgentReport({ keyId: "k1", signature: signReport(SECRET, old, body), timestamp: String(old) }, body, keys, now),
    { code: "AGENT_TS_SKEW" });
});
test("우회: 같은 보고를 5분 안에 다시 보내기(재전송)", { todo: "서명값 기억(nonce 표) 필요. 지금은 시각만 본다" }, async () => {
  const h = { keyId: "k1", signature: signReport(SECRET, ts, body), timestamp: String(ts) };
  await acceptAgentReport(h, body, keys, now);
  await assert.rejects(acceptAgentReport(h, body, keys, now));
});
