import { test } from "node:test";
import assert from "node:assert/strict";
import { AppSpec, VALID, MIGRATION_STATUSES, TERMINAL } from "../src/index.js";

const good = {
  schemaVersion: "1",
  app: { name: "shop-api" },
  service: {
    image: "registry/shop@sha256:" + "a".repeat(64),
    port: 8080, healthPath: "/healthz", replicas: 2,
    cpu: "500m", memory: "1Gi", env: [], secretRefs: [],
  },
  database: { engine: "postgres", majorVersion: "16", storageGb: 20 },
  ingress: { hostname: "shop.example.com", entry: "cloudflare-lb" },
};

test("AppSpec: 정상 명세는 통과", () => {
  assert.equal(AppSpec.safeParse(good).success, true);
});
test("AppSpec: 태그 이미지는 거부", () => {
  const bad = structuredClone(good);
  bad.service.image = "registry/shop:v1";
  assert.equal(AppSpec.safeParse(bad).success, false);
});
test("AppSpec: 모르는 칸은 거부 (strict)", () => {
  const bad = { ...good, extra: 1 };
  assert.equal(AppSpec.safeParse(bad).success, false);
});
test("상태 22개, 전이 54개, 최종 3개는 나가는 길 없음", () => {
  assert.equal(MIGRATION_STATUSES.length, 22);
  const n = Object.values(VALID).reduce((a, v) => a + v.length, 0);
  assert.equal(n, 53);   // Z61 의 provisioning → paused 는 Z38 REVIEW-4 Z43-1 로 뺌 (재발급 실패도 failed)
  for (const s of TERMINAL) assert.equal(VALID[s].length, 0);
});
test("전이 목적지는 모두 실제 상태", () => {
  for (const to of Object.values(VALID).flat())
    assert.ok(MIGRATION_STATUSES.includes(to));
});
