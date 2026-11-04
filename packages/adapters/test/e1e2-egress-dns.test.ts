// E-1: 출발 나가는 IP(NAT) → IR posture.egress + 계획 승인 줄. E-2: 사설 DNS 이름 → DB·캐시 별칭(링크) + IR privateDns + 계획 줄
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkV2, ImportResultV2, type RawInventory } from "@svc/contracts";
import { normalizeV2 } from "../src/import/pipeline.js";
import { readAwsNet, readGcpNet } from "../src/discover/net.js";
import { v2PrecheckItems } from "../src/index.js";

const D = "sha256:" + "12".repeat(32);
type Raw = Record<string, any>;
const dep = (env: Raw[]): Raw => ({ kind: "k8s.deployment", imageDigest: D, metadata: { name: "shop-api", namespace: "shop", labels: { app: "shop-api" } },
  spec: { replicas: 1, selector: { matchLabels: { app: "shop-api" } }, template: { metadata: { labels: { app: "shop-api" } }, spec: { containers: [{
    name: "shop-api", image: "ghcr.io/demo/shop-api:1.0", ports: [{ containerPort: 8080 }], env }] } } } });
const RDS_EP = "shop-db.abc.ap-northeast-2.rds.amazonaws.com";
const rds = { kind: "rds.dbInstance", DBInstanceIdentifier: "shop-db", Engine: "postgres", EngineVersion: "16.3", AllocatedStorage: 20, DBInstanceClass: "db.t4g.micro", Endpoint: RDS_EP };
const ok = (o: unknown) => ({ code: 0, stdout: JSON.stringify(o), stderr: "", ms: 1 });
const inv = (items: Raw[], provider = "aws"): RawInventory => ({ provider, coverage: {}, items } as RawInventory);

test("E-1·E-2 읽기(AWS): NAT 공인 IP, VPC 사설 영역 A·CNAME·별칭 레코드 (TXT·MX 는 뺌)", async () => {
  const calls: string[] = [];
  const exec = async (bin: string, args: string[]) => {
    const s = args.join(" "); calls.push(s);
    if (/^ec2 describe-nat-gateways/.test(s)) return ok({ NatGateways: [{ State: "available", NatGatewayAddresses: [{ PublicIp: "203.0.113.10" }] }, { State: "deleted", NatGatewayAddresses: [{ PublicIp: "203.0.113.99" }] }] });
    if (/^route53 list-hosted-zones-by-vpc/.test(s)) return ok({ HostedZoneSummaries: [{ HostedZoneId: "Z1", Name: "internal.example." }] });
    if (/^route53 list-resource-record-sets/.test(s)) return ok({ ResourceRecordSets: [
      { Name: "db.internal.example.", Type: "CNAME", ResourceRecords: [{ Value: `${RDS_EP}.` }] },
      { Name: "lb.internal.example.", Type: "A", AliasTarget: { DNSName: "internal-lb-1.ap-northeast-2.elb.amazonaws.com." } },
      { Name: "internal.example.", Type: "TXT", ResourceRecords: [{ Value: "\"v=spf1\"" }] },
    ] });
    return ok({});
  };
  const notes: string[] = [];
  const out = await readAwsNet({ exec: exec as never, env: {} }, "ap-northeast-2", "vpc-1", notes);
  assert.deepEqual(out.find((x) => x.kind === "net.egress"), { kind: "net.egress", source: "aws:nat-gateway", ips: ["203.0.113.10"], fixed: true });
  assert.deepEqual(out.filter((x) => x.kind === "dns.record").map((r) => [r.name, r.type, r.values]), [
    ["db.internal.example", "CNAME", [RDS_EP]], ["lb.internal.example", "A", ["internal-lb-1.ap-northeast-2.elb.amazonaws.com"]]]);
  assert.ok(calls.every((c) => /^(ec2 describe-nat-gateways|route53 list-)/.test(c)), "읽기 명령만");
  assert.deepEqual(notes, []);
});

test("E-2 정상: 앱이 사설 이름(db.internal.example)으로 DB 를 적어도 링크가 생기고 host 로 다시 씀, IR privateDns + 계획 줄", () => {
  const { result } = normalizeV2(inv([dep([{ name: "DB_HOST", value: "db.internal.example" }]), rds,
    { kind: "dns.record", zone: "internal.example", name: "db.internal.example", type: "CNAME", values: [RDS_EP] },
    { kind: "dns.record", zone: "internal.example", name: "other.internal.example", type: "A", values: ["10.0.0.9"] },
    { kind: "net.egress", source: "aws:nat-gateway", ips: ["203.0.113.10"], fixed: true }]));
  assert.equal(ImportResultV2.safeParse(result).success, true);
  assert.deepEqual(checkV2(result.spec).errors, []);
  assert.ok(result.spec.links.some((l) => l.from === "shop-api" && l.to === "shop-db"));
  const env = (result.spec.components.find((c) => c.id === "shop-api") as unknown as { props: { env: Raw[] } }).props.env;
  assert.deepEqual(env.find((e) => e.name === "DB_HOST")!.fromLink, { to: "shop-db", output: "host" });
  assert.deepEqual(result.spec.privateDns, [{ zone: "internal.example", name: "db.internal.example", type: "CNAME", to: "shop-db" }], "IR 자원을 안 가리키는 레코드는 안 담음");
  assert.deepEqual(result.spec.posture.egress, { source: "aws:nat-gateway", ips: ["203.0.113.10"], fixed: true });
  const pc = v2PrecheckItems("gcp", { specV2: result.spec });
  const eg = pc.find((p) => p.id === "PC-V2-EGRESS")!, dns = pc.find((p) => p.id === "PC-V2-DNS")!;
  assert.equal(eg.level, "warn"); assert.match(eg.message, /203\.0\.113\.10/);
  assert.equal(dns.level, "warn"); assert.match(dns.message, /db\.internal\.example→shop-db/);
});

test("E-1·E-2 거부: 레코드·NAT 가 없으면 칸도 계획 줄도 없음 / 없는 자원을 가리키는 privateDns 는 checkV2 가 막음", () => {
  const { result } = normalizeV2(inv([dep([{ name: "DB_HOST", value: RDS_EP }]), rds]));
  assert.equal(result.spec.privateDns, undefined);
  assert.equal(result.spec.posture.egress, undefined);
  const pc = v2PrecheckItems("gcp", { specV2: result.spec });
  assert.ok(!pc.some((p) => p.id === "PC-V2-EGRESS" || p.id === "PC-V2-DNS"));
  const bad = { ...result.spec, privateDns: [{ zone: "z", name: "x.z", type: "A" as const, to: "nope" }] };
  assert.ok(checkV2(bad).errors.some((e) => /가리키는 자원 없음/.test(e)));
});

test("E-1 GCP: Cloud NAT 수동 주소 → 주소 목록에서 IP, 자동 할당이 섞이면 fixed=false", async () => {
  const exec = async (_b: string, args: string[]) => {
    const s = args.join(" ");
    if (/^compute routers list/.test(s)) return ok([{ nats: [{ natIpAllocateOption: "MANUAL_ONLY", natIps: ["https://x/regions/r/addresses/nat-1"] }, { natIpAllocateOption: "AUTO_ONLY" }] }]);
    if (/^compute addresses list/.test(s)) return ok([{ name: "nat-1", address: "198.51.100.5", selfLink: "https://x/regions/r/addresses/nat-1" }]);
    return ok([]);
  };
  const out = await readGcpNet({ exec: exec as never, env: {} }, "p1", []);
  assert.deepEqual(out, [{ kind: "net.egress", source: "gcp:cloud-nat", ips: ["198.51.100.5"], fixed: false }]);
});
