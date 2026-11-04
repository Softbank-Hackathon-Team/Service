// A: 출발 읽기 정확성 (CR-1 Cloud Run 트래픽 판 · EA-1 ALB 기본 규칙 입구 · VM-1 VM 묶음 열쇠 · FW-1 GCE 대상·deny, EC2 IPv6·접두어 목록) + 비k8s 정확도 칸. 클라우드 호출 0
import { test } from "node:test";
import assert from "node:assert/strict";
import type { RawInventory } from "@svc/contracts";
type NetRow = { subject?: string; public?: boolean | null; ingress?: unknown };
const netOf = (spec: { posture: { network: unknown[] } }, id: string) => (spec.posture.network as NetRow[]).find((n) => n.subject === id);
import { measureImportAccuracy, normalizeV2, readCloudRun, readEc2, readGce } from "../src/index.js";
import type { Exec } from "../src/terraform/real-runner.js";

type Reply = { code?: number; out?: unknown; err?: string };
function fakeExec(table: Array<[RegExp, Reply]>) {
  const calls: string[] = [];
  const exec: Exec = async (cmd, args) => {
    const line = `${cmd} ${args.join(" ")}`; calls.push(line);
    const hit = table.find(([re]) => re.test(line));
    if (!hit) return { code: 1, stdout: "", stderr: `no fake for: ${line}`, ms: 1 };
    return { code: hit[1].code ?? 0, stdout: JSON.stringify(hit[1].out ?? null), stderr: hit[1].err ?? "", ms: 1 };
  };
  return { exec, calls };
}
const D_OLD = "sha256:" + "0a".repeat(32), D_NEW = "sha256:" + "0b".repeat(32);
const REG = "asia-northeast3";
const ctr = (tag: string, env: string) => [{ name: "api", image: `${REG}-docker.pkg.dev/p/shop/api:${tag}`, ports: [{ containerPort: 8080 }], env: [{ name: env, value: "x" }] }];
const runSvc = (traffic: unknown[]) => ({ metadata: { name: "shop-api", uid: "uid-api", labels: { "cloud.googleapis.com/location": REG } },
  spec: { template: { spec: { containers: ctr("2.0", "NEW_ONLY") } } },
  status: { url: "https://shop-api-x.a.run.app", latestReadyRevisionName: "shop-api-00002-new", traffic } });
const runTable = (traffic: unknown[]): Array<[RegExp, Reply]> => [
  [/^gcloud run services list/, { out: [runSvc(traffic)] }],
  [/^gcloud run revisions describe shop-api-00001-old/, { out: { spec: { containers: ctr("1.0", "OLD_ONLY") }, status: { imageDigest: D_OLD } } }],
  [/^gcloud run revisions describe shop-api-00002-new/, { out: { spec: { containers: ctr("2.0", "NEW_ONLY") }, status: { imageDigest: D_NEW } } }],
  [/^gcloud run services get-iam-policy/, { out: { bindings: [] } }],
  [/^gcloud run (domain-mappings|jobs) list/, { out: [] }],
];

test("CR-1 정상: 새 판을 --no-traffic 으로 올려 두고 옛 판이 100% 면 옛 판의 digest·컨테이너를 같이 옮긴다 (틀·digest 안 섞임)", async () => {
  const r = await readCloudRun({ exec: fakeExec(runTable([{ revisionName: "shop-api-00001-old", percent: 100 }, { revisionName: "shop-api-00002-new", percent: 0, tag: "canary" }])).exec, env: {} }, "p", {});
  const s = r.items[0] as Record<string, any>;
  assert.equal(s.revision, "shop-api-00001-old");
  assert.equal(s.imageDigest, D_OLD);
  assert.deepEqual(s.containers[0].env.map((e: { name: string }) => e.name), ["OLD_ONLY"]);
  assert.equal(s.trafficSplit, undefined);
  assert.ok(r.notes.some((n) => /트래픽을 받는 판 shop-api-00001-old/.test(n)));
  const { result } = normalizeV2({ provider: "gcp", coverage: {}, items: r.items } as RawInventory);
  assert.equal(result.fieldMeta["components.shop-api.image"]?.needs_review ?? false, false);
});

test("CR-1 거부: 트래픽이 두 판에 나뉘면 큰 판만 옮기고 검토 0.6, latestRevision 줄은 최신 준비 판으로 읽음", async () => {
  const r = await readCloudRun({ exec: fakeExec(runTable([{ latestRevision: true, percent: 70 }, { revisionName: "shop-api-00001-old", percent: 30 }])).exec, env: {} }, "p", {});
  const s = r.items[0] as Record<string, any>;
  assert.equal(s.imageDigest, D_NEW);
  assert.deepEqual(s.trafficSplit, [{ revision: "shop-api-00002-new", percent: 70 }, { revision: "shop-api-00001-old", percent: 30 }]);
  const { result } = normalizeV2({ provider: "gcp", coverage: {}, items: r.items } as RawInventory);
  const m = result.fieldMeta["components.shop-api.image"]!;
  assert.equal(m.needs_review, true); assert.equal(m.confidence, 0.6); assert.match(m.rationale ?? "", /2개에 나뉨/);
});

test("EA-1: 기본 규칙(호스트 조건 없음)만 있는 ALB → ALB 주소 호스트로 입구가 생기고 검토 줄 1, HTTPS 리스너 → tls", () => {
  const D = "sha256:" + "ee".repeat(32);
  const { result } = normalizeV2({ provider: "aws", coverage: {}, items: [{ kind: "ecs.service", serviceName: "shop-web", serviceArn: "arn:aws:ecs:r:1:service/c/shop-web", desiredCount: 1, imageDigest: D,
    taskDefinition: { containerDefinitions: [{ name: "web", image: "repo/web:1", essential: true, portMappings: [{ containerPort: 3000 }] }] },
    loadBalancers: [{ containerName: "web", containerPort: 3000 }],
    routes: [{ host: "shop-123.elb.amazonaws.com", path: null, priority: null, listenerPort: 443, listenerProtocol: "HTTPS", hostUnknown: true }] }] } as RawInventory);
  const h = result.spec.entry?.hosts.find((x) => x.hostnames[0] === "shop-123.elb.amazonaws.com");
  assert.ok(h, "입구가 생김");
  assert.deepEqual(h!.tls, { mode: "terminate", source: "alb.listener HTTPS" });
  assert.equal(result.fieldMeta["entry.shop-123.elb.amazonaws.com.hostnames"]?.needs_review, true);
});

const gceInst = (name: string, o: { mig?: string; net?: string; sa?: string; tags?: string[] } = {}) => ({ name, status: "RUNNING", machineType: "zones/z/machineTypes/e2-medium", zone: "zones/asia-northeast3-a",
  tags: { items: o.tags ?? [] }, serviceAccounts: [{ email: o.sa ?? "app@p.iam.gserviceaccount.com" }],
  networkInterfaces: [{ network: `projects/p/global/networks/${o.net ?? "prod"}` }],
  metadata: { items: [{ key: "startup-script", value: "export DB_PASSWORD=hunter2" }, ...(o.mig ? [{ key: "created-by", value: `projects/1/zones/z/instanceGroupManagers/${o.mig}` }] : [])] } });

test("VM-1·FW-1 GCE: MIG 인스턴스 3대(무작위 꼬리) → 묶음 1개, 단독 VM 은 그대로. 다른 네트워크·다른 SA 대상 규칙은 안 붙고 deny 는 검토", async () => {
  const fw = [
    { name: "open-web-other-net", direction: "INGRESS", network: "projects/p/global/networks/dev", sourceRanges: ["0.0.0.0/0"], allowed: [{ IPProtocol: "tcp", ports: ["80"] }] },
    { name: "open-other-sa", direction: "INGRESS", network: "projects/p/global/networks/prod", targetServiceAccounts: ["other@p.iam.gserviceaccount.com"], sourceRanges: ["0.0.0.0/0"], allowed: [{ IPProtocol: "tcp", ports: ["81"] }] },
    { name: "app-from-lb", direction: "INGRESS", network: "projects/p/global/networks/prod", targetServiceAccounts: ["app@p.iam.gserviceaccount.com"], sourceServiceAccounts: ["lb@p.iam.gserviceaccount.com"], allowed: [{ IPProtocol: "tcp", ports: ["8080"] }] },
    { name: "deny-redis", direction: "INGRESS", network: "projects/p/global/networks/prod", sourceRanges: ["0.0.0.0/0"], denied: [{ IPProtocol: "tcp", ports: ["6379"] }] },
  ];
  const { exec, calls } = fakeExec([
    [/^gcloud compute instances list/, { out: [gceInst("web-mig-a1b2", { mig: "web-mig" }), gceInst("web-mig-c3d4", { mig: "web-mig" }), gceInst("web-mig-x9y8", { mig: "web-mig" }), gceInst("bastion")] }],
    [/^gcloud compute firewall-rules list/, { out: fw }],
  ]);
  const r = await readGce({ exec, env: {} }, "p", {});
  const g = r.items as Array<Record<string, any>>;
  assert.deepEqual(g.map((x) => [x.name, x.count]), [["bastion", 1], ["web-mig", 3]]);
  const web = g.find((x) => x.name === "web-mig")!;
  assert.deepEqual(web.ingress, [{ protocol: "tcp", fromPort: 8080, toPort: 8080, sources: ["sa:lb"] }], "다른 네트워크·다른 SA 대상 0.0.0.0/0 규칙은 안 붙음");
  assert.match(web.ingressReview, /deny-redis/);
  assert.ok(!JSON.stringify(r.items).includes("hunter2"), "metadata 값은 안 담음");
  assert.ok(calls.every((c) => / (list)( |$)/.test(c)));
  const { result } = normalizeV2({ provider: "gcp", coverage: {}, items: r.items } as RawInventory);
  const id = result.spec.components.find((c) => c.kind === "service" && (c as { props: { replicas: { min: number } } }).props.replicas.min === 3)!.id;
  assert.equal(result.fieldMeta[`components.${id}.network`]?.needs_review, true);
  assert.equal(netOf(result.spec, id!)?.public, false, "남의 공개 규칙 때문에 공개로 열리지 않음");
});

test("VM-1·FW-1 EC2: ASG 태그로 묶고(Name 없어도), IPv6·접두어 목록 출발지를 담는다", async () => {
  const inst = (id: string, tags: Array<{ Key: string; Value: string }>) => ({ InstanceId: id, InstanceType: "t3.small", State: { Name: "running" }, Placement: { AvailabilityZone: "ap-northeast-2a" },
    SecurityGroups: [{ GroupId: "sg-1" }], Tags: tags });
  const { exec } = fakeExec([
    [/^aws ec2 describe-instances/, { out: { Reservations: [{ Instances: [inst("i-aaa", [{ Key: "aws:autoscaling:groupName", Value: "shop-asg" }]), inst("i-bbb", [{ Key: "aws:autoscaling:groupName", Value: "shop-asg" }, { Key: "Name", Value: "shop-2" }]), inst("i-ccc", [])] }] } }],
    [/^aws ec2 describe-security-groups/, { out: { SecurityGroups: [{ GroupId: "sg-1", IpPermissions: [
      { IpProtocol: "tcp", FromPort: 443, ToPort: 443, IpRanges: [], Ipv6Ranges: [{ CidrIpv6: "::/0" }], PrefixListIds: [{ PrefixListId: "pl-cf01" }], UserIdGroupPairs: [] }] }] } }],
    [/^aws ec2 describe-instance-types/, { out: { InstanceTypes: [{ InstanceType: "t3.small", VCpuInfo: { DefaultVCpus: 2 }, MemoryInfo: { SizeInMiB: 2048 } }] } }],
  ]);
  const r = await readEc2({ exec, env: {} }, "ap-northeast-2", {});
  const g = r.items as Array<Record<string, any>>;
  assert.deepEqual(g.map((x) => [x.name, x.count]), [["i-ccc", 1], ["shop-asg", 2]]);
  assert.deepEqual(g[1]!.ingress, [{ protocol: "tcp", fromPort: 443, toPort: 443, sources: ["::/0", "pl:pl-cf01"] }]);
  const { result } = normalizeV2({ provider: "aws", coverage: {}, items: r.items } as RawInventory);
  const n = netOf(result.spec, "shop-asg");
  assert.deepEqual((n?.ingress as Array<{ from: string }>).map((x) => x.from), ["::/0", "pl:pl-cf01"], "그 포트가 사라지지 않음");
  assert.equal(n?.public, false, "공개 IP 없음 → 공개 아님");
  // 정확도: VM 묶음 복제 수·크기 칸
  const a = measureImportAccuracy({ inventory: { provider: "aws", coverage: {}, items: r.items } as RawInventory, result });
  assert.ok(a.fields.some((f) => f.component === "shop-asg" && f.field === "replicas" && f.result === "match"), JSON.stringify(a.fields));
  assert.ok(a.fields.some((f) => f.component === "shop-asg" && f.field === "resources.cpu" && f.result === "match"));
});

test("정확도(Cloud Run): 명세에서 환경변수를 지우면 env.names 불일치로 잡힌다", async () => {
  const r = await readCloudRun({ exec: fakeExec(runTable([{ revisionName: "shop-api-00002-new", percent: 100 }])).exec, env: {} }, "p", {});
  const inv = { provider: "gcp", coverage: {}, items: r.items } as RawInventory;
  const { result } = normalizeV2(inv);
  const ok = measureImportAccuracy({ inventory: inv, result });
  assert.ok(ok.fields.some((f) => f.field === "image.digest" && f.result === "match"));
  assert.equal(ok.mismatched, 0, JSON.stringify(ok.fields));
  const bad = structuredClone(result);
  (bad.spec.components.find((c) => c.id === "shop-api") as unknown as { props: { env: unknown[] } }).props.env = [];
  assert.ok(measureImportAccuracy({ inventory: inv, result: bad }).fields.some((f) => f.field === "env.names" && f.result === "mismatch"));
});
