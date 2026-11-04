// Z66: 도착 Builder 4개가 만드는 구역(k8s_namespace) = gitops 묶음 구역. 둘이 다시 갈라지면 여기서 잡는다 (맥: npx tsx --test)
import { test } from "node:test";
import assert from "node:assert/strict";
import { Provider, type TargetEnv } from "@svc/contracts";
import { targetBuilderFor, DEMO_SPEC } from "@svc/adapters";
import { appNamespace, ENV_DIR } from "../src/gitops/bundle.js";

// azure mock 은 신원 1개만 그린다 → 서비스 하나(shop-api) + 데이터 자원만 남긴 판
const ONE = (() => {
  const keep = (id: string) => { const c = DEMO_SPEC.components.find((x) => x.id === id)!; return (c.kind !== "service" && c.kind !== "job") || id === "shop-api"; };
  return { ...DEMO_SPEC, components: DEMO_SPEC.components.filter((c) => keep(c.id)),
    links: DEMO_SPEC.links.filter((l) => keep(l.from) && (typeof l.to !== "string" || keep(l.to))), entry: undefined };
})();

test("Z66 Builder k8s_namespace = gitops appNamespace (4개 환경)", () => {
  for (const p of Provider.options) {
    const t = { envId: "33333333-3333-4333-8333-333333333333", provider: p, region: "default",
      tenantId: "11111111-1111-4111-8111-111111111111", migrationId: "22222222-2222-4222-8222-222222222222" } as TargetEnv;
    const { vars } = targetBuilderFor(p).toTerraformV2(p === "azure_mock" ? ONE as never : DEMO_SPEC, t as never);
    assert.equal(vars.k8s_namespace, appNamespace({ tenant: "t-33333333", app: DEMO_SPEC.app.name, env: ENV_DIR[p] }), p);
  }
});
