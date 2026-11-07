// 보안 12번(콘솔 호스트 키)의 동작 ec2:GetConsoleOutput 은 스위치(RELAY_HOSTKEY_FROM_CONSOLE=1)를 켜기 전엔 필수가 아니다.
//   템플릿을 아직 안 고친 고객 계정의 AWS → 온프레 사전 점검을 그 동작 하나로 막지 않는다. 온프레 → AWS 는 도착 계정 중계기 묶음을 쓴다
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { loadPermissionBundles, requiredBundles, RELAY_ACTIONS, relayPermVerdict } from "../src/index.js";

const sim = (deny: string[]) => ({ code: 0, stderr: "", json: { EvaluationResults: RELAY_ACTIONS.map((a) => ({ EvalActionName: a, EvalDecision: deny.includes(a) ? "implicitDeny" : "allowed" })) } });
const ARN = "arn:aws:iam::000000000000:role/svc-operate";

test("사전 점검: 콘솔 동작만 빠지면 스위치가 꺼진 동안 PASS(안내), 켜면 WARN. 다른 동작이 빠지면 늘 WARN", () => {
  const off = relayPermVerdict(sim(["ec2:GetConsoleOutput"]), ARN);
  assert.equal(off.verdict, "PASS");
  assert.match(off.reason, /RELAY_HOSTKEY_FROM_CONSOLE=1/);
  assert.equal(relayPermVerdict(sim(["ec2:GetConsoleOutput"]), ARN, { consoleRequired: true }).verdict, "WARN");
  const other = relayPermVerdict(sim(["ec2:RunInstances", "ec2:GetConsoleOutput"]), ARN);
  assert.equal(other.verdict, "WARN");
  assert.match(other.reason, /빠진 동작 1개: ec2:RunInstances/);
  assert.equal(relayPermVerdict(sim([]), ARN).verdict, "PASS");
});

test("권한 묶음: 중계기 묶음에 GetConsoleOutput 없음 (템플릿에는 있음), 온프레 → AWS 는 도착 쪽 aws.relay.target 을 요구", () => {
  const dir = fileURLToPath(new URL("../../../infra/permissions/", import.meta.url));
  const set = loadPermissionBundles(dir)!;
  for (const b of set.bundles.filter((x) => x.stage === "relay")) assert.ok(!b.permissions.includes("ec2:GetConsoleOutput"), b.id);
  const need = { sourceProvider: "onprem", targetProvider: "aws", secrets: false, postgres: true, data: false, envLayerCreate: false, relay: "onprem-aws" as const, argoHub: false };
  const ids = requiredBundles(set.bundles, need).map((b) => `${b.id}@${b.onSide}`);
  assert.ok(ids.includes("aws.relay.target@target"), ids.join(","));
  assert.ok(!ids.some((x) => x.startsWith("aws.relay.source")), "출발이 온프레라 출발 AWS 묶음은 없다");
});
