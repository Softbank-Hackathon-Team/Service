// INCL + C StatefulSet IR: StatefulSet 으로 띄운 redis 도 클러스터 안 캐시로 알아봄. 도착 차트 렌더(SS-1)는 아직 없어 계획에서 막힘(조용히 안 넘김)
import { test } from "node:test";
import assert from "node:assert/strict";
import { AppSpecV2, checkV2, type RawInventory } from "@svc/contracts";
import { normalizeV2 } from "../src/import/pipeline.js";
import { requirementsV2, v2Blockers, targetBuilderFor } from "../src/index.js";

type Raw = Record<string, any>;
const D = "sha256:" + "ef".repeat(32);
const NS = "shop";
const sts = (name: string, image: string): Raw => ({
  kind: "k8s.statefulset", imageDigest: D, metadata: { name, namespace: NS, labels: { app: name } },
  spec: { replicas: 3, serviceName: `${name}-hl`, selector: { matchLabels: { app: name } },
    template: { metadata: { labels: { app: name } }, spec: { containers: [{ name, image, ports: [{ containerPort: 6379 }],
      volumeMounts: [{ name: "data", mountPath: "/data" }] }] } },
    volumeClaimTemplates: [{ name: "data", accessModes: ["ReadWriteOnce"], storage: "8Gi" }] },
});
const api: Raw = { kind: "k8s.deployment", imageDigest: D, metadata: { name: "api", namespace: NS, labels: { app: "api" } },
  spec: { replicas: 1, selector: { matchLabels: { app: "api" } }, template: { metadata: { labels: { app: "api" } }, spec: { containers: [{ name: "api",
    image: "ghcr.io/demo/api:1.0", ports: [{ containerPort: 8080 }], env: [{ name: "REDIS_HOST", value: "cache-hl.shop.svc.cluster.local" }] }] } } } };
const hl: Raw = { kind: "k8s.service", metadata: { name: "cache-hl", namespace: NS }, spec: { type: "ClusterIP", clusterIP: "None", selector: { app: "cache" },
  ports: [{ port: 6379, targetPort: 6379, protocol: "TCP" }] } };
const inv = (items: Raw[]): RawInventory => ({ provider: "onprem", coverage: {}, items } as unknown as RawInventory);

test("INCL: StatefulSet redis → 클러스터 안 캐시 + 앱 링크 + 데이터 복사 검토, 관리형 캐시는 요구 안 함", () => {
  const { result } = normalizeV2(inv([api, sts("cache", "redis:7.2"), hl]));
  const spec = AppSpecV2.parse(result.spec);
  const twin = spec.components.find((c) => c.kind === "cache")!;
  assert.deepEqual((twin.props as Raw).inCluster, { workload: "cache", product: "redis" });
  assert.ok(spec.links.some((l) => l.from === "api" && l.to === twin.id && l.intent === "connect"), JSON.stringify(spec.links));
  assert.equal(result.fieldMeta[`components.${twin.id}.dataCopy`]?.needs_review, true);
  assert.deepEqual(checkV2(spec).errors, []);
  assert.ok(!requirementsV2(spec).some((r) => r.startsWith("kind.cache")));
});

test("INCL 거부: 도착이 StatefulSet 을 못 그리면 계획에서 workload.statefulset 으로 막힘 (Deployment 로 바꿔 그리지 않음)", () => {
  const spec = AppSpecV2.parse(normalizeV2(inv([api, sts("cache", "redis:7.2"), hl])).result.spec);
  const caps = targetBuilderFor("onprem").capabilities().filter((c) => c !== "workload.statefulset");
  const b = v2Blockers(spec, caps);
  assert.ok(b.unsupported.some((x) => /workload\.statefulset/.test(x)), b.unsupported.join());
});

test("INCL 정상: 차트가 StatefulSet 을 그리면(d-on-04 렌더) workload.statefulset 으로 막히지 않음", () => {
  const spec = AppSpecV2.parse(normalizeV2(inv([api, sts("cache", "redis:7.2"), hl])).result.spec);
  const b = v2Blockers(spec, targetBuilderFor("onprem").capabilities());
  assert.ok(!b.unsupported.some((x) => /workload\.statefulset/.test(x)), b.unsupported.join());
});
