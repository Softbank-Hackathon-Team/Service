import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CONNECTABLE, checkAccount, checkEnvForm, connectPollMs, connectSteps, envPath, phaseOf,
} from "../src/features/environments/connect";
import { parseRoute } from "../src/app/routes";
import type { ConnectionStatus } from "../src/lib/types";

const STATUSES: ConnectionStatus[] = ["draft", "awaiting_customer", "verifying", "connected", "unstable", "failed", "expired", "disconnected"];

test("등록할 수 있는 곳은 AWS·GCP·온프레. Azure 는 모의라 뺀다", () => {
  assert.deepEqual(CONNECTABLE.map((item) => item.provider), ["aws", "gcp", "onprem"]);
});

test("환경 만들기 칸: AWS 는 리전과 EKS 클러스터 이름까지", () => {
  assert.equal(checkEnvForm("gcp", { name: "shop-gcp", region: "", clusterName: "" }).ok, true);
  assert.deepEqual(Object.keys(checkEnvForm("aws", { name: " ", region: "seoul", clusterName: "--x" }).errors).sort(), ["clusterName", "name", "region"]);
  assert.equal(checkEnvForm("aws", { name: "shop-aws", region: "ap-northeast-2", clusterName: "shop-eks" }).ok, true);
  assert.ok(checkEnvForm("onprem", { name: "x".repeat(65), region: "", clusterName: "" }).errors.name);
});

test("연결 확인 칸: AWS 는 대시를 지운 12자리, GCP 전용 프로젝트는 비워도 되지만 달라야 한다", () => {
  const aws = checkAccount("aws", { accountId: "1111-2222-3333", targetProjectId: "" });
  assert.equal(aws.ok, true);
  assert.equal(aws.accountId, "111122223333");
  assert.equal(checkAccount("aws", { accountId: "1234", targetProjectId: "" }).ok, false);
  const gcp = checkAccount("gcp", { accountId: "shop-prod", targetProjectId: "shop-mig" });
  assert.deepEqual([gcp.ok, gcp.accountId, gcp.targetProjectId], [true, "shop-prod", "shop-mig"]);
  assert.equal(checkAccount("gcp", { accountId: "shop-prod", targetProjectId: "" }).targetProjectId, undefined);
  assert.ok(checkAccount("gcp", { accountId: "shop-prod", targetProjectId: "shop-prod" }).errors.targetProjectId);
  assert.ok(checkAccount("gcp", { accountId: "Shop", targetProjectId: "" }).errors.accountId);
});

test("연결 상태 8개가 모두 화면 단계 하나로 간다", () => {
  const phases = Object.fromEntries(STATUSES.map((status) => [status, phaseOf(status)]));
  assert.deepEqual(phases, {
    draft: "link", awaiting_customer: "link", verifying: "verifying", connected: "connected",
    unstable: "connected", failed: "retry", expired: "retry", disconnected: "gone",
  });
});

test("다시 읽는 간격: 워커 확인과 온프레 Agent 를 기다릴 때만 빠르게", () => {
  assert.equal(connectPollMs("verifying"), 2_000);
  assert.equal(connectPollMs("link", "onprem"), 2_000);
  assert.equal(connectPollMs("link", "aws"), 10_000);
  assert.equal(connectPollMs(null), 10_000);
});

test("등록 단계 카드: 고객 차례는 입력 기다림, 확인 중은 돌고, 실패는 확인 칸에", () => {
  const marks = (items: { status: string }[]) => items.map((item) => item.status);
  assert.deepEqual(marks(connectSteps("provider")), ["waiting", "pending", "pending", "pending"]);
  assert.deepEqual(marks(connectSteps("link", { provider: "aws" })), ["done", "done", "waiting", "pending"]);
  assert.deepEqual(marks(connectSteps("verifying", { provider: "aws" })), ["done", "done", "done", "active"]);
  assert.deepEqual(marks(connectSteps("retry", { provider: "gcp" })), ["done", "done", "done", "failed"]);
  assert.deepEqual(marks(connectSteps("connected", { provider: "onprem" })), ["done", "done", "done", "done"]);
  assert.equal(connectSteps("link", { provider: "onprem" })[2]!.label, "Agent 설치");
});

test("어디서 들어오든 같은 길: 연결됐으면 환경 화면, 아니면 등록 흐름", () => {
  assert.equal(envPath({ id: "e1", connectionStatus: "connected" }), "environments/e1");
  assert.equal(envPath({ id: "e1", connectionStatus: "failed" }), "environments/connect/e1");
  assert.deepEqual(parseRoute("#/environments/connect"), { page: "environments", view: "connect", id: null });
  assert.deepEqual(parseRoute("#/environments/connect/e1"), { page: "environments", view: "connect", id: "e1" });
  assert.deepEqual(parseRoute("#/environments/e1"), { page: "environments", id: "e1" });
});
