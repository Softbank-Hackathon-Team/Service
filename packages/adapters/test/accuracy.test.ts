// ACCURACY (ALIGN-v2 IR-10): 가져오기 정확도 %. 순수 함수 — 완전 일치 100%, 한 칸 틀리면 그만큼, 비교 불가는 분모에서 빠짐, 비밀값 안 새어 나감
import { test } from "node:test";
import assert from "node:assert/strict";
import { ImportAccuracy, type AppSpecV2, type Provider, type RawInventory } from "@svc/contracts";
import { DEMO_INVENTORY, measureImportAccuracy, normalizeV2, targetBuilderFor } from "../src/index.js";

type O = Record<string, any>;
const T = (p: Provider) => ({ envId: "33333333-3333-4333-8333-333333333333", provider: p, region: "default", tenantId: "11111111-1111-4111-8111-111111111111", migrationId: "22222222-2222-4222-8222-222222222222" }) as never;
const inv = (): RawInventory => structuredClone(DEMO_INVENTORY.gcp!);
const deploy = (i: RawInventory, name: string) => (i.items as O[]).find((x) => x.kind === "k8s.deployment" && x.metadata.name === name)!;
const run = (i: RawInventory, mutate?: (spec: O) => void, target: Provider | null = "aws") => {
  const result = normalizeV2(i).result;
  const rendered = target ? (targetBuilderFor(target).toWorkloadValues(result.spec, {}, T(target)) as O) : undefined;
  if (mutate) mutate(rendered ?? (result.spec as O));
  return measureImportAccuracy({ inventory: i, result, rendered });
};
const wl = (r: O, id: string) => (r.workloads as O[]).find((w) => w.name === id)!;
const specProps = (s: O, id: string) => (s.components as O[]).find((c) => c.id === id)!.props;
const pick = (a: ReturnType<typeof run>, component: string, field: string) => a.fields.find((f) => f.component === component && f.field === field);

test("완전 일치: 렌더 기준·명세 기준 모두 100%, 틀린 칸 0, 계약 통과", () => {
  for (const target of ["aws", "gcp", "onprem", null] as const) {
    const a = run(inv(), undefined, target);
    assert.equal(a.percent, 100, `${target}: ${JSON.stringify(a.fields.filter((f) => f.result !== "match"))}`);
    assert.equal(a.mismatched, 0);
    assert.equal(a.basis, target ? "render" : "spec");
    assert.ok(a.comparable >= 15, `비교 칸이 너무 적음: ${a.comparable}`);
    ImportAccuracy.parse(a);
  }
  const a = run(inv());
  for (const f of ["image.digest", "ports", "env.names", "replicas", "resources.cpu", "resources.memory", "probes.readiness"]) assert.equal(pick(a, "shop-api", f)?.result, "match", f);
  assert.equal(pick(a, "shop-cleanup", "schedule")?.result, "match");
  assert.equal(pick(a, "shop-db", "db.version")?.result, "match");
  assert.equal(pick(a, "shop-db", "db.storageGb")?.result, "match");
});

test("한 칸 틀리면 그만큼만 떨어짐 (복제 수 · 이미지 · 포트 · 프로브 · 환경변수 이름 · 요청 자원)", () => {
  const base = run(inv());
  const cases: Array<[string, string, (r: O) => void]> = [
    ["shop-api", "replicas", (r) => { const w = wl(r, "shop-api"); w.scale = { min: 1, max: 6 }; delete w.replicas; }],
    ["shop-api", "image.digest", (r) => { wl(r, "shop-api").image = "x.example/shop-api@sha256:" + "c".repeat(64); }],
    ["shop-api", "ports", (r) => { wl(r, "shop-api").ports = [{ containerPort: 9090 }]; }],
    ["shop-api", "probes.readiness", (r) => { wl(r, "shop-api").probes.readiness.httpGet.path = "/other"; }],
    ["shop-api", "env.names", (r) => { wl(r, "shop-api").env = wl(r, "shop-api").env.filter((e: O) => e.name !== "DATABASE_PASSWORD"); }],
    ["shop-api", "resources.cpu", (r) => { wl(r, "shop-api").resources.requests.cpu = "100m"; }],
    ["shop-api", "resources.memory", (r) => { wl(r, "shop-api").resources.requests.memory = "128Mi"; }],
    ["shop-cleanup", "schedule", (r) => { wl(r, "shop-cleanup").job.schedule = "0 4 * * *"; }],
  ];
  for (const [c, f, m] of cases) {
    const a = run(inv(), m);
    assert.equal(pick(a, c, f)?.result, "mismatch", `${c} ${f}`);
    assert.equal(a.mismatched, 1, `${c} ${f}: 하나만 틀려야 함`);
    assert.equal(a.comparable, base.comparable);
    assert.equal(a.percent, Math.round(((base.comparable - 1) / base.comparable) * 1000) / 10);
  }
  // 명세 기준(렌더 없음)도 같다
  const s = run(inv(), (spec) => { specProps(spec, "shop-api").replicas = { min: 3, max: 3 }; }, null);
  assert.equal(pick(s, "shop-api", "replicas")?.result, "mismatch"); assert.equal(s.mismatched, 1);
});

test("DB 버전·용량이 명세에서 틀리면 잡힌다", () => {
  const a = run(inv(), undefined, null);
  const b = measureImportAccuracy({ inventory: inv(), result: (() => { const r = normalizeV2(inv()).result; const p = (r.spec.components.find((c) => c.id === "shop-db") as O).props; p.majorVersion = "15"; p.storageGb = 50; return r; })() });
  assert.equal(pick(b, "shop-db", "db.version")?.result, "mismatch");
  assert.equal(pick(b, "shop-db", "db.storageGb")?.result, "mismatch");
  assert.equal(b.mismatched, 2); assert.ok((b.percent ?? 100) < (a.percent ?? 0));
});

test("도착 렌더에 워크로드가 없으면 workload 칸 하나가 틀림으로 남는다 (조용히 빠지지 않음)", () => {
  const a = run(inv(), (r) => { r.workloads = r.workloads.filter((w: O) => w.name !== "shop-web"); });
  assert.equal(pick(a, "shop-web", "workload")?.result, "mismatch");
  assert.ok(!a.fields.some((f) => f.component === "shop-web" && f.field !== "workload"));
});

test("비교 불가(원본 값을 못 읽음)는 분모에서 빠진다: percent 는 비교 가능한 칸만으로 계산", () => {
  const i = inv();
  (deploy(i, "shop-api").spec.template.spec.containers[0].resources.requests as O).cpu = "abc";   // 수량을 못 읽음
  const a = run(i);
  assert.equal(pick(a, "shop-api", "resources.cpu")?.result, "unverifiable");
  assert.equal(a.unverifiable, 1);
  assert.equal(a.comparable, a.total - 1);
  assert.equal(a.percent, 100);
  // 비교 불가 + 틀림 하나: 분모는 비교 가능한 칸
  const b = run(i, (r) => { const w = wl(r, "shop-api"); delete w.scale; w.replicas = 9; });
  assert.equal(b.percent, Math.round(((b.comparable - 1) / b.comparable) * 1000) / 10);
});

test("비교할 칸이 하나도 없으면 percent 는 null (0%·100% 로 속이지 않음)", () => {
  const a = measureImportAccuracy({ inventory: { provider: "gcp", items: [], coverage: {} }, result: normalizeV2(inv()).result });
  assert.deepEqual([a.total, a.comparable, a.percent], [0, 0, null]);
  ImportAccuracy.parse(a);
});

test("환경변수 값·비밀값은 결과 어디에도 없다 (이름만)", () => {
  const i = inv();
  const c = deploy(i, "shop-api").spec.template.spec.containers[0];
  c.env.push({ name: "API_TOKEN", value: "s3cr3t-value-ZZZ" });
  const a = run(i, (r) => { wl(r, "shop-api").env = wl(r, "shop-api").env.filter((e: O) => e.name !== "API_TOKEN"); });
  const f = pick(a, "shop-api", "env.names");
  assert.equal(f?.result, "mismatch");
  assert.match(f?.detail ?? "", /API_TOKEN/);          // 이름은 나온다
  assert.ok(!JSON.stringify(a).includes("s3cr3t-value-ZZZ"));   // 값은 안 나온다
});
