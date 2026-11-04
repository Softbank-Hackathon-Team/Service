// PF-A16 (23회차 보안 감사): 출발에서 온 이름(api-resources 의 CRD 이름, HTTPRoute parentRefs 의 Gateway 이름)이
//   "--…" 처럼 kubectl 옵션 모양이면 위치 인자로 넘기지 않는다 (예: --filename=/app/.env, --server=…)
import { test } from "node:test";
import assert from "node:assert/strict";
import { discoverAws } from "../src/discover/index.js";
import { normalizeV2 } from "../src/import/pipeline.js";
import { pfExec, PF_NS } from "./pf-a-eks-demo-fixture.js";

const route = (parent: { name: string; namespace?: string }) => ({ kind: "httproutes.gateway.networking.k8s.io", o: {
  metadata: { name: "shop-route", namespace: PF_NS }, spec: { parentRefs: [{ ...parent }], rules: [{ backendRefs: [{ name: "shop-web", port: 80 }] }] } } });
const run = async (apiResources: string[], extraObjs: Array<{ kind: string; o: Record<string, unknown> }> = []) => {
  const x = pfExec({ apiResources, extraObjs });
  const r = normalizeV2(await discoverAws({ exec: x.exec, env: { IMPORT_NAMESPACE: PF_NS } }, { iam: true })).result;
  return { calls: x.calls, r };
};
const GW = ["gateways.gateway.networking.k8s.io", "httproutes.gateway.networking.k8s.io"];

test("PF-A16: 옵션 모양 CRD 이름·Gateway 이름은 kubectl 인자로 안 감 + 못 읽음 검토 줄", async () => {
  const { calls, r } = await run([...GW, "--filename=/app/.env", "-f"], [route({ name: "--raw=/api/v1/secrets", namespace: "edge" })]);
  const bad = calls.filter((c) => c.startsWith("kubectl") && /\s(--filename|--raw|-f)(=|\s|$)/.test(c));
  assert.deepEqual(bad, []);
  assert.equal(r.fieldMeta["unread.Gateway"]?.needs_review, true);
});

test("PF-A16 거부 쪽: 보통 이름의 Gateway 는 그대로 읽으러 감", async () => {
  const { calls } = await run(GW, [route({ name: "shared-gw", namespace: "edge" })]);
  assert.ok(calls.some((c) => c.startsWith("kubectl get gateways.gateway.networking.k8s.io shared-gw -n edge")), calls.filter((c) => c.includes("gateway")).join("\n"));
});
