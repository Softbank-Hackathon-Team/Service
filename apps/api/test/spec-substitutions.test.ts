// 명세 검토 화면의 상품 대체 미리보기 (GET /migrations/:id/spec 의 substitutions 를 만드는 순수 함수)
import { test } from "node:test";
import assert from "node:assert/strict";
import { AppSpecV2 } from "@svc/contracts";
import { specSubstitutions } from "../src/routes/spec.js";

const spec = AppSpecV2.parse({ schemaVersion: "2", app: { name: "shop" },
  components: [
    { id: "shop", kind: "service", props: { runtime: "k8s", origin: { runtime: "k8s", product: "unknown" },
      image: { source: "registry", repository: "r/shop", digest: "sha256:" + "a".repeat(64) }, ports: [{ port: 8080, protocol: "TCP" }],
      replicas: { min: 1, max: 1 }, serviceAccount: "default", resources: { request: { cpuMilli: 500, memMiB: 1024 } }, env: [] } },
    { id: "shop-db", kind: "postgres", props: { majorVersion: "16", storageGb: 20 } },
    { id: "shop-cache", kind: "cache", props: { engine: "redis", memoryMiB: 1024, tls: false, auth: false } },
  ],
  links: [{ from: "shop", to: "shop-db", intent: "connect" }, { from: "shop", to: "shop-cache", intent: "connect" }],
  posture: { permissions: [], network: [] } });
const pairs = (rows: ReturnType<typeof specSubstitutions>) => rows.map((r) => [r.kind, r.subject, r.from, r.to]);

test("AWS 출발 RDS·ElastiCache 를 GCP 로 → 대체 2줄 (자원 id 순)", () => {
  assert.deepEqual(pairs(specSubstitutions(spec, { source: "aws", target: "gcp" })), [
    ["substitute", "shop-cache", "ElastiCache (redis)", "Memorystore (redis)"],
    ["substitute", "shop-db", "RDS for PostgreSQL", "Cloud SQL for PostgreSQL"],
  ]);
});

test("같은 클라우드·환경 모름 → 0줄", () => {
  assert.deepEqual(specSubstitutions(spec, { source: "gcp", target: "gcp" }), []);
  assert.deepEqual(specSubstitutions(spec, { source: "aws", target: "aws" }), []);
  assert.deepEqual(specSubstitutions(spec, undefined), []);
});

test("계산이 실패하면 빈 배열 (명세 GET 을 막지 않음)", () => {
  assert.deepEqual(specSubstitutions({} as AppSpecV2, { source: "aws", target: "gcp" }), []);
});
