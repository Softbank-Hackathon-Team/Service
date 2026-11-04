// 온프레 리허설의 도착 파드 보안 수준(input.ts TARGET_POD_SECURITY)이 k3s 에 실제로 거는 정책과 같은지.
//   정책 = infra/permissions/onprem-kyverno-platform.yaml 의 platform-namespace-pod-security (managed-by=platform 네임스페이스)
//   그 표시를 도착 네임스페이스에 다는 곳 = infra/modules/onprem/kinds/namespace/main.tf
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseAllDocuments } from "yaml";
import { TARGET_POD_SECURITY } from "../src/rehearsal/input.js";

interface Policy {
  kind: string; metadata: { name: string };
  spec: { validationFailureAction: string; rules: Array<{
    match: { any: Array<{ resources: { namespaceSelector?: { matchLabels: Record<string, string> } } }> };
    validate: { podSecurity?: { level: string } };
  }> };
}
const repoFile = (p: string) => readFileSync(new URL(`../../../${p}`, import.meta.url), "utf8");

test("온프레 k3s: 리허설 파드 보안 = Kyverno 정책 수준(Enforce), 정책 대상 표시 managed-by=platform 을 도착 네임스페이스가 단다", () => {
  const policy = parseAllDocuments(repoFile("infra/permissions/onprem-kyverno-platform.yaml"))
    .map((d) => d.toJS() as Policy).find((d) => d?.kind === "ClusterPolicy" && d.metadata.name === "platform-namespace-pod-security");
  assert.ok(policy, "platform-namespace-pod-security 정책이 없다");
  assert.equal(policy.spec.validationFailureAction, "Enforce");
  const rules = policy.spec.rules.filter((r) => r.validate.podSecurity);
  assert.ok(rules.length > 0, "podSecurity 규칙이 없다");
  for (const r of rules) {
    assert.equal(r.validate.podSecurity!.level, TARGET_POD_SECURITY["onprem-k3s"]);
    assert.deepEqual(r.match.any.map((m) => m.resources.namespaceSelector?.matchLabels), [{ "managed-by": "platform" }]);
  }
  assert.match(repoFile("infra/modules/onprem/kinds/namespace/main.tf"), /labels\s*=\s*\{[^}]*"managed-by"\s*=\s*"platform"/);
});
