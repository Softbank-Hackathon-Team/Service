// E10-1: 앱 이름은 명세 app.name 하나. 입력 → 고른 앱 묶음 라벨 값 → 첫 서비스 id. 사람이 PATCH "app" 으로 고친다
import { test } from "node:test";
import assert from "node:assert/strict";
import { AppSpecV2, SpecPatchInput, type RawInventory } from "@svc/contracts";
import { applySpecV2Patch } from "@svc/core";
import { normalizeV2 } from "@svc/adapters";

const D = "sha256:" + "ab".repeat(32);
const dep = (name: string, partOf?: string) => ({
  kind: "k8s.deployment", imageDigest: D,
  metadata: { name, namespace: "shop", labels: { app: name, ...(partOf ? { "app.kubernetes.io/part-of": partOf } : {}) } },
  spec: { replicas: 1, selector: { matchLabels: { app: name } }, template: { metadata: { labels: { app: name } }, spec: { containers: [{ name, image: `ghcr.io/demo/${name}:1` }] } } },
});
const inv = (items: unknown[]): RawInventory => ({ provider: "onprem", coverage: {}, items: items as RawInventory["items"] });

test("정상: part-of=shop 묶음이면 앱 이름은 shop (첫 서비스 id shop-api 가 아님), 묶음 입력도 같다", () => {
  const r = normalizeV2(inv([dep("shop-web", "shop"), dep("shop-api", "shop")])).result;
  assert.equal(r.spec.app.name, "shop");
  assert.equal(r.fieldMeta["app.name"]?.confidence, 0.9);   // G3b-5 (팀 결정): 묶음 라벨 값은 0.9 + 검토
  assert.equal(normalizeV2(inv([dep("shop-web", "shop"), dep("x-api", "x"), dep("x-web", "x")]), { partOf: "shop" }).result.spec.app.name, "shop");
  const plain = normalizeV2(inv([dep("web"), dep("api")])).result;
  assert.equal(plain.spec.app.name, "api");
  assert.equal(plain.fieldMeta["app.name"]?.confidence, 0.6, "근거 약함 표시");   // G3b-5: 첫 서비스 = 0.6 + 검토
  assert.equal(plain.fieldMeta["app.name"]?.needs_review, true);
});

test("PATCH app.name (G3b-5 경로): 사람이 이름을 고치면 표시가 사람 것, 모양이 틀린 이름은 AppSpec 검사에서 막힘", () => {
  const r = normalizeV2(inv([dep("web"), dep("api")])).result;
  assert.ok(SpecPatchInput.safeParse({ baseVersion: 1, changes: [{ path: "app.name", value: "shop" }] }).success);
  const next = applySpecV2Patch({ spec: r.spec, fieldMeta: r.fieldMeta }, { changes: [{ path: "app.name", value: "shop" }] });
  assert.equal(AppSpecV2.parse(next.spec).app.name, "shop");
  assert.equal((next.fieldMeta["app.name"] as { source: string }).source, "human");
  const bad = applySpecV2Patch({ spec: r.spec, fieldMeta: r.fieldMeta }, { changes: [{ path: "app.name", value: "Shop_App" }] });
  assert.equal(AppSpecV2.safeParse(bad.spec).success, false);
  assert.equal(SpecPatchInput.safeParse({ baseVersion: 1, changes: [{ path: "app", value: { name: "x" } }] }).success, false);   // 통째 "app" 은 G3b-5 에서 안 받음
});
