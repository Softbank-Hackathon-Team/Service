// LLM-1: 바깥 LLM 으로 가는 입력은 감사 기록보다 덜 가리면 안 된다. 규칙은 contracts/src/redact.ts 한 곳
import { test } from "node:test";
import assert from "node:assert/strict";
import { redactAuditValue } from "@svc/contracts";
import { redact, redactOutboundMessages } from "../src/draft/redact.js";
import { redactText as guardText } from "../src/ai/guard.js";
import { gateChanges } from "../src/ai/gate.js";
import { anthropicProvider } from "../src/llm/anthropic.js";

const ACCOUNT = "123456789012";
const RDS = "shop-db.abcdefgh1234.ap-northeast-2.rds.amazonaws.com";
const raw = {
  kind: "k8s.deployment", name: "shop-api",
  role: `arn:aws:iam::${ACCOUNT}:role/shop-api`,
  containers: [{ name: "api", image: "ghcr.io/demo/api:1",
    args: ["--db-password=hunter22", `--db-host=${RDS}`, "--replicas=3"],
    env: [{ name: "DB_HOST", value: "10.0.12.34" }, { name: "MODE", value: "demo" }] }],
  network: { vpcCidr: "10.0.0.0/16" },
};
const leaks = (s: string) => [ACCOUNT, RDS, "hunter22", "10.0.12.34"].filter((x) => s.includes(x));

test("LLM-1 정상: 도구 결과 가리기(redact)가 감사 규칙만큼 가린다 (계정·ARN·RDS 주소·인자 속 비밀번호·IP), 평범한 값·CIDR 은 남김", () => {
  const out = JSON.stringify(redact(raw));
  assert.deepEqual(leaks(out), [], out);
  assert.deepEqual(leaks(JSON.stringify(redactAuditValue(raw))), [], "감사 쪽도 같은 값을 가림 (대조)");
  for (const keep of ["--replicas=3", "demo", "10.0.0.0/16", "shop-api", "ghcr.io/demo/api:1"]) assert.ok(out.includes(keep), keep);
});

test("LLM-1 정상: 점검·수정 경로 글 가리기도 감사 규칙을 같이 건다 (자리 표시는 [REDACTED]·<ip>·<account>·<hidden>)", () => {
  const t = guardText(`connect ${RDS} as arn:aws:iam::${ACCOUNT}:role/x from 10.0.12.34 password=hunter22 REPLICAS=3`);
  assert.deepEqual(leaks(t), [], t);
  assert.match(t, /REPLICAS=3/);
  assert.match(t, /password=\[REDACTED\]/);
});

test("LLM-1 정상: 나가기 직전 관문은 user 차례 글·도구 결과만 가리고 assistant 차례·원본은 안 건드림", async () => {
  const msgs = [
    { role: "user" as const, content: `시작 arn:aws:iam::${ACCOUNT}:role/r` },   // 계정은 ARN·SQS 주소 안에서만 가림 (감사와 같은 기준)
    { role: "assistant" as const, content: [{ type: "thinking", thinking: "", signature: "sig" }, { type: "text", text: "10.0.12.34" }] },
    { role: "user" as const, content: [{ type: "tool_result", tool_use_id: "t1", content: `host ${RDS}` },
      { type: "tool_result", tool_use_id: "t2", content: [{ type: "text", text: "ip 10.0.12.34" }] }] },
  ];
  const before = JSON.stringify(msgs);
  const out = redactOutboundMessages(msgs);
  assert.equal(JSON.stringify(msgs), before, "원본 그대로");
  assert.deepEqual(out[1], msgs[1], "assistant 차례는 그대로 (서명된 thinking 을 바꾸면 400)");
  assert.deepEqual(leaks(JSON.stringify([out[0], out[2]])), []);

  // 진짜 제공자도 이 관문을 거친다 (도구가 redact 를 빠뜨려도 막힘)
  let sent: any;
  const client = { beta: { messages: { create: async (p: unknown) => { sent = p; return {
    model: "m", stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: "text", text: "ok" }] }; } } } } as any;
  await anthropicProvider({ client, onCall: () => {} }).create({ system: "s", tools: [], messages: msgs });
  assert.deepEqual(leaks(JSON.stringify(sent.messages.filter((m: any) => m.role === "user"))), []);
});

test("LLM-1 거부: 가린 자리 표시를 베껴 쓴 매니페스트 변경은 PR 후보에서 뺌 (GATE-06), 예전부터 있던 표시는 통과", () => {
  const before = new Map([["deploy/app.yaml", "image: ghcr.io/demo/api:1\nhost: db.internal\n"]]);
  const bad = gateChanges(before, new Map([["deploy/app.yaml", "image: ghcr.io/demo/api:1\nhost: <ip>\n"]]));
  assert.equal(bad.ok, false);
  assert.ok(bad.violations.some((v) => v.startsWith("GATE-06")), bad.violations.join("; "));
  const same = new Map([["deploy/app.yaml", "note: <hidden>\n"]]);
  assert.equal(gateChanges(same, new Map([["deploy/app.yaml", "note: <hidden>\nreplicas: 3\n"]])).ok, true);
});
