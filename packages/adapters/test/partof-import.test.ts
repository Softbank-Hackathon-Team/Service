// PARTOF: 앱 경계 2순위 — 워크로드를 앱 묶음 라벨(app.kubernetes.io/part-of 등)로 한정. 순수 함수
import { test } from "node:test";
import assert from "node:assert/strict";
import { ImportResultV2, checkV2, type RawInventory } from "@svc/contracts";
import { normalizeV2 } from "../src/index.js";
import { appGroupOf } from "../src/import/app-group.js";

type Raw = Record<string, any>;
const NS = "shop";
const D = "sha256:" + "ab".repeat(32);
const inv = (items: Raw[]): RawInventory => ({ provider: "aws", coverage: {}, items });
const dep = (name: string, labels: Record<string, string> = {}, env: Raw[] = []): Raw => ({
  kind: "k8s.deployment", imageDigest: D, metadata: { name, namespace: NS, labels: { app: name, ...labels } },
  spec: { replicas: 1, selector: { matchLabels: { app: name } }, template: { metadata: { labels: { app: name } }, spec: { serviceAccountName: name, containers: [{
    name, image: `ghcr.io/demo/${name}:1.0`, ports: [{ containerPort: 8080 }], env }] } } },
});
const cron = (name: string, labels: Record<string, string>): Raw => ({ kind: "k8s.cronjob", imageDigest: D, metadata: { name, namespace: NS, labels },
  spec: { schedule: "0 3 * * *", jobTemplate: { spec: { template: { spec: { containers: [{ name, image: `ghcr.io/demo/${name}:1.0` }] } } } } } });
const bucket = (name: string): Raw => ({ kind: "s3.bucket", Name: name, Arn: `arn:aws:s3:::${name}` });
const P = "app.kubernetes.io/part-of", N = "app.kubernetes.io/name";
const ids = (r: ImportResultV2) => r.spec.components.map((c) => c.id).sort();
const outs = (r: ImportResultV2) => (r.outOfBoundary ?? []).map((o) => o.resource);

/** 한 네임스페이스에 shop(서비스 2 + 잡 1) 과 blog(서비스 1) 가 섞임. 각자 자기 버킷을 env 로 씀 */
const mixed = (): Raw[] => [
  dep("shop-api", { [P]: "shop" }, [{ name: "BUCKET", value: "s3://shop-assets" }]), dep("shop-web", { [P]: "shop" }), cron("shop-cleanup", { [P]: "shop" }),
  dep("blog-api", { [P]: "blog" }, [{ name: "BUCKET", value: "s3://blog-media" }]),
  bucket("shop-assets"), bucket("blog-media")];

test("정상: 두 앱이 섞인 네임스페이스 → 입력 없으면 워크로드가 많은 묶음(shop) 만, 다른 앱 워크로드와 그 앱만 쓰는 버킷은 경계 밖, 근거는 0.6 검토", () => {
  const { result } = normalizeV2(inv(mixed()));
  assert.deepEqual(ids(result), ["shop-api", "shop-assets", "shop-cleanup", "shop-web"]);
  assert.deepEqual(outs(result), ["k8s.deployment:blog-api", "s3.bucket:blog-media"]);
  assert.equal(result.outOfBoundary!.find((o) => o.resource === "k8s.deployment:blog-api")!.kind, "service");
  const m = result.fieldMeta["components.shop-api.appGroup"]!;
  assert.equal(m.source, `label:most-workloads:${P}=shop`);
  assert.equal(m.confidence, 0.6);
  assert.equal(m.needs_review, true);
  assert.match(m.rationale!, /3개/);
  assert.ok(!Object.keys(result.fieldMeta).some((k) => k.includes("blog")), "경계 밖 앱의 흔적이 fieldMeta 에 남음");
  assert.ok(!result.spec.links.some((l) => l.from === "blog-api"));
  assert.deepEqual(checkV2(result.spec).errors, []);
  assert.ok(ImportResultV2.safeParse(result).success);
});

test("정상: 작업 입력(partOf)으로 고르면 그 묶음만, 신뢰도 1 / 데이터 경계는 남은 워크로드 기준으로 다시 계산", () => {
  const { result } = normalizeV2(inv(mixed()), { partOf: "blog" });
  assert.deepEqual(ids(result), ["blog-api", "blog-media"]);
  assert.deepEqual(outs(result), ["k8s.cronjob:shop-cleanup", "k8s.deployment:shop-api", "k8s.deployment:shop-web", "s3.bucket:shop-assets"]);
  assert.deepEqual(result.fieldMeta["components.blog-api.appGroup"], { source: `input:partOf:${P}=blog`, confidence: 1, needs_review: false });
  // 같은 원본이면 같은 결과 (순서 바꿔도)
  assert.equal(JSON.stringify(normalizeV2(inv([...mixed()].reverse()), { partOf: "blog" }).result), JSON.stringify(result));
});

test("라벨 없음 → BOUNDARY v1 그대로 (k8s 의 맨 app 라벨은 묶음으로 안 씀), appGroup 근거도 안 생김", () => {
  const items = [dep("a-api", {}, [{ name: "B", value: "s3://a-bucket" }]), dep("b-api"), bucket("a-bucket"), bucket("unused")];
  const { result } = normalizeV2(inv(items), { partOf: "a-api" });
  assert.deepEqual(ids(result), ["a-api", "a-bucket", "b-api"]);
  assert.deepEqual(outs(result), ["s3.bucket:unused"]);
  assert.ok(!Object.keys(result.fieldMeta).some((k) => k.endsWith(".appGroup")));
});

test("거부·판단 불가: 입력 값과 맞는 묶음이 없으면 가장 많은 묶음 + 이유에 적음 / 라벨 없는 워크로드는 두고 검토 / 묶음이 전부 1개짜리면 한정 안 함", () => {
  const r1 = normalizeV2(inv([...mixed(), dep("legacy")]), { partOf: "nope" }).result;
  assert.deepEqual(ids(r1), ["legacy", "shop-api", "shop-assets", "shop-cleanup", "shop-web"]);
  assert.match(r1.fieldMeta["components.shop-web.appGroup"]!.rationale!, /입력한 앱 "nope"/);
  assert.equal(r1.fieldMeta["components.legacy.appGroup"]?.source, "label:none");
  assert.equal(r1.fieldMeta["components.legacy.appGroup"]?.needs_review, true);
  // Helm 흔한 모양: name 라벨이 워크로드마다 다름 → 고를 근거 없음, 아무것도 안 뺌
  const r2 = normalizeV2(inv([dep("x-api", { [N]: "x-api" }), dep("x-web", { [N]: "x-web" })])).result;
  assert.deepEqual(ids(r2), ["x-api", "x-web"]);
  assert.equal(r2.outOfBoundary, undefined);
  assert.match(r2.fieldMeta["components.x-api.appGroup"]!.rationale!, /한정하지 않음/);
  // part-of 가 name 보다 앞
  assert.deepEqual(appGroupOf({ name: "s", kind: "service", props: {}, meta: {}, native: { type: "k8s.deployment", name: "s", appLabels: { [N]: "s", [P]: "shop" } } }), [P, "shop"]);
  // Cloud Run 등 라벨에 "/" 못 쓰는 출발: part-of → app
  assert.deepEqual(appGroupOf({ name: "s", kind: "service", props: {}, meta: {}, native: { type: "cloudrun.service", name: "s", labels: { app: "shop" } } }), ["app", "shop"]);
  assert.equal(appGroupOf({ name: "s", kind: "service", props: {}, meta: {}, native: { type: "cloudrun.service", name: "s", labels: { team: "x" } } }), null);
});
