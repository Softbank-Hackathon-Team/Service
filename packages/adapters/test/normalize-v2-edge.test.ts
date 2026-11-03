// VI3a: I3a(normalizeV2·projectV1) 경계·거부·결정성 보강
import { test } from "node:test";
import assert from "node:assert/strict";
import { AppSpec, ImportResultV2, checkV2, type RawInventory } from "@svc/contracts";
import { normalizeV2 } from "../src/import/pipeline.js";
import { projectV1, rebuildFromV2 } from "../src/import/project-v1.js";
import { splitImage } from "../src/import/mappers/k8s-deployment.js";

const D = "sha256:" + "ab".repeat(32);
type Raw = Record<string, any>;
const inv = (items: Raw[]): RawInventory => ({ provider: "onprem", coverage: {}, items }) as RawInventory;
const dep = (name: string, ns = "shop", env: Raw[] = [], c: Raw = {}, spec: Raw = {}, digest: string | null = D): Raw => ({
  kind: "k8s.deployment", imageDigest: digest, metadata: { name, namespace: ns, labels: { app: name } },
  spec: { replicas: 2, selector: { matchLabels: { app: name } }, template: { metadata: { labels: { app: name } }, spec: { serviceAccountName: name, containers: [{
    name, image: `ghcr.io/demo/${name}:1.0`, ports: [{ containerPort: 8080 }], env, ...c }] } }, ...spec } });
const pg = (n: string, ns = "shop"): Raw => ({ kind: "cnpg.cluster", metadata: { name: n, namespace: ns }, spec: { imageName: "ghcr.io/cloudnative-pg/postgresql:16.4", storage: { size: "1Gi" }, instances: 1 } });
const svc = (name: string): Raw => ({ kind: "k8s.service", metadata: { name, namespace: "shop" }, spec: { selector: { app: name }, ports: [{ port: 80, targetPort: 8080 }] } });
const run = (items: Raw[], o = {}) => normalizeV2(inv(items), o);
const ids = (items: Raw[], o = {}) => run(items, o).result.ids;
const ID_RE = /^[a-z][a-z0-9-]{0,39}$/;

// ── 이미지 ───────────────────────────────────────────
test("splitImage: tag@digest 는 tag 를 떼고, 레지스트리 포트는 남긴다 (찾은 버그)", () => {
  const d = "sha256:" + "cd".repeat(32);
  assert.deepEqual(splitImage(`ghcr.io/demo/a:1.0@${d}`, null), { repository: "ghcr.io/demo/a", digest: d });
  assert.deepEqual(splitImage(`reg.local:5000/demo/a:1.0@${d}`, null), { repository: "reg.local:5000/demo/a", digest: d });
  assert.deepEqual(splitImage(`reg.local:5000/demo/a@${d}`, null), { repository: "reg.local:5000/demo/a", digest: d });
  assert.deepEqual(splitImage("reg.local:5000/demo/a", D), { repository: "reg.local:5000/demo/a", digest: D });
  assert.deepEqual(splitImage("a:1.0", null), { repository: "a", digest: null });
});
test("정상: tag@digest 이미지도 명세에는 repository 에 tag 가 없다", () => {
  const d = "sha256:" + "cd".repeat(32);
  const { spec } = run([dep("a", "shop", [], { image: `ghcr.io/demo/a:1.0@${d}` }, {}, null)]).result;
  assert.deepEqual((spec.components[0] as any).props.image, { source: "registry", repository: "ghcr.io/demo/a", digest: d });
});

// ── id ───────────────────────────────────────────────
test("id: 이름이 같은 Deployment 둘(네임스페이스 다름)은 네임스페이스를 붙여 구분", () => {
  assert.deepEqual(Object.values(ids([dep("api", "a"), dep("api", "b")])).sort(), ["a-api", "b-api"]);
});
test("id: 서비스와 DB 이름이 같으면 DB 쪽에 종류를 붙인다(서비스가 이름을 가짐)", () => {
  const r = ids([dep("shop-db"), pg("shop-db")]);
  assert.equal(r["k8s.deployment//shop/shop-db"], "shop-db");
  assert.equal(r["cnpg.cluster//shop/shop-db"], "postgres-shop-db");
});
test("id: 대문자·밑줄·점·긴 이름도 규칙(소문자 시작, 40자 이하)을 지키고 서로 안 겹친다", () => {
  const long = "a".repeat(60);
  const r = ids([dep("My_App.v2"), dep(long + "1"), dep(long + "2"), dep("9lives")]);
  const v = Object.values(r);
  assert.equal(new Set(v).size, 4, JSON.stringify(v));
  for (const id of v) assert.match(id, ID_RE, id);
  assert.ok(v.includes("my-app-v2"));
});
test("id 안정: 새 리소스가 늘어도, 판을 다시 가져와도 기존 id 는 그대로 (previousIds)", () => {
  const first = run([dep("api"), dep("web")]).result;
  const again = run([dep("web"), dep("api"), dep("zeta")], { previousIds: first.ids }).result;
  for (const [k, id] of Object.entries(first.ids)) assert.equal(again.ids[k], id);
  assert.equal(Object.keys(again.ids).length, 3);
});
test("id 거부: previousIds 에 같은 id 가 두 번 있어도 두 번째는 새로 받는다(겹침 없음)", () => {
  const r = ids([dep("a"), dep("b")], { previousIds: { "k8s.deployment//shop/a": "x", "k8s.deployment//shop/b": "x" } });
  assert.equal(new Set(Object.values(r)).size, 2);
});
test("결정성: 입력 순서·previousIds 있든 없든 같은 입력 → 글자까지 같은 결과", () => {
  const items = [dep("web", "shop", [{ name: "API", value: "http://api.shop.svc" }]), dep("api", "shop", [{ name: "DB", value: "shop-db-rw.shop.svc" }]), pg("shop-db"), svc("api"), svc("web")];
  const a = JSON.stringify(run(items).result), b = JSON.stringify(run([...items].reverse()).result);
  assert.equal(a, b);
  const prev = run(items).result.ids;
  assert.equal(JSON.stringify(run(items, { previousIds: prev }).result), a);
});

// ── 의존성·env ───────────────────────────────────────
test("의존성: 자기 자신을 부르는 주소는 연결을 안 만든다", () => {
  const { spec } = run([dep("api", "shop", [{ name: "SELF", value: "http://api.shop.svc" }])]).result;
  assert.deepEqual(spec.links, []);
});
test("의존성: 같은 네임스페이스의 맨 이름은 0.9 + 검토 표시, 전체 주소는 1", () => {
  const bare = run([dep("web", "shop", [{ name: "API", value: "api" }]), dep("api")]).result;
  assert.equal(bare.fieldMeta["links.web->api"]?.confidence, 0.9);
  assert.equal(bare.fieldMeta["links.web->api"]?.needs_review, true);
  const full = run([dep("web", "shop", [{ name: "API", value: "http://api.shop.svc.cluster.local:8080/x" }]), dep("api")]).result;
  assert.equal(full.fieldMeta["links.web->api"]?.confidence, 1);
});
test("env: JDBC·포트·경로·쿼리는 그대로 두고 주소만 ${대상.host} 로", () => {
  const { spec } = run([dep("api", "shop", [{ name: "U", value: "jdbc:postgresql://shop-db-rw.shop.svc:5432/app?ssl=true" }]), pg("shop-db")]).result;
  const e = (spec.components.find((c) => c.id === "api") as any).props.env[0];
  assert.deepEqual(e, { name: "U", template: "jdbc:postgresql://${shop-db.host}:5432/app?ssl=true" });
  assert.deepEqual(spec.links, [{ from: "api", to: "shop-db", intent: "connect" }]);
});
test("env: 같은 주소가 두 번 나와도 둘 다 바뀌고 연결은 하나", () => {
  const { spec } = run([dep("api", "shop", [{ name: "D", value: "shop-db-rw.shop.svc:5432,shop-db-rw.shop.svc:5432" }]), pg("shop-db")]).result;
  assert.equal((spec.components.find((c) => c.id === "api") as any).props.env[0].template, "${shop-db.host}:5432,${shop-db.host}:5432");
  assert.equal(spec.links.length, 1);
});
test("env: 평문 비밀 이름(PASSWORD 등)·비밀 자격이 든 URL 은 명세에서 빠지고 unmapped B 로 남는다", () => {
  const { spec, unmapped } = run([dep("api", "shop", [{ name: "DB_PASSWORD", value: "hunter2" }, { name: "URL", value: "postgres://u:pw@shop-db-rw.shop.svc/app" }, { name: "OK", value: "1" }]), pg("shop-db")]).result;
  const env = (spec.components.find((c) => c.id === "api") as any).props.env;
  assert.deepEqual(env, [{ name: "OK", value: "1" }]);
  assert.ok(!JSON.stringify(spec).includes("hunter2") && !JSON.stringify(spec).includes("u:pw"));
  assert.deepEqual(unmapped.map((u) => u.resource).sort(), ["env:api.DB_PASSWORD", "env:api.URL"]);
});
test("의존성: 이름 추측(0.6)은 근거 있는 연결이 없는 대상에만", () => {
  const withEv = run([dep("shop-api", "shop", [{ name: "D", value: "shop-db-rw.shop.svc" }]), dep("shop-web"), pg("shop-db")]).result;
  assert.deepEqual(withEv.spec.links.map((l) => `${l.from}->${l.to}`), ["shop-api->shop-db"]);
  const none = run([dep("shop-web"), pg("shop-db")]).result;
  assert.equal(none.fieldMeta["links.shop-web->shop-db"]?.confidence, 0.6);
  assert.equal(none.fieldMeta["links.shop-web->shop-db"]?.needs_review, true);
});

// ── HPA·부분 실패·빈 입력 ─────────────────────────────
test("HPA: 대상이 없으면 unmapped C, 다른 네임스페이스 HPA 는 안 붙고, CPU 아닌 지표는 0.6", () => {
  const items = [dep("api"),
    { kind: "k8s.hpa", metadata: { name: "h1", namespace: "shop" }, spec: { scaleTargetRef: { name: "nope" }, maxReplicas: 3 } },
    { kind: "k8s.hpa", metadata: { name: "h2", namespace: "other" }, spec: { scaleTargetRef: { name: "api" }, maxReplicas: 9 } },
    { kind: "k8s.hpa", metadata: { name: "h3", namespace: "shop" }, spec: { scaleTargetRef: { name: "api" }, minReplicas: 2, maxReplicas: 5, metrics: [{ type: "Pods", pods: {} }] } }];
  const { spec, unmapped, fieldMeta } = run(items).result;
  assert.deepEqual(unmapped.map((u) => u.resource), ["k8s.hpa:h1", "k8s.hpa:h2"], "대상 없음 / 다른 네임스페이스");
  const api = spec.components[0] as any;
  assert.deepEqual(api.props.replicas, { min: 2, max: 5 }, "other 네임스페이스 h2(9)는 안 붙음");
  assert.equal(api.props.scale, undefined);
  assert.equal(fieldMeta["components.api.scale"]?.confidence, 0.6);
});
test("부분 실패: 깨진 항목(메타 없음·컨테이너 없음)은 unmapped 로, 나머지는 정상 (throw 안 함)", () => {
  const items = [dep("ok"), { kind: "k8s.deployment", imageDigest: D }, { kind: "k8s.deployment", imageDigest: D, metadata: { name: "z", namespace: "shop" }, spec: { template: { spec: { containers: [] } } } },
    { kind: "rds.dbInstance" }, null as any, { nokind: 1 }];
  const { spec, unmapped } = run(items).result;
  assert.deepEqual(spec.components.map((c) => c.id), ["ok"]);
  assert.ok(unmapped.length >= 3);
  assert.equal(ImportResultV2.safeParse(run(items).result).success, true);
});
test("digest 없는 Deployment 는 리소스가 아니라 unmapped B, 이미지에 @sha256 이 있으면 digest 없어도 리소스", () => {
  const a = run([dep("a", "shop", [], {}, {}, null)]).result;
  assert.equal(a.spec.components.length, 0);
  assert.equal(a.unmapped[0]?.grade, "B");
  const b = run([dep("b", "shop", [], { image: "x@sha256:" + "cd".repeat(32) }, {}, null)]).result;
  assert.equal(b.spec.components.length, 1);
});
test("빈 원본·환경 종류만: 던지지 않고 빈 명세(unmapped 0), 환경 종류는 environment 에", () => {
  for (const items of [[], [{ kind: "eks.cluster", name: "x" }, { kind: "import.note", text: "n" }]]) {
    const { spec, unmapped, environment } = run(items).result;
    assert.equal(spec.components.length, 0);
    assert.deepEqual(unmapped, []);
    assert.equal(environment?.length, items.filter((i) => i.kind !== "import.note").length + items.filter((i) => i.kind === "import.note").length);
  }
});
test("projectV1: 서비스 0개 · 없는 IMPORT_APP 이름은 SOURCE_INCOMPLETE 로 거부", () => {
  const onlyDb = run([pg("shop-db")]);
  assert.throws(() => projectV1(onlyDb.result, onlyDb.projectionEnv), (e: { code?: string }) => e.code === "SOURCE_INCOMPLETE");
  const two = run([dep("app-a"), dep("app-b")]);
  assert.throws(() => projectV1(two.result, two.projectionEnv, { mainApp: "nope" }), (e: { code?: string }) => e.code === "SOURCE_INCOMPLETE");
  assert.equal(projectV1(two.result, two.projectionEnv, { mainApp: "app-b" }).spec.app?.name, "app-b");
});
test("rebuildFromV2: 서비스가 없는 v2 는 SPEC_V2_INVALID", () => {
  const out = run([dep("app-a")]);
  const v1 = projectV1(out.result, out.projectionEnv).spec;
  const noSvc = { ...out.result.spec, components: [] };
  assert.throws(() => rebuildFromV2(noSvc as any, v1 as any), (e: { code?: string }) => e.code === "SPEC_V2_INVALID");
});

// ── 알려진 계약 어긋남 (고치지 않고 기록) ─────────────
test("replicas 0 Deployment(0으로 줄여 둔 서비스)도 가져온다: Zod 통과, checkV2 는 막지 않고 검토 표시, v1 투영은 1로 올리고 검토 표시", () => {
  const out = run([dep("app-a", "shop", [], {}, { replicas: 0 })]);
  assert.equal(ImportResultV2.safeParse(out.result).success, true);
  assert.deepEqual((out.result.spec.components[0] as any).props.replicas, { min: 0, max: 0 });
  const c = checkV2(out.result.spec);
  assert.deepEqual(c.errors, []);
  assert.deepEqual(c.reviews, ["app-a.replicas 0 (출발에서 0으로 줄여 둔 서비스)"]);
  assert.deepEqual(checkV2(out.result.spec, { legacy: true }).reviews, []);
  const v1 = projectV1(out.result, out.projectionEnv);
  assert.equal(v1.spec.service?.replicas, 1);
  assert.equal(v1.fieldMeta["service.replicas"]?.needs_review, true);
  assert.equal(AppSpec.safeParse(v1.spec).success, true);
});
test("replicas 가 정상 범위(1~10)이면 v1 투영은 그대로·검토 표시 없음, 10 초과는 10으로", () => {
  const ok = run([dep("app-a", "shop", [], {}, { replicas: 3 })]);
  const v = projectV1(ok.result, ok.projectionEnv);
  assert.equal(v.spec.service?.replicas, 3);
  assert.equal(v.fieldMeta["service.replicas"]?.needs_review, false);
  const big = run([dep("app-a", "shop", [], {}, { replicas: 50 })]);
  assert.equal(projectV1(big.result, big.projectionEnv).spec.service?.replicas, 10);
});
test("자격 든 연결 URL env: 값은 v2·v1 어디에도 없고, 서비스→postgres 의존성(0.9)은 유지", () => {
  const out = run([dep("app-a", "shop", [{ name: "URL", value: "postgres://u:s3cr3t@shop-db-rw.shop.svc/app" }]), pg("shop-db")]);
  assert.deepEqual(out.result.spec.links, [{ from: "app-a", to: "shop-db", intent: "connect" }]);
  assert.equal(out.result.fieldMeta["links.app-a->shop-db"]?.confidence, 0.9);
  assert.equal(out.result.fieldMeta["links.app-a->shop-db"]?.needs_review, true);
  assert.deepEqual(out.result.unmapped.map((u) => u.resource), ["env:app-a.URL"]);
  const v1 = projectV1(out.result, out.projectionEnv);
  for (const doc of [out.result, out.projectionEnv, v1]) assert.ok(!JSON.stringify(doc).includes("s3cr3t"), "비밀 값이 남음");
  assert.deepEqual((out.result.spec.components.find((c) => c.id === "app-a") as any).props.env, []);
});
test("거부: 비밀번호 값이 우연히 DB 이름과 같아도 의존성 근거로 안 쓴다(주소 모양 아님)", () => {
  const out = run([dep("app-a", "shop", [{ name: "DB_PASSWORD", value: "shop-db" }]), pg("shop-db")]);
  assert.deepEqual(out.result.spec.links, []);
});
