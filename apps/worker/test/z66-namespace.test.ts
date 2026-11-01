// Z66: 구역 이름 한 벌 맞추기. gitops 묶음 target.namespace·울타리 = Terraform 어댑터 k8s_namespace (app-<앱>)
import { test } from "node:test";
import assert from "node:assert/strict";
import { appNamespace, fenceDoc, planFile, ENV_DIR, APP_NS_PREFIX, type BundleRef } from "../src/gitops/bundle.js";

const envs = Object.values(ENV_DIR);

test("Z66 묶음 구역 이름 = app-<앱> (환경·회사와 무관)", () => {
  for (const env of envs) {
    for (const tenant of ["t-1a2b3c4d", "t-9f8e7d6c"]) {
      assert.equal(appNamespace({ tenant, app: "guestbook", env }), "app-guestbook", `${tenant}/${env}`);
    }
  }
});

test("Z66 울타리 목적지는 회사 클러스터 이름 + app-* 구역", () => {
  const f = fenceDoc("t-1a2b3c4d", "https://example.invalid/r.git", ["t-1a2b3c4d-gcp-gke", "t-1a2b3c4d-aws-eks", "t-1a2b3c4d-aws-eks"]);
  assert.deepEqual(f.spec.destinations, [
    { name: "t-1a2b3c4d-aws-eks", namespace: `${APP_NS_PREFIX}*` },
    { name: "t-1a2b3c4d-gcp-gke", namespace: `${APP_NS_PREFIX}*` },
  ]);
  for (const d of f.spec.destinations) assert.ok(d.name.startsWith("t-1a2b3c4d-"), "회사 구분은 클러스터 이름이 한다");
});

test("Z66 plan.json target.namespace 가 울타리 구역 안에 든다", () => {
  const b: BundleRef = { tenant: "t-1a2b3c4d", app: "guestbook", env: "aws-eks" };
  const plan = { migrationId: "m", planId: "p", planHash: "h", adapterVersion: "aws@0.5.0", steps: [] } as never;
  const pf = planFile(b, plan, "0.3.0");
  const fence = fenceDoc(b.tenant, "https://example.invalid/r.git", [pf.target.cluster!]);
  const ok = fence.spec.destinations.some((d) => d.name === pf.target.cluster && pf.target.namespace.startsWith(d.namespace.replace(/\*$/, "")));
  assert.ok(ok, `${pf.target.cluster}/${pf.target.namespace} 가 울타리 밖`);
});
