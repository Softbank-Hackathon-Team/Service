// PF-A11 (13회차 고객 관점): 가져오기가 남긴 검토 키는 전부 PATCH confirm 경로 모양(SpecConfirmPath)에 맞아야 한다.
//   예전: 못 읽은 CRD·Gateway 키에 빈칸("unread.CRD policyendpoints.networking.k8s.aws") → confirm 400 → 확인 못 해 spec_review 에서 못 나감
//   (EKS 관찰 정책 AmazonEKSViewPolicy 는 VPC CNI 의 PolicyEndpoint 같은 CRD 목록을 못 읽는다)
import { test } from "node:test";
import assert from "node:assert/strict";
import { SpecConfirmPath, checkV2Reviews, syncCheckReviews } from "@svc/contracts";
import { discoverAws } from "../src/discover/index.js";
import { normalizeV2 } from "../src/import/pipeline.js";
import { pfExec } from "./pf-a-eks-demo-fixture.js";

const DENY = "Error from server (Forbidden): policyendpoints.networking.k8s.aws is forbidden: User cannot list resource";
const keysOf = async (o: Parameters<typeof pfExec>[0]) => {
  const r = normalizeV2(await discoverAws({ exec: pfExec(o).exec, env: {} }, { iam: true })).result;
  const fm = syncCheckReviews(r.fieldMeta, checkV2Reviews(r.spec));
  return Object.keys(fm).filter((k) => fm[k]!.needs_review);
};

test("PF-A11: 못 읽은 CRD 키에 빈칸 없음 → confirm 경로로 확인 가능", async () => {
  const keys = await keysOf({ apiResources: ["pods", "policyendpoints.networking.k8s.aws"],
    fail: (l) => l.startsWith("kubectl get policyendpoints.networking.k8s.aws") ? { code: 1, err: DENY } : null });
  assert.ok(keys.includes("unread.CRD"), keys.join(","));   // PF-A15 뒤: 못 읽은 CRD 는 한 줄
  for (const k of keys) assert.ok(SpecConfirmPath.safeParse(k).success, `confirm 못 함: ${k}`);
});

test("PF-A11: 여러 읽기 실패를 섞어도 모든 검토 키가 confirm 경로 모양", async () => {
  const keys = await keysOf({ apiResources: ["policyendpoints.networking.k8s.aws"],
    fail: (l) => /get (clusterrolebindings|policyendpoints)|describe-cache-clusters|list-hosted-zones|describe-nat-gateways/.test(l) ? { code: 1, err: DENY } : null });
  assert.ok(keys.length > 3);
  for (const k of keys) assert.ok(SpecConfirmPath.safeParse(k).success, `confirm 못 함: ${k}`);
});

test("PF-A11 거부 쪽: 빈칸이 있는 키는 confirm 경로가 막는다(계약은 그대로)", () => {
  assert.equal(SpecConfirmPath.safeParse("unread.CRD policyendpoints.networking.k8s.aws").success, false);
});

// PF-A15 (21회차 대용량): 못 읽은 CRD 는 종류·네임스페이스가 많아도 검토 줄 하나 (이름은 이유 글에)
test("PF-A15: 못 읽은 CRD 3종 × 네임스페이스 2개 → unread.CRD 한 줄, 이유에 종류 이름", async () => {
  const r = normalizeV2(await discoverAws({ exec: pfExec({ apiResources: ["c.example.io", "a.example.io", "b.example.io"],
    fail: (l) => /get [abc]\.example\.io/.test(l) ? { code: 1, err: DENY } : null }).exec, env: { IMPORT_NAMESPACE: "real-app,app-demo" } }, { iam: true })).result;
  const crd = Object.keys(r.fieldMeta).filter((k) => k.startsWith("unread.CRD"));
  assert.deepEqual(crd, ["unread.CRD"]);
  assert.match(String(r.fieldMeta["unread.CRD"]!.rationale), /CRD 3종.*a\.example\.io, b\.example\.io, c\.example\.io/);
});

test("PF-A15 거부 쪽: CRD 를 다 읽으면 unread.CRD 없음", async () => {
  const r = normalizeV2(await discoverAws({ exec: pfExec({ apiResources: ["a.example.io"] }).exec, env: {} }, { iam: true })).result;
  assert.equal(Object.keys(r.fieldMeta).some((k) => k.startsWith("unread.CRD")), false);
});
