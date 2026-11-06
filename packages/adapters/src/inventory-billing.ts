import type { BillingFacts } from "@svc/contracts";
import { arr, get, str as s } from "./common/cli.js";

// 실자원 조회가 비용 계산용으로 같이 남기는 사실 (contracts BillingFacts). 순수 함수: CLI JSON → 사실.
//   화면 자원 묶음(inventory.ts groups)과 같은 응답을 다시 쓰고, 묶음에 없는 것(EC2·GCE 인스턴스, NAT, 고정 주소)만 명령을 더 부른다.
//   더 부르는 명령은 전부 관찰 권한 표(common/observe-permissions.ts)에 이미 있는 읽기 명령이다 (권한 추가 없음).
//   못 읽은 명령은 errors 에만 남긴다 → 환경 건강(ok·partial) 판정과 화면 자원 수는 그대로

/** 명령 하나의 결과. 성공이면 JSON, 실패면 사람이 읽는 이유 */
export type RawResult = { ok: true; json: unknown } | { ok: false; error: string };
export type RawByKey = Partial<Record<string, RawResult>>;

const num = (x: unknown): number | null => {
  const n = typeof x === "number" ? x : typeof x === "string" && x.trim() !== "" ? Number(x) : NaN;
  return Number.isFinite(n) ? n : null;
};
const lastSeg = (x: unknown) => s(x)?.split("/").pop() ?? null;
const tag = (o: Record<string, unknown>, key: string) => s(arr(o.Tags).find((t) => t.Key === key)?.Value);

const empty = (): BillingFacts => ({ clusters: [], instances: [], databases: [], loadBalancers: [], natGateways: [], addresses: [], errors: [] });

function take(raw: RawByKey, key: string, errors: string[]): unknown | null {
  const r = raw[key];
  if (!r) return null;
  if (!r.ok) { errors.push(`${key}: ${r.error}`); return null; }
  return r.json;
}

// ---- AWS ----

/** 비용 계산용으로 AWS 에서 더 부르는 명령 (키 = 관찰 권한 표의 "서비스 동사") */
export const AWS_BILLING_EXTRA: Record<string, string[]> = {
  "ec2 describe-instances": ["ec2", "describe-instances", "--filters", "Name=instance-state-name,Values=pending,running"],
  "ec2 describe-nat-gateways": ["ec2", "describe-nat-gateways"],
  "ec2 describe-addresses": ["ec2", "describe-addresses"],
};

export function awsBilling(raw: RawByKey): BillingFacts {
  const f = empty();
  const clusters = take(raw, "eks list-clusters", f.errors);
  for (const n of arr(get(clusters, "clusters"))) f.clusters.push({ name: String(n), location: null, zonal: null, autopilot: null, nodeCount: null, machineTypes: [] });

  const inst = take(raw, "ec2 describe-instances", f.errors);
  for (const r of arr(get(inst, "Reservations"))) for (const i of arr(r.Instances)) {
    const type = s(i.InstanceType);
    if (!type) continue;
    f.instances.push({
      name: tag(i, "Name") ?? s(i.InstanceId) ?? "?", type, state: s(get(i, "State", "Name")),
      spot: s(i.InstanceLifecycle) === "spot",
      // EKS 노드 그룹이 붙이는 태그 (관리형·자체 관리 둘 다)
      cluster: tag(i, "eks:cluster-name") ?? tag(i, "aws:eks:cluster-name")
        ?? (arr(i.Tags).map((t) => s(t.Key) ?? "").find((k) => k.startsWith("kubernetes.io/cluster/"))?.slice("kubernetes.io/cluster/".length) ?? null),
      publicIp: s(i.PublicIpAddress),
    });
  }

  const rds = take(raw, "rds describe-db-instances", f.errors);
  for (const d of arr(get(rds, "DBInstances"))) f.databases.push({
    name: s(d.DBInstanceIdentifier) ?? "?", engine: s(d.Engine), cls: s(d.DBInstanceClass),
    storageGb: num(d.AllocatedStorage), storageType: s(d.StorageType), multiAz: typeof d.MultiAZ === "boolean" ? d.MultiAZ : null,
  });

  const lbs = take(raw, "elbv2 describe-load-balancers", f.errors);
  for (const l of arr(get(lbs, "LoadBalancers"))) f.loadBalancers.push({
    name: s(l.LoadBalancerName) ?? "?", type: s(l.Type),
    internetFacing: s(l.Scheme) === null ? null : s(l.Scheme) === "internet-facing",
    zones: Array.isArray(l.AvailabilityZones) ? l.AvailabilityZones.length : null,
  });

  const nat = take(raw, "ec2 describe-nat-gateways", f.errors);
  for (const n of arr(get(nat, "NatGateways"))) {
    const state = s(n.State);
    if (state === "deleted" || state === "deleting" || state === "failed") continue;   // 지운 NAT 도 한동안 목록에 남는다
    f.natGateways.push({ name: tag(n, "Name") ?? s(n.NatGatewayId) ?? "?", state,
      publicIps: arr(n.NatGatewayAddresses).map((a) => s(a.PublicIp)).filter((x): x is string => !!x) });
  }

  const eip = take(raw, "ec2 describe-addresses", f.errors);
  for (const a of arr(get(eip, "Addresses"))) f.addresses.push({
    name: tag(a, "Name") ?? s(a.AllocationId) ?? s(a.PublicIp) ?? "?", ip: s(a.PublicIp), inUse: !!s(a.AssociationId),
  });
  return f;
}

// ---- GCP ----

export const GCP_BILLING_EXTRA: Record<string, (project: string) => string[]> = {
  "compute instances list": (p) => ["compute", "instances", "list", "--project", p, "--format", "json"],
  "compute addresses list": (p) => ["compute", "addresses", "list", "--project", p, "--format", "json"],
  "compute routers list": (p) => ["compute", "routers", "list", "--project", p, "--format", "json"],
};

export function gcpBilling(raw: RawByKey): BillingFacts {
  const f = empty();
  const clusters = take(raw, "container clusters list", f.errors);
  for (const c of arr(clusters)) {
    const location = s(c.location);
    f.clusters.push({
      name: s(c.name) ?? "?", location,
      zonal: location === null ? null : /-[a-z]$/.test(location),   // asia-northeast3-a = 존, asia-northeast3 = 지역
      autopilot: get(c, "autopilot", "enabled") === true,
      nodeCount: num(c.currentNodeCount),
      machineTypes: [...new Set(arr(c.nodePools).map((p) => s(get(p, "config", "machineType"))).filter((x): x is string => !!x))],
    });
  }

  const inst = take(raw, "compute instances list", f.errors);
  for (const i of arr(inst)) {
    const type = lastSeg(i.machineType);
    if (!type) continue;
    const status = s(i.status);
    if (status && !/^(RUNNING|PROVISIONING|STAGING)$/.test(status)) continue;   // 멈춘 VM 은 vCPU·메모리 요금이 없다
    const natIp = arr(i.networkInterfaces).flatMap((n) => arr(n.accessConfigs)).map((a) => s(a.natIP)).find((x) => !!x) ?? null;
    f.instances.push({
      name: s(i.name) ?? "?", type, state: status,
      spot: s(get(i, "scheduling", "provisioningModel")) === "SPOT" || get(i, "scheduling", "preemptible") === true,
      cluster: s(get(i, "labels", "goog-k8s-cluster-name")),
      publicIp: natIp,
    });
  }

  const sql = take(raw, "sql instances list", f.errors);
  for (const d of arr(sql)) f.databases.push({
    name: s(d.name) ?? "?", engine: s(d.databaseVersion), cls: s(get(d, "settings", "tier")),
    storageGb: num(get(d, "settings", "dataDiskSizeGb")), storageType: s(get(d, "settings", "dataDiskType")),
    multiAz: s(get(d, "settings", "availabilityType")) === null ? null : s(get(d, "settings", "availabilityType")) === "REGIONAL",
  });

  const fwd = take(raw, "compute forwarding-rules list", f.errors);
  for (const r of arr(fwd)) f.loadBalancers.push({
    name: s(r.name) ?? "?", type: s(r.loadBalancingScheme),
    internetFacing: s(r.loadBalancingScheme) === null ? null : /^EXTERNAL/.test(s(r.loadBalancingScheme) ?? ""),
    zones: null,
  });

  const addr = take(raw, "compute addresses list", f.errors);
  for (const a of arr(addr)) {
    if (s(a.addressType) && s(a.addressType) !== "EXTERNAL") continue;   // 내부 주소는 요금 없음
    f.addresses.push({ name: s(a.name) ?? "?", ip: s(a.address), inUse: s(a.status) === "IN_USE" });
  }

  const routers = take(raw, "compute routers list", f.errors);
  for (const r of arr(routers)) for (const n of arr(r.nats)) f.natGateways.push({
    name: s(n.name) ?? "?", state: null, publicIps: arr(n.natIps).map((x) => lastSeg(x) ?? "").filter(Boolean),
  });
  return f;
}
