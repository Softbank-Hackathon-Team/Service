// RUNTIMEMAP (N8): 도착 실행 방식 = 출발과 같은 종류. 출발 k8s → 도착 k8s(EKS·GKE·k3s, 같은 Helm 차트), 출발 ECS·Cloud Run(관리형 컨테이너) → 도착 ECS(aws)·Cloud Run(gcp).
//   출발 VM(EC2·GCE) → 도착 VM (RUNTIMEMAP v2, 2026-11-02 결정: 최대한 출발 환경과 같게). 온프레 VM 은 없음(거부, TODO(human)).
//   사람이 runtime 을 바꾼 경우(runtime_change 승인)만 다른 종류 허용 (컨테이너화 = opt-in)
import { test } from "node:test";
import assert from "node:assert/strict";
import { AppSpecV2, checkV2, VmTfVars, type Provider } from "@svc/contracts";
import { applySpecV2Patch } from "@svc/core";
import { AdapterError, DEMO_INVENTORY, managedBlockers, normalizeV2, targetBuilderFor, UNSUPPORTED_V2, v2Blockers } from "../src/index.js";

const T = { envId: "33333333-3333-4333-8333-333333333333", region: "default", tenantId: "11111111-1111-4111-8111-111111111111", migrationId: "22222222-2222-4222-8222-222222222222" };
const at = (p: Provider) => ({ ...T, provider: p }) as never;
type Raw = Record<string, any>;
const spec = (k: "aws" | "gcp" | "onprem") => normalizeV2(DEMO_INVENTORY[k]!).result.spec as AppSpecV2;
const K8S = () => spec("gcp");          // 출발 k8s (GKE) — 서비스·잡
const ECS = () => spec("aws");          // 출발 ECS — 서비스 3개
function withOrigin(s: AppSpecV2, runtime: string, product: string): AppSpecV2 {
  const o: Raw = structuredClone(s);
  for (const c of o.components) if (c.kind === "service") c.props.origin = { runtime, product };
  return AppSpecV2.parse(o);
}
const CLOUDRUN = () => withOrigin(ECS(), "managedContainer", "cloudRun");   // 관리형 컨테이너 출발 = ECS 와 같은 종류
function withRuntime(s: AppSpecV2, runtime: "k8s" | "managedContainer" | "vm", only?: string[]): AppSpecV2 {
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
  const r = normalizeV2(DEMO_INVENTORY.aws!).result;
  const base = { spec: r.spec, fieldMeta: r.fieldMeta as never };
  const ok = applySpecV2Patch(base, { changes: [{ path: "components.shop-api.runtime", value: "k8s" }] });
  assert.deepEqual(checkV2(AppSpecV2.parse(ok.spec)).approvals.filter((a) => a.kind === "runtime_change").map((a) => a.subject), ["shop-api"]);
  assert.throws(() => applySpecV2Patch(base, { changes: [{ path: "components.shop-api.origin", value: { runtime: "k8s", product: "k8s" } }] }),
    (e: unknown) => (e as { code?: string; status?: number }).code === "SPEC_PATCH_INVALID" && /origin/.test((e as Error).message));
});

// ── 출발 VM → 도착 VM (aws EC2 · gcp GCE) ──
// 출발 VM 앱: ECS 데모에서 서비스끼리 부르는 web 을 빼고(VM 주소 참조는 아직 막혀 있음) VM 출발로 둔 것. api(2대)·worker(1대) + DB, 입구 = api
function vmApp(): AppSpecV2 {
  const o: Raw = structuredClone(withRuntime(withOrigin(ECS(), "vm", "ec2"), "vm"));
  o.components = o.components.filter((c: Raw) => c.id !== "shop-web");
  o.links = o.links.filter((l: Raw) => l.from !== "shop-web" && l.to !== "shop-web");
  o.entry.hosts[0].routes = o.entry.hosts[0].routes.filter((r: Raw) => r.backends.every((b: Raw) => b.to !== "shop-web"));
  return AppSpecV2.parse(o);
}
const isVm = (s: AppSpecV2, p: Provider) => "vm_json" in tf(s, p).vars;
const vmItems = (s: AppSpecV2, p: Provider) => JSON.parse(String(tf(s, p).vars.vm_json)) as Array<Record<string, any>>;

test("출발 VM 기본 = 도착 VM: 승인 줄(runtime_change) 0, aws(EC2)·gcp(GCE) 막힘 0, Terraform 은 vm_json 만 (service_json·k8s 신원·네임스페이스 없음)", () => {
  const s = vmApp();
  for (const c of s.components) if (c.kind === "service") assert.deepEqual([c.props.runtime, c.props.origin.runtime], ["vm", "vm"]);
  assert.deepEqual(classChange(s), []);
  for (const p of ["aws", "gcp"] as const) {
    assert.deepEqual(unsupported(s, p), [], p);
    const call = tf(s, p);
    assert.equal(isVm(s, p), true, p);
    assert.equal("service_json" in call.vars, false, p);
    assert.equal(call.vars.identity_json, "[]", p);
    assert.equal(call.vars.namespace_json, "[]", p);
    assert.deepEqual(call.instances.filter((i) => i.kind === "vm").map((i) => [i.id, i.module]), [["shop-api", `${p}/kinds/vm`], ["shop-worker", `${p}/kinds/vm`]], p);
    assert.ok(call.modules.some((m) => JSON.stringify(m).includes(`${p}/kinds/vm`)), p);
    const items = vmItems(s, p);
    items.forEach((x) => VmTfVars.parse(x));
    assert.deepEqual(items.map((x) => [x.id, x.instances]), [["shop-api", 2], ["shop-worker", 1]], `${p}: 대수 = 출발 replicas.min`);
    const api = items.find((x) => x.id === "shop-api")!;
    assert.equal(api.port, 8080); assert.equal(api.public, true);
    assert.match(api.image, /@sha256:[0-9a-f]{64}$/);
    assert.match(api.role_name, /^app-/);
    // 비밀 값은 안 옴 (저장소 이름만), DB 주소는 조각(ref)으로
    assert.deepEqual(JSON.parse(api.secrets_json).map((x: Raw) => x.key), ["password"]);
    assert.ok(JSON.parse(api.env_json).some((e: Raw) => e.parts.some((q: Raw) => q.ref === "shop-db.host")), p);
  }
});

test("출발 VM 도착: DB 복제는 그대로 (postgres_json 은 VM 이 아닌 도착과 같은 모양, 논리 복제 켬), 값은 Helm 워크로드 없이 vm 목록", () => {
  const s = vmApp();
  for (const p of ["aws", "gcp"] as const) {
    const k8s = tf(withRuntime(vmApp(), "k8s"), p).vars.postgres_json;
    assert.equal(tf(s, p).vars.postgres_json, k8s, `${p}: DB 는 실행 방식과 무관`);
    assert.equal(JSON.parse(String(k8s))[0].logical_replication, true, p);
    const v: Raw = targetBuilderFor(p).toWorkloadValues(s, {}, at(p));
    assert.deepEqual(v.workloads, [], p);
    assert.deepEqual(v.vm.map((x: Raw) => [x.id, x.runtime, x.instances]), [["shop-api", p === "aws" ? "ec2" : "gce", 2], ["shop-worker", p === "aws" ? "ec2" : "gce", 1]], p);
  }
});

test("컨테이너화는 opt-in: VM 출발을 runtime 만 바꾸면 승인 줄(vm→k8s·vm→managedContainer)이 따라오고 그 종류로 그려짐", () => {
  const toK8s = withRuntime(vmApp(), "k8s");
  assert.ok(classChange(toK8s).length > 0 && classChange(toK8s).every((a) => a.from === "vm" && a.to === "k8s"));
  for (const p of ["aws", "gcp", "onprem"] as const) { assert.deepEqual(unsupported(toK8s, p), [], p); assert.equal(isVm(toK8s, p), false, p); assert.equal(isManaged(toK8s, p), false, p); }
  const toManaged = withRuntime(vmApp(), "managedContainer");
  assert.ok(classChange(toManaged).every((a) => a.from === "vm" && a.to === "managedContainer"));
  for (const p of ["aws", "gcp"] as const) { assert.deepEqual(unsupported(toManaged, p), [], p); assert.equal(isManaged(toManaged, p), true, p); assert.equal(isVm(toManaged, p), false, p); }
  // 반대로 k8s 출발을 VM 으로 바꾸는 것도 승인 줄 (재현성을 깨는 선택)
  const k8sToVm = withRuntime(K8S(), "vm", ["shop-api"]);
  assert.ok(classChange(k8sToVm).some((a) => a.from === "k8s" && a.to === "vm"));
});

test("PATCH: VM 출발의 runtime 을 k8s 로 바꾸면 승인 줄이 따라오고, vm 으로 되돌리면 사라짐 (origin 은 못 고침)", () => {
  const s = vmApp();
  const base = { spec: s, fieldMeta: {} as never };
  const toK8s = applySpecV2Patch(base, { changes: [{ path: "components.shop-api.runtime", value: "k8s" }] });
  assert.deepEqual(classChange(AppSpecV2.parse(toK8s.spec)).map((a) => a.subject), ["shop-api"]);
  const back = applySpecV2Patch({ spec: toK8s.spec, fieldMeta: toK8s.fieldMeta as never }, { changes: [{ path: "components.shop-api.runtime", value: "vm" }] });
  assert.deepEqual(classChange(AppSpecV2.parse(back.spec)), []);
});

// ── 거부: VM 모듈이 없는 도착, 섞임, VM 이 못 그리는 칸, 이미지 빌드 자리 ──
test("거부: 온프레(k3s)·azure_mock 은 VM 도착 모듈이 없다 → runtime.vm 미지원 + 컨테이너로 옮기는 길(runtime 변경) 안내", () => {
  const s = vmApp();
  for (const p of ["onprem", "azure_mock"] as const) {
    const u = unsupported(s, p);
    assert.ok(u.some((m) => m.includes("runtime.vm") && m.includes("shop-api") && m.includes("runtime 을 k8s 로")), `${p}: ${u.join(" | ")}`);
    if (p === "onprem") refuses(s, p);
  }
});

test("거부: VM 서비스와 k8s 워크로드(잡) 섞임·VM 서비스끼리 주소·sidecars/volumes·이미지 빌드 자리", () => {
  // 섞임: 같은 명세의 서비스 하나만 k8s
  const mixed = withRuntime(vmApp(), "k8s", ["shop-worker"]);
  assert.ok(unsupported(mixed, "aws").some((m) => m.includes("섞음")));
  refuses(mixed, "aws");
  // VM 끼리 주소: ECS 데모 그대로(web → api) 를 VM 으로
  const chained = withRuntime(withOrigin(ECS(), "vm", "ec2"), "vm");
  const u = unsupported(chained, "gcp");
  assert.ok(u.some((m) => m.includes("shop-web") && m.includes("다른 서비스 주소")), u.join(" | "));
  assert.ok(u.some((m) => m.includes("VM 서비스 사이 링크")));
  refuses(chained, "gcp");
  // VM 이 못 그리는 칸
  const o: Raw = structuredClone(vmApp());
  const api = o.components.find((c: Raw) => c.id === "shop-api");
  api.props.volumes = [{ name: "data", mountPath: "/data" }];
  api.props.ports.push({ name: "m", port: 9090, protocol: "TCP" });
  const bad = unsupported(AppSpecV2.parse(o), "aws").join(" | ");
  assert.match(bad, /volumes/); assert.match(bad, /ports 2개 이상/);
  // 이미지가 빌드 자리(VM 가져오기 직후)면 이미지를 먼저 만들어야 함 — 지금은 image.build capability 없음
  const built: Raw = structuredClone(vmApp());
  built.components.find((c: Raw) => c.id === "shop-api").props.image = { source: "build", repository: "shop-api", digest: null,
    build: { repo: "TODO(human):source-repo", commit: "TODO(human):deployed-commit", path: ".", method: "dockerfile", evidence: ["ec2:shop-api"] } };
  assert.ok(unsupported(AppSpecV2.parse(built), "aws").some((m) => m.includes("image.build")));
});
