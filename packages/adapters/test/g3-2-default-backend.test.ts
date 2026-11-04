// G3-2: Ingress defaultBackend 를 discover 가 읽어 매퍼까지 이어진다 (discover → normalizeV2 이어 붙인 시험)
import { test } from "node:test";
import assert from "node:assert/strict";
import { discoverOnprem } from "../src/discover/index.js";
import { normalizeV2 } from "../src/import/pipeline.js";
import { fakeExec, onpremApp } from "./fake-cli.js";

const ingress = (spec: unknown) => [/^kubectl get ingresses/, { out: { items: [{ metadata: { name: "shop", namespace: "shop" }, spec }] } }] as [RegExp, { out: unknown }];

test("G3-2: rules(/api) + defaultBackend → 그 호스트에 마지막 '/' 줄이 생긴다", async () => {
  const { exec } = fakeExec(onpremApp([ingress({ defaultBackend: { service: { name: "shop-api", port: { number: 80 } } },
    rules: [{ host: "shop.example.com", http: { paths: [{ path: "/api", pathType: "Prefix", backend: { service: { name: "shop-api", port: { number: 80 } } } }] } }] })]));
  const inv = await discoverOnprem({ exec, env: {} });
  const raw = inv.items.find((i) => (i as { kind: string }).kind === "k8s.ingress") as { spec: { defaultBackend?: { service?: { name: string } } } };
  assert.equal(raw.spec.defaultBackend?.service?.name, "shop-api", "discover 가 defaultBackend 를 담음");
  const r = normalizeV2(inv).result;
  const host = r.spec.entry?.hosts.find((h) => h.hostnames.includes("shop.example.com"));
  assert.deepEqual(host?.routes.map((x) => x.matches[0]?.path.value), ["/api", "/"]);
});

test("G3-2: defaultBackend 만 있는 Ingress(호스트 없음)는 조용히 사라지지 않고 unmapped B", async () => {
  const { exec } = fakeExec(onpremApp([ingress({ defaultBackend: { service: { name: "shop-api", port: { number: 80 } } } })]));
  const r = normalizeV2(await discoverOnprem({ exec, env: {} })).result;
  assert.ok(r.unmapped.some((u) => u.resource === "k8s.ingress.defaultBackend:shop" && u.grade === "B"));
});

test("G3-2: resource 백엔드(버킷 등)는 지어내지 않고 unmapped B", async () => {
  const { exec } = fakeExec(onpremApp([ingress({ defaultBackend: { resource: { apiGroup: "k8s.example.com", kind: "StorageBucket", name: "static" } },
    rules: [{ host: "shop.example.com", http: { paths: [{ path: "/", pathType: "Prefix", backend: { service: { name: "shop-api", port: { number: 80 } } } }] } }] })]));
  const r = normalizeV2(await discoverOnprem({ exec, env: {} })).result;
  assert.ok(r.unmapped.some((u) => u.resource === "k8s.ingress.defaultBackend" && /resource/.test(u.reason)));
});
