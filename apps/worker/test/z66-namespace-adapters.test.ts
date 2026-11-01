// Z66: Terraform 어댑터 4개가 만드는 구역(k8s_namespace) = gitops 묶음 구역. 둘이 다시 갈라지면 여기서 잡는다 (맥: npx tsx --test)
import { test } from "node:test";
import assert from "node:assert/strict";
import { AppSpec, Provider, type TargetEnv } from "@svc/contracts";
import { adapterFor, DEMO_INVENTORY } from "@svc/adapters";
import { appNamespace, ENV_DIR } from "../src/gitops/bundle.js";

test("Z66 어댑터 k8s_namespace = gitops appNamespace (4개 환경)", () => {
  for (const p of Provider.options) {
    const src = p === "azure_mock" ? "aws" : p;
    const spec = AppSpec.parse(adapterFor(src).normalize(DEMO_INVENTORY[src]).spec);
    const t = { envId: "33333333-3333-4333-8333-333333333333", provider: p, region: "default" } as TargetEnv;
    const { vars } = adapterFor(p).toTerraform(spec, t);
    assert.equal(vars.k8s_namespace, appNamespace({ tenant: "t-33333333", app: spec.app.name, env: ENV_DIR[p] }), p);
  }
});
