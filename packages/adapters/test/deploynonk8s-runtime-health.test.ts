// DEPLOYNONK8S: Terraform 이 앱까지 띄우는 도착(ECS·Cloud Run·VM)의 배포 확인 (checkTerraformRuntime) + 흉내 출력 자리값. 가짜 CLI, 실클라우드 0
import { test } from "node:test";
import assert from "node:assert/strict";
import { AppSpecV2, type TfOutputs } from "@svc/contracts";
import { checkTerraformRuntime, DEMO_INVENTORY_V2, normalizeV2, stubTfOutputsV2, targetBuilderFor, terraformRuntimeOf, flattenTfOutputsV2, type Exec } from "../src/index.js";

type Raw = Record<string, any>;
const T = { envId: "33333333-3333-4333-8333-333333333333", region: "default", tenantId: "11111111-1111-4111-8111-111111111111", migrationId: "22222222-2222-4222-8222-222222222222" };
const ecs = () => normalizeV2(DEMO_INVENTORY_V2.aws!).result.spec as AppSpecV2;
const k8s = () => normalizeV2(DEMO_INVENTORY_V2.gcp!).result.spec as AppSpecV2;
function vm(): AppSpecV2 {
  const o: Raw = structuredClone(ecs());
  for (const c of o.components) if (c.kind === "service") { c.props.origin = { runtime: "vm", product: "ec2" }; c.props.runtime = "vm"; }
  o.components = o.components.filter((c: Raw) => c.id !== "shop-web");
  o.links = o.links.filter((l: Raw) => l.from !== "shop-web" && l.to !== "shop-web");
  o.entry.hosts[0].routes = o.entry.hosts[0].routes.filter((r: Raw) => r.backends.every((b: Raw) => b.to !== "shop-web"));
  return AppSpecV2.parse(o);
}
/** 가짜 CLI: 부른 줄을 모으고, 순서대로 답한다 (마지막 답은 반복) */
function fake(replies: Array<{ code?: number; out?: unknown; err?: string }>) {
  const calls: string[] = [];
  const exec: Exec = async (cmd, args) => {
    calls.push(`${cmd} ${args.join(" ")}`);
    const r = replies[Math.min(calls.length - 1, replies.length - 1)]!;
    return { code: r.code ?? 0, stdout: JSON.stringify(r.out ?? null), stderr: r.err ?? "", ms: 1 };
  };
  return { calls, deps: { exec, attempts: 3, sleep: async () => {} } };
}
const outs = (s: AppSpecV2): TfOutputs => stubTfOutputsV2(s);

test("실행 방식 판별: ECS·Cloud Run = managedContainer, VM = vm, k8s·명세 없음 = null (지금 gitops 길)", () => {
  assert.equal(terraformRuntimeOf(ecs()), "managedContainer");
  assert.equal(terraformRuntimeOf(vm()), "vm");
  assert.equal(terraformRuntimeOf(k8s()), null);
  assert.equal(terraformRuntimeOf(null), null);
});

test("출력만(흉내 길): CLI 안 부르고 출력의 서비스 이름·인스턴스 목록이 resources / 빠지면 RUNTIME_OUTPUT_MISSING (어느 키인지)", async () => {
  const f = fake([{}]);
  const a = await checkTerraformRuntime({ provider: "gcp", runtime: "managedContainer", spec: ecs(), tfOutputs: outs(ecs()), live: false }, f.deps);
  assert.deepEqual(a, { ok: true, resources: ["CloudRunService/shop-api/stub-shop-api", "CloudRunService/shop-web/stub-shop-web", "CloudRunService/shop-worker/stub-shop-worker"], checked: "outputs", attempts: 0 });
  assert.equal(f.calls.length, 0);
  const v = await checkTerraformRuntime({ provider: "gcp", runtime: "vm", spec: vm(), tfOutputs: outs(vm()), live: false });
  assert.deepEqual(v.resources, ["GceInstance/shop-api/stub-shop-api-1", "GceInstance/shop-api/stub-shop-api-2", "GceInstance/shop-worker/stub-shop-worker-1"]);
  // 루트 출력 맵(service_names)만 있어도 된다 (펼친 키가 없을 때)
  const only = { service_names: JSON.stringify({ "shop-api": "a", "shop-web": "w", "shop-worker": "k" }) };
  assert.equal((await checkTerraformRuntime({ provider: "aws", runtime: "managedContainer", spec: ecs(), tfOutputs: only, live: false })).ok, true);
  const miss = await checkTerraformRuntime({ provider: "aws", runtime: "vm", spec: vm(), tfOutputs: { vm_instance_ids: JSON.stringify({ "shop-api": ["i-1"] }) }, live: false });
  assert.deepEqual(miss.ok ? null : [miss.code, miss.reason], ["RUNTIME_OUTPUT_MISSING", "apply 출력에 없음: vm_instance_ids.shop-worker"]);
  // 진짜 길 ECS 는 클러스터 이름도 필요
  const noCluster = { ...outs(ecs()) }; delete noCluster.ecs_cluster_name;
  const r = await checkTerraformRuntime({ provider: "aws", runtime: "managedContainer", spec: ecs(), tfOutputs: noCluster, live: true }, f.deps);
  assert.equal(r.ok ? "" : r.code, "RUNTIME_OUTPUT_MISSING");
  assert.equal(f.calls.length, 0);
});

test("진짜 길 Cloud Run: Ready=True 면 통과 / 뜨는 중이면 다시 보고 3번째에 통과 / 끝까지 False 면 RUNTIME_UNHEALTHY(이유 포함), 읽기 명령만", async () => {
  const ready = (s: string, reason?: string) => ({ out: { status: { conditions: [{ type: "Ready", status: s, ...(reason ? { reason } : {}) }] } } });
  const ok = fake([ready("True")]);
  const a = await checkTerraformRuntime({ provider: "gcp", runtime: "managedContainer", spec: ecs(), tfOutputs: outs(ecs()), live: true, projectId: "demo-project" }, ok.deps);
  assert.ok(a.ok && a.checked === "live" && a.attempts === 1);
  assert.deepEqual(ok.calls, ["shop-api", "shop-web", "shop-worker"].map((n) =>
    `gcloud run services describe stub-${n} --region asia-northeast3 --project demo-project --format json`));
  const later = fake([ready("Unknown"), ready("Unknown"), ready("True")]);
  const b = await checkTerraformRuntime({ provider: "gcp", runtime: "managedContainer", spec: ecs(), tfOutputs: outs(ecs()), live: true }, { ...later.deps, attempts: 5 });
  assert.ok(b.ok && b.attempts === 2, JSON.stringify(b));   // 한 번 보기 = 서비스 3개, 1회차에 앞 둘이 Unknown
  const sick = fake([ready("False", "ContainerMissing")]);
  const c = await checkTerraformRuntime({ provider: "gcp", runtime: "managedContainer", spec: ecs(), tfOutputs: outs(ecs()), live: true }, sick.deps);
  assert.ok(!c.ok && c.code === "RUNTIME_UNHEALTHY" && c.attempts === 3 && /ContainerMissing/.test(c.reason), JSON.stringify(c));
  assert.ok([...ok.calls, ...later.calls, ...sick.calls].every((x) => / describe /.test(x)), "읽기 아닌 명령");
});

test("진짜 길 VM: EC2 running·GCE RUNNING 이면 통과, 하나라도 아니면 그 인스턴스가 이유에 / CLI 실패는 RUNTIME_CHECK_FAILED 이고 계정 번호는 가림", async () => {
  const ids = outs(vm());
  const ec2 = fake([{ out: { InstanceStatuses: ["stub-shop-api-1", "stub-shop-api-2", "stub-shop-worker-1"].map((id) => ({ InstanceId: id, InstanceState: { Name: "running" } })) } }]);
  const a = await checkTerraformRuntime({ provider: "aws", runtime: "vm", spec: vm(), tfOutputs: ids, live: true }, ec2.deps);
  assert.ok(a.ok);
  assert.equal(ec2.calls[0], "aws ec2 describe-instance-status --instance-ids stub-shop-api-1 stub-shop-api-2 stub-shop-worker-1 --include-all-instances --region ap-northeast-2 --output json");
  const gce = fake([{ out: [{ name: "stub-shop-api-1", status: "RUNNING" }, { name: "stub-shop-api-2", status: "STAGING" }, { name: "stub-shop-worker-1", status: "RUNNING" }] }]);
  const b = await checkTerraformRuntime({ provider: "gcp", runtime: "vm", spec: vm(), tfOutputs: ids, live: true }, gce.deps);
  assert.ok(!b.ok && b.code === "RUNTIME_UNHEALTHY" && /stub-shop-api-2: STAGING/.test(b.reason) && !/stub-shop-api-1:/.test(b.reason), JSON.stringify(b));
  const denied = fake([{ code: 254, err: "UnauthorizedOperation arn:aws:iam::123456789012:role/exec" }]);
  const c = await checkTerraformRuntime({ provider: "aws", runtime: "vm", spec: vm(), tfOutputs: ids, live: true }, denied.deps);
  assert.ok(!c.ok && c.code === "RUNTIME_CHECK_FAILED" && c.attempts === 1, JSON.stringify(c));
  assert.ok(!c.ok && !c.reason.includes("123456789012") && c.reason.includes("••••9012"), !c.ok ? c.reason : "");
});

test("흉내 출력: ECS·VM 명세는 service.<id>.name·vm.<id>.machine·인스턴스 목록이 생겨 화면 값에 자리표시가 없음, k8s 명세의 흉내 출력은 그대로(키 추가 0)", () => {
  const at = (p: "aws" | "gcp") => ({ ...T, provider: p }) as never;
  const vv: Raw = targetBuilderFor("aws").toWorkloadValues(vm(), flattenTfOutputsV2(outs(vm())), at("aws"));
  assert.ok(vv.vm.every((x: Raw) => x.machine === "stub-machine"), JSON.stringify(vv.vm));
  const ev = JSON.stringify(targetBuilderFor("gcp").toWorkloadValues(ecs(), flattenTfOutputsV2(outs(ecs())), at("gcp")));
  assert.ok(!/<tf-output:service\./.test(ev), ev.slice(0, 300));
  const k = Object.keys(stubTfOutputsV2(k8s()));
  assert.ok(!k.some((x) => /^(service\.|vm\.|service_names|vm_|ecs_cluster_name)/.test(x)), k.join());
  assert.equal(JSON.stringify(stubTfOutputsV2(vm())), JSON.stringify(stubTfOutputsV2(vm())), "결정적");
});
