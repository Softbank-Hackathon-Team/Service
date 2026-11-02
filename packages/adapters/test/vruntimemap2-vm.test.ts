// VRUNTIMEMAP2: RUNTIMEMAP v2(출발 VM → 도착 VM) 검증. 경계값·거부 경로·precheck=Builder 불변식·결정성·출력 펼치기. 순수 함수
import { test } from "node:test";
import assert from "node:assert/strict";
import { AppSpecV2, VmTfVars, type Provider } from "@svc/contracts";
import { AdapterError, DEMO_INVENTORY_V2, flattenTfOutputsV2, normalizeV2, targetBuilderFor, UNSUPPORTED_V2, v2Blockers, v2PrecheckItems } from "../src/index.js";

type Raw = Record<string, any>;
const T = { envId: "33333333-3333-4333-8333-333333333333", region: "default", tenantId: "11111111-1111-4111-8111-111111111111", migrationId: "22222222-2222-4222-8222-222222222222" };
const at = (p: Provider, over: Partial<typeof T> = {}) => ({ ...T, ...over, provider: p }) as never;
const D = (c: string) => "sha256:" + c.repeat(64);

/** ECS 데모에서 web 을 빼고 서비스 전부 VM 출발·VM 도착 (api ← entry, worker), DB 1 */
function vmApp(mut?: (o: Raw) => void): AppSpecV2 {
  const o: Raw = structuredClone(normalizeV2(DEMO_INVENTORY_V2.aws!).result.spec);
  for (const c of o.components) if (c.kind === "service") { c.props.origin = { runtime: "vm", product: "ec2" }; c.props.runtime = "vm"; }
  o.components = o.components.filter((c: Raw) => c.id !== "shop-web");
  o.links = o.links.filter((l: Raw) => l.from !== "shop-web" && l.to !== "shop-web");
  o.entry.hosts[0].routes = o.entry.hosts[0].routes.filter((r: Raw) => r.backends.every((b: Raw) => b.to !== "shop-web"));
  mut?.(o);
  return AppSpecV2.parse(o);
}
const api = (o: Raw) => o.components.find((c: Raw) => c.id === "shop-api");
const worker = (o: Raw) => o.components.find((c: Raw) => c.id === "shop-worker");
const tf = (s: AppSpecV2, p: Provider, over: Partial<typeof T> = {}) => targetBuilderFor(p).toTerraformV2(s, at(p, over));
const vms = (s: AppSpecV2, p: Provider, over: Partial<typeof T> = {}) =>
  (JSON.parse(String(tf(s, p, over).vars.vm_json)) as unknown[]).map((x) => VmTfVars.parse(x));
const unsupported = (s: AppSpecV2, p: Provider) => v2Blockers(s, targetBuilderFor(p).capabilities()).unsupported;
const precheck = (p: Provider, s: AppSpecV2) => v2PrecheckItems(p, { spec: null, specV2: s, hadV2Before: false });
// precheck 의 "UNSUP"(capability·모양) 막힘 ⇔ Builder 가 UNSUPPORTED_V2 를 던짐. 사람 확인(PC-V2-HUMAN, 방화벽 등)은 Builder 가 안 던지는 별개 칸
const unsupBlocks = (p: Provider, s: AppSpecV2) => precheck(p, s).filter((i) => i.level === "block" && i.id.startsWith("PC-V2-UNSUP"));
const builderThrows = (p: Provider, s: AppSpecV2) => {
  try { tf(s, p); return false; } catch (e) { assert.ok(e instanceof AdapterError && e.code === UNSUPPORTED_V2, String(e)); return true; }
};

test("경계값: IR id 40자(최대) → aws·gcp VM 이름·신원 이름이 HCL 검사 규칙 안 (gcp 이름 49자·소문자 시작·끝 영숫자, 신원 6~30자 app-, 인스턴스 이름 -N 붙여도 63자)", () => {
  const long = "a" + "b".repeat(39);
  const s = vmApp((o) => {
    api(o).id = long;
    for (const l of o.links) if (l.from === "shop-api") l.from = long;
    for (const r of o.entry.hosts[0].routes) for (const b of r.backends) if (b.to === "shop-api") b.to = long;
  });
  const g = vms(s, "gcp").find((x) => x.id === long)!;
  assert.match(g.name, /^[a-z]([-a-z0-9]{0,47}[a-z0-9])?$/);   // infra/modules/gcp/kinds/vm validation 과 같은 식
  assert.ok(g.role_name.length >= 6 && g.role_name.length <= 30 && g.role_name.startsWith("app-"), g.role_name);
  assert.ok(`${g.name}-${g.instances}`.length <= 63);
  const a = vms(s, "aws").find((x) => x.id === long)!;
  assert.ok(a.name.length <= 63 && a.role_name.length <= 64 && a.role_name.startsWith("app-"), `${a.name} ${a.role_name}`);
});

test("경계값: 대수 = replicas.min, 0 이면 1대 + precheck 경고 (VRUNTIMEMAP2 고침) / 요청량 없으면 limit, 둘 다 없으면 null / HTTP 아닌 준비 검사는 health_path null", () => {
  const s = vmApp((o) => {
    worker(o).props.replicas = { min: 0, max: 0 };
    worker(o).props.resources = { limit: { cpuMilli: 2000, memMiB: 4096 } };
    api(o).props.resources = {};
    api(o).props.probes = { readiness: { type: "tcp", port: 8080 } };
  });
  for (const p of ["aws", "gcp"] as const) {
    const [a, w] = [vms(s, p).find((x) => x.id === "shop-api")!, vms(s, p).find((x) => x.id === "shop-worker")!];
    assert.equal(w.instances, 1, p);
    assert.deepEqual([w.cpu_milli, w.mem_mib], [2000, 4096], p);
    assert.deepEqual([a.cpu_milli, a.mem_mib, a.health_path], [null, null, null], p);
    const warns = precheck(p, s).filter((i) => i.level === "warn").map((i) => i.message);
    assert.ok(warns.some((m) => /shop-worker: 출발 최소 대수 0 → .*1대/.test(m)), `${p}: ${warns.join(" | ")}`);
  }
  // min ≥ 1 이면 그 경고 없음
  assert.ok(!precheck("aws", vmApp()).some((i) => /최소 대수 0/.test(i.message)));
});

test("불변식: precheck UNSUP 막힘 ⇔ Builder UNSUPPORTED_V2 (aws·gcp·onprem·azure_mock × 정상·섞임·못 그리는 칸·주입 사이드카)", () => {
  const sidecar = (injected: boolean) => [{ name: "proxy", image: { source: "registry", repository: "r.example.com/proxy", digest: D("b") }, injected, env: [], resources: {} }];
  const job = { id: "nightly", kind: "job", props: { image: { source: "registry", repository: "r.example.com/batch", digest: D("a") }, resources: {}, env: [], serviceAccount: "batch", schedule: "0 3 * * *" } };
  const cases: Array<[string, AppSpecV2, boolean]> = [
    ["정상", vmApp(), false],
    ["주입 사이드카(메시)는 막지 않음", vmApp((o) => { api(o).props.sidecars = sidecar(true); }), false],
    ["직접 사이드카", vmApp((o) => { api(o).props.sidecars = sidecar(false); }), true],
    ["잡 섞임", vmApp((o) => { o.components.push(job); }), true],
    ["관리형 섞임", vmApp((o) => { worker(o).props.runtime = "managedContainer"; }), true],
    ["fromField", vmApp((o) => { api(o).props.env.push({ name: "POD", fromField: "metadata.name" }); }), true],
    ["envFrom", vmApp((o) => { api(o).props.envFrom = [{ config: "shop-cfg", prefix: "" }]; }), true],
    ["권한 기준선", vmApp((o) => { o.posture.permissions = [{ subject: "shop-api", source: "iam:shop-api-role", effect: "Allow", actions: ["s3:GetObject"], resources: ["*"], mode: "mirror" }]; }), true],
  ];
  for (const [name, s, blockedOnCloud] of cases)
    for (const p of ["aws", "gcp", "onprem", "azure_mock"] as const) {
      const blocked = unsupBlocks(p, s).length > 0;
      assert.equal(blocked, builderThrows(p, s), `${name} ${p}: precheck=${blocked}`);
      if (p === "aws" || p === "gcp") assert.equal(blocked, blockedOnCloud, `${name} ${p}: ${unsupported(s, p).join(" | ")}`);
      else assert.equal(blocked, true, `${name} ${p}: VM 모듈 없는 도착은 늘 막힘`);
    }
});

test("결정성·멱등: 두 번 그려도·components/links 순서를 뒤집어도 vm_json 같음 / 이름은 회사 기준(같은 회사 재이전 = 같은 이름, 다른 회사 = 다른 이름)", () => {
  const s = vmApp();
  for (const p of ["aws", "gcp"] as const) {
    assert.equal(JSON.stringify(tf(s, p)), JSON.stringify(tf(s, p)), p);
    const r: Raw = structuredClone(s); r.components.reverse(); r.links.reverse();
    assert.equal(tf(AppSpecV2.parse(r), p).vars.vm_json, tf(s, p).vars.vm_json, p);
    const again = vms(s, p, { migrationId: "44444444-4444-4444-8444-444444444444" }).map((x) => x.name);
    assert.deepEqual(again, vms(s, p).map((x) => x.name), `${p}: 같은 회사 다른 이전`);
    const other = vms(s, p, { tenantId: "55555555-5555-4555-8555-555555555555" }).map((x) => x.name);
    assert.ok(other.every((n, i) => n !== vms(s, p)[i]!.name), `${p}: 다른 회사`);
  }
});

test("비밀·출력: vm_json 에 비밀 값 없음(저장소 이름·키만), 머신 종류 출력은 펼쳐져 화면 값에, 출력 전엔 자리표시", () => {
  const s = vmApp();
  for (const p of ["aws", "gcp"] as const) {
    const raw = String(tf(s, p).vars.vm_json);
    assert.ok(!/password"\s*:\s*"[^"]/.test(raw.replace(/"key":"password"/g, "")), raw);
    const a = vms(s, p).find((x) => x.id === "shop-api")!;
    assert.deepEqual(JSON.parse(a.secrets_json).map((x: Raw) => Object.keys(x).sort()), [["key", "name", "secret"]]);
    assert.ok(!JSON.parse(a.env_json).some((e: Raw) => e.name === "DATABASE_PASSWORD"), "비밀 env 가 일반 env 로 샘");
    const out = flattenTfOutputsV2({ vm_machine_types: JSON.stringify({ "shop-api": p === "aws" ? "t3.small" : "e2-small" }) } as never);
    const v: Raw = targetBuilderFor(p).toWorkloadValues(s, out, at(p));
    assert.equal(v.vm.find((x: Raw) => x.id === "shop-api").machine, p === "aws" ? "t3.small" : "e2-small", p);
    assert.match(v.vm.find((x: Raw) => x.id === "shop-worker").machine, /^<tf-output:vm\.shop-worker\.machine>$/, p);
    const before: Raw = targetBuilderFor(p).toWorkloadValues(s, {}, at(p));
    assert.match(before.vm[0].machine, /^<tf-output:/);
  }
  // 깨진 출력(JSON 아님·배열)은 무시, 이미 있는 키는 덮지 않음
  assert.deepEqual(flattenTfOutputsV2({ vm_machine_types: "nope" } as never), { vm_machine_types: "nope" });
  assert.equal(flattenTfOutputsV2({ vm_machine_types: "[1]" } as never)["vm.0.machine"], undefined);
  assert.equal(flattenTfOutputsV2({ vm_machine_types: JSON.stringify({ a: "x" }), "vm.a.machine": "keep" } as never)["vm.a.machine"], "keep");
});
