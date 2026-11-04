// VMIMPORT: VM 출발(EC2·GCE) 가져오기. 픽스처 EC2 2묶음 → discover(v2) → normalizeV2 → 명세. 정상 + 거부(비밀 태그·쓰기 권한·권한 없음) + 결정성
import { test } from "node:test";
import assert from "node:assert/strict";
import { AppSpecV2, checkV2 } from "@svc/contracts";
import { checkLeastPrivilege } from "@svc/security";
import { discoverAws, discoverGcp, normalizeV2, actionsOfCommands, EC2_OBSERVE_ACTIONS, GCE_OBSERVE_PERMISSIONS, type Target } from "../src/index.js";
import { gceSize, groupNameOf, secretLooking } from "../src/import/readers/vm-common.js";
import { appPorts } from "../src/import/mappers/vm-instance.js";

type Call = string;
const SECRET_TAG = "tag-secret-value-Zq81xY";
const SECRET_NAME = "svc_pat_abcdefghijkl1234";
const inst = (id: string, name: string, type: string, sg: string[], extra: Record<string, unknown> = {}) => ({
  InstanceId: id, InstanceType: type, State: { Name: "running" }, Placement: { AvailabilityZone: "ap-northeast-2a" },
  SecurityGroups: sg.map((g) => ({ GroupId: g })), PublicIpAddress: extra.pub ? "203.0.113.9" : undefined, PrivateIpAddress: "10.0.1.5",
  IamInstanceProfile: extra.profile ? { Arn: `arn:aws:iam::123456789012:instance-profile/${String(extra.profile)}` } : undefined,
  KeyName: "ops-key-prod", ImageId: "ami-0abc", UserData: "SHOULD-NEVER-BE-READ",
  Tags: [{ Key: "Name", Value: name }, { Key: "DB_PASSWORD", Value: SECRET_TAG }, { Key: "Owner", Value: "team-x" }, ...((extra.tags as unknown[]) ?? [])],
});
const SGS = [
  { GroupId: "sg-web", IpPermissions: [
    { IpProtocol: "tcp", FromPort: 80, ToPort: 80, IpRanges: [{ CidrIp: "0.0.0.0/0" }], UserIdGroupPairs: [] },
    { IpProtocol: "tcp", FromPort: 443, ToPort: 443, IpRanges: [{ CidrIp: "0.0.0.0/0" }], UserIdGroupPairs: [] },
    { IpProtocol: "tcp", FromPort: 22, ToPort: 22, IpRanges: [{ CidrIp: "10.0.0.0/8" }], UserIdGroupPairs: [] }] },
  { GroupId: "sg-api", IpPermissions: [
    { IpProtocol: "tcp", FromPort: 8080, ToPort: 8080, IpRanges: [], UserIdGroupPairs: [{ GroupId: "sg-web" }] },
    { IpProtocol: "tcp", FromPort: 22, ToPort: 22, IpRanges: [{ CidrIp: "10.0.0.0/8" }], UserIdGroupPairs: [] }] },
];
const TYPES = [{ InstanceType: "t3.medium", VCpuInfo: { DefaultVCpus: 2 }, MemoryInfo: { SizeInMiB: 4096 } }, { InstanceType: "m5.large", VCpuInfo: { DefaultVCpus: 2 }, MemoryInfo: { SizeInMiB: 8192 } }];

function awsExec(opts: { instances?: unknown[]; deny?: boolean; eks?: string[] } = {}) {
  const calls: Call[] = [];
  const exec = async (bin: string, args: string[]) => {
    calls.push(`${bin} ${args.join(" ")}`);
    const ok = (o: unknown) => ({ code: 0, stdout: JSON.stringify(o), stderr: "", ms: 1 });
    const k = args.slice(0, 2).join(" ");
    if (k === "sts get-caller-identity") return ok({ Account: "123456789012" });
    if (k === "eks list-clusters") return ok({ clusters: opts.eks ?? [] });
    if (k === "ecs list-clusters") return ok({ clusterArns: [] });
    if (k === "ec2 describe-instances") return opts.deny ? { code: 254, stdout: "", stderr: "An error occurred (UnauthorizedOperation) when calling the DescribeInstances operation: not authorized", ms: 1 }
      : ok({ Reservations: [{ Instances: opts.instances ?? [] }] });
    if (k === "ec2 describe-security-groups") return ok({ SecurityGroups: SGS });
    if (k === "ec2 describe-instance-types") return ok({ InstanceTypes: TYPES });
    if (k === "rds describe-db-instances") return ok({ DBInstances: [] });
    return ok({});   // vpcs·alb·ecr·secrets·s3·sqs·elasticache 등: 빈 목록
  };
  return { exec, calls };
}
const FIX2 = () => [inst("i-web", "shop-web-1", "t3.medium", ["sg-web"], { pub: true, profile: "shop-web-role" }), inst("i-api", "shop-api-1", "m5.large", ["sg-api"], { profile: "shop-api-role" })];
const importAws = async (opts: Parameters<typeof awsExec>[0] = {}, env: Record<string, string> = {}) => {
  const { exec, calls } = awsExec({ instances: FIX2(), ...opts });
  const inv = await discoverAws({ exec: exec as never, env: { AWS_REGION: "ap-northeast-2", ...env } }, {});
  return { inv, calls, out: normalizeV2(inv) };
};

test("정상: EC2 2묶음 → IR v2 (origin vm/ec2, 이미지 빌드 자리, 크기→요청량, 포트·replicas, 접속 포트 제외), 스키마·checkV2 통과 + 승인 줄 build 만", async () => {
  const { inv, out } = await importAws();
  assert.deepEqual(out.result.unmapped, []);
  const spec = AppSpecV2.parse(out.result.spec);
  const web = spec.components.find((c) => c.id === "shop-web")!, api = spec.components.find((c) => c.id === "shop-api")!;
  assert.ok(web && api && web.kind === "service" && api.kind === "service");
  if (web.kind !== "service" || api.kind !== "service") return;
  assert.deepEqual(web.props.origin, { runtime: "vm", product: "ec2" });
  assert.equal(web.props.runtime, "vm");
  assert.equal(web.props.image.source, "build");
  assert.equal(web.props.image.digest, null);
  assert.match(web.props.image.build!.repo, /^TODO\(human\)/);
  assert.deepEqual(web.props.resources.request, { cpuMilli: 2000, memMiB: 4096 });
  assert.deepEqual(api.props.resources.request, { cpuMilli: 2000, memMiB: 8192 });
  assert.deepEqual(web.props.ports!.map((p) => p.port), [80, 443], "22(접속) 제외");
  assert.deepEqual(api.props.ports!.map((p) => p.port), [8080]);
  assert.equal(web.props.serviceAccount, "shop-web-role");
  assert.deepEqual(web.props.replicas, { min: 1, max: 1 });
  // 메타: 이미지·크기·환경변수는 검토 표시
  for (const k of ["image", "resources", "env"]) assert.equal(out.result.fieldMeta[`components.shop-web.${k}`]?.needs_review, true, k);
  // 보안 기준선: 웹은 공개, api 는 web 보안 그룹에서만
  const net = spec.posture.network.filter((n) => n.scope === "component");
  const w = net.find((n) => n.scope === "component" && n.subject === "shop-web")!, a = net.find((n) => n.scope === "component" && n.subject === "shop-api")!;
  assert.ok(w.scope === "component" && w.public === true && a.scope === "component" && a.public === false);
  assert.deepEqual(a.scope === "component" && a.ingress, [{ from: "sg:sg-web", port: 8080 }]);
  // 검증: 구조 오류 0, 승인 줄 = 빌드만 (RUNTIMEMAP v2: VM 출발은 VM 도착이 기본이라 runtime_change 없음)
  const chk = checkV2(spec);
  assert.deepEqual(chk.errors ?? [], []);
  const kinds = (chk.approvals ?? []).map((x: { kind: string; subject: string }) => `${x.kind}:${x.subject}`).sort();
  assert.deepEqual(kinds, ["build:shop-api", "build:shop-web"]);
  assert.ok(inv.coverage["vm.group"] === 2);
});

test("묶음: Name 끝 번호를 뗀 같은 이름은 한 서비스 (replicas = 수), 크기가 섞이면 큰 쪽 기준 + 검토", async () => {
  const insts = [inst("i-1", "shop-web-1", "t3.medium", ["sg-web"]), inst("i-2", "shop-web-2", "m5.large", ["sg-web"]), inst("i-3", "shop-api-01", "t3.medium", ["sg-api"])];
  const { out } = await importAws({ instances: insts });
  const web = out.result.spec.components.find((c) => c.id === "shop-web")!;
  assert.equal(out.result.spec.components.length, 2);
  assert.ok(web.kind === "service" && web.props.replicas.min === 2 && web.props.replicas.max === 2);
  assert.ok(web.kind === "service" && web.props.resources.request!.memMiB === 8192);
  assert.match(out.result.fieldMeta["components.shop-web.resources"]!.rationale ?? "", /섞여/);
  assert.equal(groupNameOf("shop-web-12", false), "shop-web");
  assert.equal(groupNameOf("blue", true), "blue");
});

test("거부(비밀 태그): 태그·UserData·키 이름·IP 는 원본·명세·감사 사본 어디에도 없고, 비밀처럼 보이는 Name 은 인스턴스 id 로 대신", async () => {
  const insts = [inst("i-web", "shop-web-1", "t3.medium", ["sg-web"], { pub: true }), inst("i-sec", SECRET_NAME, "t3.medium", ["sg-api"])];
  const { inv, calls, out } = await importAws({ instances: insts });
  const all = JSON.stringify([inv, out.result]);
  for (const s of [SECRET_TAG, "SHOULD-NEVER-BE-READ", "ops-key-prod", "203.0.113.9", "10.0.1.5", "team-x", SECRET_NAME, "123456789012"]) assert.ok(!all.includes(s), `새는 값: ${s}`);
  assert.ok(out.result.spec.components.some((c) => c.id === "i-sec"), "비밀 모양 Name 은 인스턴스 id 로");
  assert.ok(inv.items.some((i) => (i as { kind: string }).kind === "import.note" && /태그 \d+개는 가져오지 않음/.test(String((i as { text?: string }).text))));
  // user-data 를 읽는 명령은 부르지 않고, 모든 aws 호출이 읽기 동사
  const aws = calls.filter((c) => c.startsWith("aws "));
  assert.ok(!aws.some((c) => /describe-instance-attribute|get-console-output|get-password-data/.test(c)));
  assert.ok(aws.every((c) => /^aws (sts get-caller-identity|[a-z0-9-]+ (describe|list|get)-)/.test(c)), aws.find((c) => !/ (describe|list|get)-/.test(c)));
  assert.ok(secretLooking("password-prod") && secretLooking(SECRET_NAME) && !secretLooking("shop-web"));
});

test("거부(쓰기 권한): 관찰 역할 요청에 EC2 쓰기·와일드카드를 섞으면 거부, 읽기 3개만이면 통과, 권한 표·v2 요청 목록에 들어 있음", async () => {
  const req = (actions: string[]) => ({ envId: "e", purpose: "observe" as const, provider: "aws" as const, actions } as never);
  assert.doesNotThrow(() => checkLeastPrivilege(req(EC2_OBSERVE_ACTIONS)));
  assert.doesNotThrow(() => checkLeastPrivilege({ envId: "e", purpose: "observe", provider: "gcp", actions: GCE_OBSERVE_PERMISSIONS } as never));
  for (const bad of ["ec2:RunInstances", "ec2:TerminateInstances", "ec2:ModifyInstanceAttribute", "ec2:*", "ec2:DescribeInstanceAttribute*"])
    assert.throws(() => checkLeastPrivilege(req([...EC2_OBSERVE_ACTIONS, bad])), /ROLE_|쓰기|와일드카드/, bad);
  assert.deepEqual(actionsOfCommands("aws", ["ec2 describe-instances", "ec2 describe-instance-types"]), ["ec2:DescribeInstances", "ec2:DescribeInstanceTypes"]);
  assert.deepEqual(actionsOfCommands("gcp", ["compute instances list"]), ["compute.instances.list"]);
  const { importObserveActions } = await import("../../../apps/worker/src/jobs/import.js");
  assert.ok(EC2_OBSERVE_ACTIONS.every((a) => importObserveActions("aws").includes(a)));
  assert.ok(importObserveActions("gcp").includes("compute.instances.list"));
  assert.doesNotThrow(() => checkLeastPrivilege(req(importObserveActions("aws"))));
});

test("권한 없음·VM 없음: EC2 읽기가 거부되면 멈추지 않고 이유를 들고 SOURCE_INCOMPLETE, EKS 가 있으면 VM 은 읽지 않음(호출 수 안 늘림)", async () => {
  const d = awsExec({ deny: true });
  await assert.rejects(() => discoverAws({ exec: d.exec as never, env: { AWS_REGION: "ap-northeast-2" } }, {}), (e: unknown) => /SOURCE_INCOMPLETE|VM 도 없음/.test(String((e as Error).message) + String((e as { code?: string }).code)) && /UnauthorizedOperation|못 읽음/.test((e as Error).message));
  const eks = awsExec({ eks: ["prod"], instances: FIX2() });
  await discoverAws({ exec: eks.exec as never, env: { AWS_REGION: "ap-northeast-2" } }, {}).catch(() => undefined);
  assert.ok(!eks.calls.some((c) => c.includes("ec2 describe-instances")), "EKS 가 있는데 VM 을 읽음");
  // 명시(IMPORT_VM=1·태그)면 EKS 가 있어도 읽고, 태그는 필터로 넘어감
  const ex = awsExec({ eks: ["prod"], instances: FIX2() });
  await discoverAws({ exec: ex.exec as never, env: { AWS_REGION: "ap-northeast-2", IMPORT_AWS_VM_TAG: "app=shop" } }, {}).catch(() => undefined);
  assert.ok(ex.calls.some((c) => c.includes("ec2 describe-instances") && c.includes("Name=tag:app,Values=shop")), ex.calls.filter((c) => c.includes("ec2")).join("\n"));
});

test("GCP: GCE 2묶음 → origin vm/gce, 머신 크기·방화벽·태그 매칭, 기본 계산 서비스 계정은 default, 프로젝트 번호·IP·라벨 값 없음", async () => {
  const calls: string[] = [];
  const gi = (name: string, mt: string, tags: string[], pub: boolean) => ({ name, status: "RUNNING", zone: "https://www.googleapis.com/compute/v1/projects/p/zones/asia-northeast3-a",
    machineType: `https://www.googleapis.com/compute/v1/projects/p/zones/asia-northeast3-a/machineTypes/${mt}`, tags: { items: tags }, labels: { owner: "team-x", secret: "label-secret-value" },
    metadata: { items: [{ key: "startup-script", value: "export TOKEN=meta-secret-1" }] },
    networkInterfaces: [{ networkIP: "10.1.0.4", accessConfigs: pub ? [{ natIP: "198.51.100.7" }] : [] }],
    serviceAccounts: [{ email: name.includes("web") ? "123456789012-compute@developer.gserviceaccount.com" : "shop-api@p.iam.gserviceaccount.com" }] });
  const exec = async (bin: string, args: string[]) => {
    calls.push(`${bin} ${args.join(" ")}`);
    const ok = (o: unknown) => ({ code: 0, stdout: JSON.stringify(o), stderr: "", ms: 1 });
    const k = args.slice(0, 3).join(" ");
    if (k === "compute instances list") return ok([gi("shop-web-1", "e2-standard-4", ["web"], true), gi("shop-api-1", "custom-2-4096", ["api"], false)]);
    if (k === "compute firewall-rules list") return ok([
      { name: "allow-web", direction: "INGRESS", allowed: [{ IPProtocol: "tcp", ports: ["80", "443"] }], sourceRanges: ["0.0.0.0/0"], targetTags: ["web"] },
      { name: "allow-api", direction: "INGRESS", allowed: [{ IPProtocol: "tcp", ports: ["8080"] }], sourceTags: ["web"], targetTags: ["api"] },
      { name: "allow-ssh", direction: "INGRESS", allowed: [{ IPProtocol: "tcp", ports: ["22"] }], sourceRanges: ["35.235.240.0/20"] },
      { name: "off", direction: "INGRESS", disabled: true, allowed: [{ IPProtocol: "tcp", ports: ["9999"] }], sourceRanges: ["0.0.0.0/0"], targetTags: ["web"] }]);
    return ok([]);
  };
  const inv = await discoverGcp({ exec: exec as never, env: { GCP_PROJECT: "cust-prj" } }, {});
  const out = normalizeV2(inv);
  assert.deepEqual(out.result.unmapped, []);
  const web = out.result.spec.components.find((c) => c.id === "shop-web")!, api = out.result.spec.components.find((c) => c.id === "shop-api")!;
  assert.ok(web.kind === "service" && api.kind === "service");
  if (web.kind !== "service" || api.kind !== "service") return;
  assert.deepEqual(web.props.origin, { runtime: "vm", product: "gce" });
  assert.deepEqual(web.props.resources.request, { cpuMilli: 4000, memMiB: 16384 });
  assert.deepEqual(api.props.resources.request, { cpuMilli: 2000, memMiB: 4096 });
  assert.deepEqual(web.props.ports!.map((p) => p.port), [80, 443], "비활성 규칙(9999)·접속 포트(22) 제외");
  assert.deepEqual(api.props.ports!.map((p) => p.port), [8080]);
  assert.equal(web.props.serviceAccount, "default");
  assert.equal(api.props.serviceAccount, "shop-api");
  const all = JSON.stringify([inv, out.result]);
  for (const s of ["label-secret-value", "meta-secret-1", "198.51.100.7", "10.1.0.4", "123456789012", "team-x"]) assert.ok(!all.includes(s), `새는 값: ${s}`);
  assert.ok(calls.filter((c) => c.startsWith("gcloud compute")).every((c) => /compute (instances|firewall-rules|networks|forwarding-rules|routers|addresses) list/.test(c)));   // E-1: Cloud NAT 나가는 IP 읽기
  AppSpecV2.parse(out.result.spec);
});

test("결정적: 인스턴스 순서·보안 그룹 규칙 순서를 뒤집어도 같은 명세 (글자까지)", async () => {
  const a = await importAws({ instances: FIX2() });
  const b = await importAws({ instances: [...FIX2()].reverse() });
  assert.equal(JSON.stringify(a.out.result), JSON.stringify(b.out.result));
});

test("순수 조각: 포트 펼치기(접속 포트·넓은 범위), GCE 머신 크기 표", () => {
  const r = (a: number, b: number, src = ["0.0.0.0/0"]) => ({ protocol: "tcp" as const, fromPort: a, toPort: b, sources: src });
  assert.deepEqual(appPorts([r(22, 22), r(8000, 8002)]).ports.map((p) => p.port), [8000, 8001, 8002]);
  assert.deepEqual(appPorts([r(0, 65535)]), { ports: [], wide: true, adminOnly: false });
  assert.deepEqual(appPorts([r(22, 22), r(3389, 3389)]), { ports: [], wide: false, adminOnly: true });
  assert.deepEqual(gceSize("e2-standard-4"), { cpuMilli: 4000, memMiB: 16384 });
  assert.deepEqual(gceSize("n2-highmem-8"), { cpuMilli: 8000, memMiB: 65536 });
  assert.deepEqual(gceSize("n2-custom-6-12288"), { cpuMilli: 6000, memMiB: 12288 });
  assert.deepEqual(gceSize("e2-medium"), { cpuMilli: 2000, memMiB: 4096 });
  assert.equal(gceSize("z9-mystery-1"), null);
});
