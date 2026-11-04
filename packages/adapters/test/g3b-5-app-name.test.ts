// G3b-5: 앱 이름을 "이름순 첫 서비스 id"로만 정하지 않는다. 입력 → 앞 판(사람이 고친 것 먼저) → 앱 묶음 값 → 첫 서비스(검토) 순
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeV2 } from "../src/import/pipeline.js";
import { DIGEST } from "./fake-cli.js";

const dep = (name: string, partOf?: string) => ({ kind: "k8s.deployment", imageDigest: DIGEST("a"),
  metadata: { name, namespace: "shop", ...(partOf ? { labels: { "app.kubernetes.io/part-of": partOf } } : {}) },
  spec: { replicas: 1, selector: { matchLabels: { app: name } }, template: { metadata: { labels: { app: name } }, spec: { containers: [{ name, image: `x/${name}:1` }] } } } });
const inv = (...items: unknown[]) => ({ provider: "onprem" as const, items, coverage: {} });

test("G3b-5: 아무 근거가 없으면 첫 서비스 id 지만 검토 줄(신뢰도 0.6)", () => {
  const r = normalizeV2(inv(dep("api"), dep("web"))).result;
  assert.equal(r.spec.app.name, "api");
  assert.equal(r.fieldMeta["app.name"]?.needs_review, true);
});

test("G3b-5: 입력(sourceScope.appName)이 있으면 그것, 확신 1", () => {
  const r = normalizeV2(inv(dep("api"), dep("web")), { appName: "shop" }).result;
  assert.equal(r.spec.app.name, "shop");
  assert.equal(r.fieldMeta["app.name"]?.needs_review, false);
});

test("G3b-5: 앱 묶음 라벨 값이 첫 서비스보다 먼저", () => {
  const r = normalizeV2(inv(dep("api", "shop"), dep("web", "shop"))).result;
  assert.equal(r.spec.app.name, "shop");
});

test("G3b-5: 다시 가져올 때 새 Deployment(admin)가 생겨도 앞 판 이름을 이어받는다 / 사람이 고친 이름은 입력보다도 먼저", () => {
  const prev = { name: "api", meta: { source: "input:appName", confidence: 1 as const, needs_review: false } };
  const r = normalizeV2(inv(dep("admin"), dep("api")), { previousApp: prev }).result;
  assert.equal(r.spec.app.name, "api");
  const human = normalizeV2(inv(dep("admin"), dep("api")), { appName: "shop", previousApp: { name: "my-shop", meta: { source: "human", confidence: 1, needs_review: false } } }).result;
  assert.equal(human.spec.app.name, "my-shop");
});

test("G3b-5: 앞 판이 검토 전(첫 서비스 추측)이었으면 이어받아도 검토 표시가 남는다", () => {
  const first = normalizeV2(inv(dep("api"))).result;
  const again = normalizeV2(inv(dep("admin"), dep("api")), { previousApp: { name: first.spec.app.name, meta: first.fieldMeta["app.name"] } }).result;
  assert.equal(again.spec.app.name, "api");
  assert.equal(again.fieldMeta["app.name"]?.needs_review, true);
});
