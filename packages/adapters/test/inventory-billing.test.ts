import { test } from "node:test";
import assert from "node:assert/strict";
import { BillingFacts } from "@svc/contracts";
import { awsBilling, gcpBilling, inventoryToStatus, readInventory } from "../src/index.js";

// 실자원 조회가 비용 화면용으로 같이 남기는 사실 (inventory-billing.ts)
const ok = (json: unknown) => ({ ok: true as const, json });
const fake = (table: Record<string, { code: number; stdout?: string; stderr?: string }>) =>
  async (cmd: string, args: string[]) => {
    const key = `${cmd} ${args.slice(0, 2).join(" ")}`;
    const hit = table[key] ?? { code: 1, stderr: `no fake for ${key}` };
    return { code: hit.code, stdout: hit.stdout ?? "", stderr: hit.stderr ?? "", ms: 1 };
  };

test("AWS 사실: EKS 노드 태그로 클러스터를 잇고, 지운 NAT 는 빼고, EIP 연결 여부를 남긴다", () => {
  const f = BillingFacts.parse(awsBilling({
    "eks list-clusters": ok({ clusters: ["shop-eks"] }),
    "ec2 describe-instances": ok({ Reservations: [{ Instances: [
      { InstanceId: "i-1", InstanceType: "t3.medium", State: { Name: "running" }, Tags: [{ Key: "eks:cluster-name", Value: "shop-eks" }] },
      { InstanceId: "i-2", InstanceType: "m5.large", State: { Name: "running" }, InstanceLifecycle: "spot", PublicIpAddress: "1.1.1.1",
        Tags: [{ Key: "kubernetes.io/cluster/self-managed", Value: "owned" }, { Key: "Name", Value: "worker" }] },
      { InstanceId: "i-3", InstanceType: "t3.micro", State: { Name: "running" } },
    ] }] }),
    "rds describe-db-instances": ok({ DBInstances: [{ DBInstanceIdentifier: "db", Engine: "postgres", DBInstanceClass: "db.t3.medium", AllocatedStorage: 20, MultiAZ: true }] }),
    "elbv2 describe-load-balancers": ok({ LoadBalancers: [{ LoadBalancerName: "alb", Type: "application", Scheme: "internet-facing", AvailabilityZones: [{}, {}, {}] }] }),
    "ec2 describe-nat-gateways": ok({ NatGateways: [{ NatGatewayId: "nat-a", State: "available", NatGatewayAddresses: [{ PublicIp: "2.2.2.2" }] }, { NatGatewayId: "nat-old", State: "deleted" }] }),
    "ec2 describe-addresses": ok({ Addresses: [{ PublicIp: "2.2.2.2", AssociationId: "x" }, { PublicIp: "9.9.9.9", AllocationId: "eipalloc-9" }] }),
  }));
  assert.deepEqual(f.instances.map((i) => [i.name, i.type, i.cluster, i.spot]), [
    ["i-1", "t3.medium", "shop-eks", false], ["worker", "m5.large", "self-managed", true], ["i-3", "t3.micro", null, false]]);
  assert.deepEqual(f.databases[0], { name: "db", engine: "postgres", cls: "db.t3.medium", storageGb: 20, storageType: null, multiAz: true });
  assert.deepEqual(f.loadBalancers[0], { name: "alb", type: "application", internetFacing: true, zones: 3 });
  assert.deepEqual(f.natGateways.map((n) => n.name), ["nat-a"]);
  assert.deepEqual(f.addresses.map((a) => [a.ip, a.inUse]), [["2.2.2.2", true], ["9.9.9.9", false]]);
  assert.deepEqual(f.errors, []);
});

test("GCP 사실: 존·지역 클러스터, GCE 인스턴스(멈춘 VM 제외)·외부 IP, Cloud SQL 등급·HA, 내부 주소 제외, Cloud NAT", () => {
  const f = BillingFacts.parse(gcpBilling({
    "container clusters list": ok([
      { name: "z", location: "asia-northeast3-a", currentNodeCount: 2, nodePools: [{ config: { machineType: "e2-standard-2" } }] },
      { name: "r", location: "asia-northeast3", autopilot: { enabled: true } },
    ]),
    "compute instances list": ok([
      { name: "gke-z-1", machineType: "zones/asia-northeast3-a/machineTypes/e2-standard-2", status: "RUNNING", labels: { "goog-k8s-cluster-name": "z" },
        networkInterfaces: [{ accessConfigs: [{ natIP: "34.1.1.1" }] }] },
      { name: "stopped", machineType: "x/e2-medium", status: "TERMINATED" },
      { name: "spot", machineType: "x/e2-medium", status: "RUNNING", scheduling: { provisioningModel: "SPOT" } },
    ]),
    "sql instances list": ok([{ name: "pg", databaseVersion: "POSTGRES_16", settings: { tier: "db-custom-2-7680", dataDiskSizeGb: "10", availabilityType: "REGIONAL" } }]),
    "compute forwarding-rules list": ok([{ name: "fr", loadBalancingScheme: "EXTERNAL" }]),
    "compute addresses list": ok([{ name: "nat-ip", address: "34.9.9.9", status: "IN_USE", addressType: "EXTERNAL" }, { name: "int", address: "10.0.0.5", addressType: "INTERNAL" }]),
    "compute routers list": ok([{ name: "r1", nats: [{ name: "nat", natIps: ["projects/p/regions/x/addresses/nat-ip"] }] }]),
  }));
  assert.deepEqual(f.clusters.map((c) => [c.name, c.zonal, c.autopilot, c.machineTypes]), [["z", true, false, ["e2-standard-2"]], ["r", false, true, []]]);
  assert.deepEqual(f.instances.map((i) => [i.name, i.type, i.spot, i.cluster, i.publicIp]), [
    ["gke-z-1", "e2-standard-2", false, "z", "34.1.1.1"], ["spot", "e2-medium", true, null, null]]);
  assert.deepEqual(f.databases[0], { name: "pg", engine: "POSTGRES_16", cls: "db-custom-2-7680", storageGb: 10, storageType: null, multiAz: true });
  assert.deepEqual(f.addresses, [{ name: "nat-ip", ip: "34.9.9.9", inUse: true }]);
  assert.deepEqual(f.natGateways, [{ name: "nat", state: null, publicIps: ["nat-ip"] }]);
});

test("거부: 비용용 명령이 실패해도 환경 건강·자원 묶음은 그대로, 실패는 billing.errors 에만", async () => {
  const inv = await readInventory("aws", { env: { AWS_REGION: "ap-northeast-2" }, exec: fake({
    "aws sts get-caller-identity": { code: 0, stdout: JSON.stringify({ Account: "000000000000" }) },
    "aws eks list-clusters": { code: 0, stdout: JSON.stringify({ clusters: ["c"] }) },
    "aws rds describe-db-instances": { code: 0, stdout: JSON.stringify({ DBInstances: [] }) },
    "aws ec2 describe-vpcs": { code: 0, stdout: JSON.stringify({ Vpcs: [] }) },
    "aws elbv2 describe-load-balancers": { code: 0, stdout: JSON.stringify({ LoadBalancers: [] }) },
    "aws ecr describe-repositories": { code: 0, stdout: JSON.stringify({ repositories: [] }) },
    "aws ec2 describe-instances": { code: 254, stderr: "An error occurred (UnauthorizedOperation)" },
    "aws ec2 describe-nat-gateways": { code: 0, stdout: JSON.stringify({ NatGateways: [] }) },
  }) });
  assert.equal(inv.status, "ok");
  assert.equal(inventoryToStatus(inv, { envId: "e", provider: "aws", region: "x" }).health, "healthy");
  assert.equal(inv.groups.length, 5);                      // 화면 묶음 수는 그대로
  assert.deepEqual(inv.billing?.clusters.map((c) => c.name), ["c"]);
  assert.ok(inv.billing?.errors.some((e) => e.startsWith("ec2 describe-instances: ") && e.includes("UnauthorizedOperation")));
  assert.ok(inv.billing?.errors.some((e) => e.startsWith("ec2 describe-addresses: ")));
});
