// RUNTIMEMAP (N8): 도착 실행 방식 = 출발과 같은 종류. 출발 k8s → 도착 k8s(EKS·GKE·k3s, 같은 Helm 차트), 출발 ECS·Cloud Run(관리형 컨테이너) → 도착 ECS(aws)·Cloud Run(gcp).
//   사람이 runtime 을 바꾼 경우(runtime_change 승인)만 다른 종류 허용. 출발 VM 은 같은 종류의 도착이 없어 지금 k8s 로 감 (DRAFT, TODO(human))
import { test } from "node:test";
import assert from "node:assert/strict";
import { AppSpecV2, checkV2, type Provider } from "@svc/contracts";
import { applySpecV2Patch } from "@svc/core";
import { AdapterError, DEMO_INVENTORY_V2, managedBlockers, normalizeV2, targetBuilderFor, UNSUPPORTED_V2, v2Blockers } from "../src/index.js";

const T = { envId: "33333333-3333-4333-8333-333333333333", region: "default", tenantId: "11111111-1111-4111-8111-111111111111", migrationId: "22222222-2222-4222-8222-222222222222" };
const at = (p: Provider) => ({ ...T, provider: p }) as never;
type Raw = Record<string, any>;
const spec = (k: "aws" | "gcp" | "onprem") => normalizeV2(DEMO_INVENTORY_V2[k]!).result.spec as AppSpecV2;
const K8S = () => spec("gcp");          // 출발 k8s (GKE) — 서비스·잡
const ECS = () => spec("aws");          // 출발 ECS — 서비스 3개
function withOrigin(s: AppSpecV2, runtime: string, product: string): AppSpecV2 {
  const o: Raw = structuredClone(s);
  for (const c of o.components) if (c.kind === "service") c.props.origin = { runtime, product };
  return AppSpecV2.parse(o);
}
const CLOUDRUN = () => withOrigin(ECS(), "managedContainer", "cloudRun");   // 관리형 컨테이너 출발 = ECS 와 같은 종류
function withRuntime(s: AppSpecV2, runtime: "k8s" | "managedContainer", only?: string[]): AppSpecV2 {
  const o: Raw = structuredClone(s);
  for (const c of o.components) if (c.kind === "service" && (!only || only.includes(c.id))) c.props.runtime = runtime;
  return AppSpecV2.parse(o);
}
const unsupported = (s: AppSpecV2, p: Provider) => v2Blockers(s, targetBuilderFor(p).capabilities()).unsupported;
const tf = (s: AppSpecV2, p: Provider) => targetBuilderFor(p).toTerraformV2(s, at(p));
const isManaged = (s: AppSpecV2, p: Provider) => "service_json" in tf(s, p).vars;
const refuses = (s: AppSpecV2, p: Provider) => assert.throws(() => tf(s, p), (e: unknown) => e instanceof AdapterError && e.code === UNSUPPORTED_V2, p);
const classChange = (s: AppSpecV2) => checkV2(s).approvals.filter((a) => a.kind === "runtime_change");

// ── 가져오기가 만든 명세는 출발과 같은 종류 (사람이 안 건드리면 승인 줄 0) ──
test("가져오기 결과의 도착 실행 방식 = 출발 종류: k8s→k8s, ECS→managedContainer, 승인 줄(runtime_change) 0", () => {
  for (const s of [K8S(), spec("onprem")]) {
    for (const c of s.components) if (c.kind === "service") assert.equal(c.props.runtime, "k8s"), assert.equal(c.props.origin.runtime, "k8s");
    assert.deepEqual(classChange(s), []);
  }
  for (const c of ECS().components) if (c.kind === "service") assert.deepEqual([c.props.runtime, c.props.origin.runtime, c.props.origin.product], ["managedContainer", "managedContainer", "ecs"]);
  assert.deepEqual(classChange(ECS()), []);
});

// ── 출발 k8s → 도착 k8s (EKS·GKE·k3s, 같은 Helm 차트). 관리형으로는 안 감 ──
test("출발 k8s → aws(EKS)·gcp(GKE)·onprem(k3s)·azure_mock: 막힘 0, Terraform 은 서비스(ECS·Cloud Run) 없이 신원·네임스페이스, 값은 Helm 워크로드", () => {
  for (const p of ["aws", "gcp", "onprem", "azure_mock"] as const) {
    const s = K8S();
    assert.deepEqual(unsupported(s, p), [], p);
    if (p === "azure_mock") continue;   // azure_mock 은 신원 1개 제한(azureShapeBlockers, 실행 방식과 별개)이라 Builder 렌더는 건너뜀
    assert.equal(isManaged(s, p), false, `${p}: k8s 출발이 관리형으로 감`);
    const v: Raw = targetBuilderFor(p).toWorkloadValues(s, {}, at(p));
    assert.ok(v.workloads.length > 0 && v.managed === undefined, `${p}: Helm 워크로드로 가야 함`);
  }
});

// ── 출발 ECS → 도착 ECS(aws)·Cloud Run(gcp), onprem·azure 는 거부 ──
test("출발 ECS → aws 는 ECS 서비스, gcp 는 Cloud Run 서비스 (k8s 신원·네임스페이스 없음, Helm 워크로드 없음)", () => {
  const a = tf(ECS(), "aws"), g = tf(ECS(), "gcp");
  assert.deepEqual([...new Set(a.instances.filter((i) => i.kind === "service").map((i) => i.module))], ["aws/kinds/service-ecs"]);
  assert.deepEqual([...new Set(g.instances.filter((i) => i.kind === "service").map((i) => i.module))], ["gcp/kinds/service-cloudrun"]);
  for (const v of [a.vars, g.vars]) { assert.equal(v.identity_json, "[]"); assert.equal(v.namespace_json, "[]"); }
  for (const p of ["aws", "gcp"] as const) assert.deepEqual((targetBuilderFor(p).toWorkloadValues(ECS(), {}, at(p)) as Raw).workloads, [], p);
});
test("출발 ECS → onprem(k3s)·azure_mock 거부: 이유에 runtime.managedContainer 와 '런타임을 k8s 로 바꾸면' 안내, Builder 도 던짐", () => {
  for (const p of ["onprem", "azure_mock"] as const) {
    const u = unsupported(ECS(), p);
    assert.ok(u.some((m) => /runtime\.managedContainer/.test(m) && /runtime 을 k8s 로 바꾸면/.test(m)), `${p}: ${u.join()}`);
    refuses(ECS(), p);
  }
});

// ── 출발 Cloud Run (관리형 컨테이너) → gcp Cloud Run, aws ECS. onprem 거부 ──
test("출발 Cloud Run → gcp 는 Cloud Run, aws 는 ECS (같은 종류), onprem 은 거부", () => {
  assert.deepEqual([unsupported(CLOUDRUN(), "gcp"), unsupported(CLOUDRUN(), "aws")], [[], []]);
  assert.equal(isManaged(CLOUDRUN(), "gcp"), true); assert.equal(isManaged(CLOUDRUN(), "aws"), true);
  assert.ok(tf(CLOUDRUN(), "gcp").instances.some((i) => i.module === "gcp/kinds/service-cloudrun"));
  assert.ok(tf(CLOUDRUN(), "aws").instances.some((i) => i.module === "aws/kinds/service-ecs"));
  assert.ok(unsupported(CLOUDRUN(), "onprem").length > 0); refuses(CLOUDRUN(), "onprem");
});

// ── 사람이 runtime 을 바꾼 경우만 다른 종류 허용 (runtime_change 승인) ──
test("사람이 ECS 서비스의 runtime 을 k8s 로 바꾸면: 승인 줄 runtime_change(managedContainer→k8s) 생기고 aws(EKS)·gcp·onprem 으로 감", () => {
  const s = withRuntime(ECS(), "k8s");
  const ch = classChange(s);
  assert.deepEqual(ch.map((a) => [a.from, a.to]), Array(3).fill(["managedContainer", "k8s"]));
  assert.deepEqual(ch.map((a) => a.subject).sort(), ["shop-api", "shop-web", "shop-worker"]);
  for (const p of ["aws", "gcp", "onprem"] as const) { assert.deepEqual(unsupported(s, p), [], p); assert.equal(isManaged(s, p), false, p); }
});
test("사람이 k8s 서비스의 runtime 을 managedContainer 로 바꾸면: 승인 줄이 생기고, 잡은 관리형 예약 잡으로 같이 감(JOBBUILD, 섞임 아님), onprem 거부", () => {
  const s = withRuntime(K8S(), "managedContainer");
  assert.ok(classChange(s).every((a) => a.from === "k8s" && a.to === "managedContainer") && classChange(s).length > 0);
  assert.ok(unsupported(s, "onprem").length > 0);
  // 데모 k8s 명세의 CronJob: JOBBUILD 뒤로는 관리형 서비스 옆의 잡 = ECS 예약 태스크 / Cloud Run job → "섞음" 으로 막지 않는다
  assert.ok(!managedBlockers(s).some((m) => /섞음/.test(m)), managedBlockers(s).join("; "));
  for (const p of ["aws", "gcp"] as const) assert.ok(!unsupported(s, p).some((m) => /섞음/.test(m)), p);
});
test("한 명세에서 일부 서비스만 종류를 바꾸면 섞임으로 거부 (관리형 + k8s)", () => {
  const s = withRuntime(ECS(), "k8s", ["shop-worker"]);
  for (const p of ["aws", "gcp"] as const) { assert.ok(unsupported(s, p).some((m) => /섞음/.test(m)), p); refuses(s, p); }
});

// ── 우회 막기: origin 은 사람이 못 고친다 (고칠 수 있으면 runtime 을 바꾼 뒤 origin 도 맞춰 승인 줄을 지울 수 있음) ──
test("PATCH: runtime 은 바꿀 수 있고(승인 줄이 따라옴) origin 은 거부 (SPEC_PATCH_INVALID)", () => {
  const r = normalizeV2(DEMO_INVENTORY_V2.aws!).result;
  const base = { spec: r.spec, fieldMeta: r.fieldMeta as never };
  const ok = applySpecV2Patch(base, { changes: [{ path: "components.shop-api.runtime", value: "k8s" }] });
  assert.deepEqual(checkV2(AppSpecV2.parse(ok.spec)).approvals.filter((a) => a.kind === "runtime_change").map((a) => a.subject), ["shop-api"]);
  assert.throws(() => applySpecV2Patch(base, { changes: [{ path: "components.shop-api.origin", value: { runtime: "k8s", product: "k8s" } }] }),
    (e: unknown) => (e as { code?: string; status?: number }).code === "SPEC_PATCH_INVALID" && /origin/.test((e as Error).message));
});

// ── 출발 VM: 같은 종류의 도착 런타임이 없다 → 지금 k8s (DRAFT(ai)), 기본값은 TODO(human) ──
test("출발 VM: 가져오기는 runtime=k8s 로 두고 승인 줄 runtime_change(vm→k8s)를 냄. 선택지 둘 다 막힘 없이 그려짐: k8s(aws·gcp·onprem), managedContainer(aws·gcp, onprem 거부)", () => {
  const vm = withOrigin(K8S(), "vm", "ec2");
  assert.ok(classChange(vm).length > 0 && classChange(vm).every((a) => a.from === "vm" && a.to === "k8s"));
  for (const p of ["aws", "gcp", "onprem"] as const) { assert.deepEqual(unsupported(vm, p), [], p); assert.equal(isManaged(vm, p), false, p); }
  // 선택지 2: 관리형 컨테이너 (잡이 없는 서비스만 있는 VM 앱이라고 가정 — ECS 데모 명세를 VM 출발로)
  const vmManaged = withOrigin(ECS(), "vm", "ec2");
  assert.ok(classChange(vmManaged).every((a) => a.from === "vm" && a.to === "managedContainer"));
  for (const p of ["aws", "gcp"] as const) { assert.deepEqual(unsupported(vmManaged, p), [], p); assert.equal(isManaged(vmManaged, p), true, p); }
  assert.ok(unsupported(vmManaged, "onprem").length > 0);
});
