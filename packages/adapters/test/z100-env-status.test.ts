// Z100 (기능 #4): 환경 상태(GET /environments/:id/status)를 실자원 읽기 결과로 채우는 순수 변환. CLI 는 가짜 exec
import { test } from "node:test";
import assert from "node:assert/strict";
import { EnvironmentStatus } from "../../../apps/api/src/routes/responses.js";
import { inventoryToStatus, itemState, readInventory } from "../src/index.js";

const fake = (table: Record<string, { code: number; stdout?: string; stderr?: string }>) =>
  async (cmd: string, args: string[]) => {
    const key = `${cmd} ${args.slice(0, 2).join(" ")}`;
    const hit = table[key] ?? { code: 1, stderr: `no fake for ${key}` };
    return { code: hit.code, stdout: hit.stdout ?? "", stderr: hit.stderr ?? "", ms: 1 };
  };
const T = (provider: "aws" | "gcp" | "onprem") => ({ envId: "e1", provider, region: "default" });

test("itemState: 클라우드 상태 글자 → 자원 상태", () => {
  assert.equal(itemState(null), "Succeeded");
  assert.equal(itemState("available"), "Succeeded");
  assert.equal(itemState("RUNNABLE"), "Succeeded");
  assert.equal(itemState("PROVISIONING"), "Creating");
  assert.equal(itemState("deleting"), "Deleting");
  assert.equal(itemState("NotReady"), "Failed");
  assert.equal(itemState("ERROR"), "Failed");
  assert.equal(itemState("2/2 준비"), "Succeeded");
  assert.equal(itemState("0/1 준비"), "Failed");
  assert.equal(itemState("0/0 준비"), "Succeeded");   // 일부러 0 대로 줄인 출발 앱
});

test("aws: 다 읽히고 다 정상이면 healthy + 자원 목록, 응답 스키마 통과", async () => {
  const inv = await readInventory("aws", { env: { AWS_REGION: "ap-northeast-2" }, exec: fake({
    "aws sts get-caller-identity": { code: 0, stdout: JSON.stringify({ Account: "000000000000" }) },
    "aws eks list-clusters": { code: 0, stdout: JSON.stringify({ clusters: ["finals-eks"] }) },
    "aws rds describe-db-instances": { code: 0, stdout: JSON.stringify({ DBInstances: [{ DBInstanceIdentifier: "shop-db", DBInstanceStatus: "available" }] }) },
    "aws ec2 describe-vpcs": { code: 0, stdout: JSON.stringify({ Vpcs: [] }) },
    "aws elbv2 describe-load-balancers": { code: 0, stdout: JSON.stringify({ LoadBalancers: [] }) },
    "aws ecr describe-repositories": { code: 0, stdout: JSON.stringify({ repositories: [] }) },
  }) });
  const st = inventoryToStatus(inv, T("aws"));
  assert.equal(st.health, "healthy");
  assert.equal(st.mock, false);
  assert.equal(st.region, "ap-northeast-2");
  assert.deepEqual(st.resources.map((r) => [r.name, r.state]), [["finals-eks", "Succeeded"], ["shop-db", "Succeeded"]]);
  EnvironmentStatus.parse(st);
});

test("aws: 한 묶음 읽기 실패(partial) → degraded", async () => {
  const inv = await readInventory("aws", { env: {}, exec: fake({
    "aws sts get-caller-identity": { code: 0, stdout: "{}" },
    "aws eks list-clusters": { code: 0, stdout: JSON.stringify({ clusters: [] }) },
    "aws rds describe-db-instances": { code: 254, stderr: "AccessDenied" },
    "aws ec2 describe-vpcs": { code: 0, stdout: "{}" }, "aws elbv2 describe-load-balancers": { code: 0, stdout: "{}" },
    "aws ecr describe-repositories": { code: 0, stdout: "{}" },
  }) });
  assert.equal(inventoryToStatus(inv, T("aws")).health, "degraded");
});

test("onprem: 준비 안 된 노드가 있으면 degraded", async () => {
  const node = (ready: string) => ({ metadata: { name: `n-${ready}` }, status: { conditions: [{ type: "Ready", status: ready }] } });
  const inv = await readInventory("onprem", { env: {}, exec: fake({
    "kubectl version --client": { code: 0, stdout: "{}" },
    "kubectl get nodes": { code: 0, stdout: JSON.stringify({ items: [node("True"), node("False")] }) },
    "kubectl get clusters.postgresql.cnpg.io": { code: 0, stdout: JSON.stringify({ items: [] }) },
    "kubectl get deployments": { code: 0, stdout: JSON.stringify({ items: [] }) },
    "kubectl get services": { code: 0, stdout: JSON.stringify({ items: [] }) },
  }) });
  const st = inventoryToStatus(inv, T("onprem"));
  assert.equal(st.health, "degraded");
  assert.ok(st.resources.some((r) => r.state === "Failed"));
});

test("자격·CLI 없음 → 가짜 값 없이 unknown + 빈 목록 (예전 stubStatus 와 같은 모양)", async () => {
  const inv = await readInventory("gcp", { env: {}, exec: fake({ "gcloud config get-value": { code: 127, stderr: "ENOENT" } }) });
  const st = inventoryToStatus(inv, T("gcp"));
  assert.equal(st.health, "unknown");
  assert.deepEqual(st.resources, []);
  assert.equal(st.region, "default");
  EnvironmentStatus.parse(st);
});
