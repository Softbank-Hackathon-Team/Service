// VACCURACY: ACCURACY 검증 — 경계값·다른 DB 종류·같은 이름 다른 네임스페이스·순수성
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Provider, RawInventory } from "@svc/contracts";
import { DEMO_INVENTORY, measureImportAccuracy, normalizeV2, targetBuilderFor } from "../src/index.js";

type O = Record<string, any>;
const T = (p: Provider) => ({ envId: "33333333-3333-4333-8333-333333333333", provider: p, region: "default", tenantId: "11111111-1111-4111-8111-111111111111", migrationId: "22222222-2222-4222-8222-222222222222" }) as never;
const gcp = (): RawInventory => structuredClone(DEMO_INVENTORY.gcp!);
const items = (i: RawInventory) => i.items as O[];
const dep = (i: RawInventory, n: string, ns = "shop") => items(i).find((x) => x.kind === "k8s.deployment" && x.metadata.name === n && x.metadata.namespace === ns)!;
const measure = (i: RawInventory, target: Provider | null = "aws", mutate?: (r: O) => void) => {
  const result = normalizeV2(i).result;
  const rendered = target ? (targetBuilderFor(target).toWorkloadValues(result.spec, {}, T(target)) as O) : undefined;
  if (mutate && rendered) mutate(rendered);
  return { a: measureImportAccuracy({ inventory: i, result, rendered }), result };
};
const f = (a: ReturnType<typeof measure>["a"], c: string, field: string) => a.fields.find((x) => x.component === c && x.field === field);

test("버그 고침 확인: RDS(ARN 열쇠)·Cloud SQL·CNPG 모두 DB 칸이 생기고, 명세가 틀리면 잡는다", () => {
  for (const [name, inv, dbId] of [["aws", DEMO_INVENTORY.aws!, "shop-db"], ["onprem", DEMO_INVENTORY.onprem!, "shop-db"], ["gcp", DEMO_INVENTORY.gcp!, "shop-db"]] as const) {
    const i = structuredClone(inv) as RawInventory;
    const { a, result } = measure(i, null);
    assert.equal(f(a, dbId, "db.version")?.result, "match", `${name}: db.version 칸 없음`);
    assert.equal(f(a, dbId, "db.storageGb")?.result, "match", name);
    const comp = result.spec.components.find((c) => c.id === dbId) as O;
    comp.props.majorVersion = "9";
    assert.equal(f(measureImportAccuracy({ inventory: i, result }), dbId, "db.version")?.result, "mismatch", name);
  }
});

test("RDS 가 postgres 가 아니면(unmapped) 칸을 안 만들고 던지지도 않는다", () => {
  const i = structuredClone(DEMO_INVENTORY.aws!) as RawInventory;
  items(i).find((x) => x.kind === "rds.dbInstance")!.Engine = "mysql";
  const { a } = measure(i, null);
  assert.ok(!a.fields.some((x) => x.field.startsWith("db.")));
});

test("복제 수: HPA 에 minReplicas 가 없으면 최소 1, replicas 0 인 Deployment 는 0 으로 비교", () => {
  const i = gcp();
  delete items(i).find((x) => x.kind === "k8s.hpa")!.spec.minReplicas;
  const { a } = measure(i, "aws", (r) => { r.workloads.find((w: O) => w.id === "shop-api").replicas = { min: 1, max: 6 }; });
  assert.equal(f(a, "shop-api", "replicas")?.result, "match");
  const z = gcp(); dep(z, "shop-web").spec.replicas = 0;
  const m = measure(z, null);
  assert.equal(f(m.a, "shop-web", "replicas")?.result, "match");
});

test("같은 이름 Deployment 가 다른 네임스페이스에 둘: 각각 자기 값과 비교한다", () => {
  const i = gcp();
  const twin = structuredClone(dep(i, "shop-web")); twin.metadata.namespace = "other"; twin.spec.replicas = 4;
  i.items.push(twin);
  // M-1·N9: 네임스페이스가 둘이면 도착 네임스페이스 하나로 접지 않는다 (같은 이름이 부딪힘) → 렌더는 막고 비교는 원본끼리
  assert.throws(() => measure(i, "aws"), /namespace\.multi/);
  const { a, result } = measure(i, null);
  const ids = Object.entries(result.ids).filter(([k]) => k.includes("shop-web")).map(([, v]) => v);
  assert.equal(new Set(ids).size, 2);
  assert.equal(a.mismatched, 0, JSON.stringify(a.fields.filter((x) => x.result !== "match")));
  for (const id of ids) assert.equal(f(a, id as string, "replicas")?.result, "match");
});

test("사이드카(둘째 컨테이너)의 환경변수·포트는 비교 대상이 아니다 (주 컨테이너만, 매퍼와 같은 규칙)", () => {
  const i = gcp();
  dep(i, "shop-api").spec.template.spec.containers.push({ name: "side", image: `x/side@sha256:${"ab".repeat(32)}`, env: [{ name: "SIDE_ONLY", value: "1" }], ports: [{ containerPort: 9999 }] });
  const { a } = measure(i, "aws");
  assert.equal(a.mismatched, 0);
  assert.ok(!JSON.stringify(a).includes("SIDE_ONLY"));
});

test("프로브: 포트가 이름(문자열)이어도 같은 값이면 일치, tcp 프로브도 비교", () => {
  const i = gcp();
  const c = dep(i, "shop-api").spec.template.spec.containers[0];
  c.readinessProbe = { httpGet: { path: "/healthz", port: "http" } };
  c.livenessProbe = { tcpSocket: { port: 8080 } };
  const { a } = measure(i, null);
  assert.equal(f(a, "shop-api", "probes.readiness")?.result, "match");
  assert.equal(f(a, "shop-api", "probes.liveness")?.result, "match");
  const m = measure(i, "aws", (r) => { r.workloads.find((w: O) => w.id === "shop-api").probes.liveness = { type: "http", path: "/", port: 8080 }; });
  assert.equal(f(m.a, "shop-api", "probes.liveness")?.result, "mismatch");
});

test("순수성: 입력을 바꾸지 않고 같은 입력이면 결과가 깊이 같다", () => {
  const i = gcp(); const { result } = normalizeV2(i);
  const before = JSON.stringify([i, result]);
  const x = measureImportAccuracy({ inventory: i, result }), y = measureImportAccuracy({ inventory: i, result });
  assert.equal(JSON.stringify([i, result]), before);
  assert.deepEqual(x, y);
});

test("ECS 출발도 비교 칸이 생김 (digest·환경변수 이름·포트·복제 수), 안 바꾸면 전부 맞음", () => {
  const i = structuredClone(DEMO_INVENTORY.aws!) as RawInventory;
  const { a } = measure(i, null);
  const ecs = a.fields.filter((x) => !x.field.startsWith("db."));
  assert.ok(ecs.some((x) => x.field === "replicas"), JSON.stringify(a.fields.map((x) => x.field)));
  assert.deepEqual(ecs.filter((x) => x.result === "mismatch"), []);
});

test("렌더 값이 비어 있어도({}) 던지지 않고 워크로드마다 workload 불일치", () => {
  const i = gcp(); const result = normalizeV2(i).result;
  const a = measureImportAccuracy({ inventory: i, result, rendered: {} });
  assert.equal(a.basis, "render");
  assert.equal(a.fields.filter((x) => x.field === "workload").length, 4);
});
