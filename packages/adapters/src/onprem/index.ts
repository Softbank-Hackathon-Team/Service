import type { EnvironmentAdapter } from "@svc/contracts";
import { actionsFor, type PermTable, type Purpose } from "../common/actions.js";
import { sourceImport, platformImageRef, type PermNeeds } from "../common/base.js";
import { envRef, type Target } from "../common/target.js";

// 온프레(k3s): 클라우드 API가 없다. Terraform은 kubernetes 공급자로 네임스페이스·할당량·네트워크 정책만 만든다.
// DB는 CloudNativePG Cluster를 같은 Helm 차트가 만든다 (database.mode=cnpg).
// 권한은 k8s RBAC "그룹/자원:동사". 확인은 SelfSubjectAccessReview(= kubectl auth can-i)
const RBAC: Record<string, { read: string[]; write: string[]; remove: string[] }> = {
  "core/namespaces": { read: ["get"], write: ["create", "patch"], remove: ["delete"] },
  "core/resourcequotas": { read: ["get"], write: ["create", "patch"], remove: ["delete"] },
  "networking.k8s.io/networkpolicies": { read: ["get"], write: ["create", "patch"], remove: ["delete"] },
  "apps/deployments": { read: ["get", "list"], write: ["create", "patch"], remove: ["delete"] },
  "core/services": { read: ["get", "list"], write: ["create", "patch"], remove: ["delete"] },
  "core/serviceaccounts": { read: ["get"], write: ["create", "patch"], remove: ["delete"] },
  "external-secrets.io/externalsecrets": { read: ["get"], write: ["create", "patch"], remove: ["delete"] },
  "postgresql.cnpg.io/clusters": { read: ["get"], write: ["create", "patch"], remove: ["delete"] },
};
export const PERMS: PermTable = Object.fromEntries(Object.entries(RBAC).map(([r, v]) => [r, {
  read: v.read.map((x) => `${r}:${x}`), write: v.write.map((x) => `${r}:${x}`), remove: v.remove.map((x) => `${r}:${x}`),
}]));

export function resourceTypes(need: PermNeeds): string[] {
  const r = ["core/namespaces", "core/resourcequotas", "networking.k8s.io/networkpolicies",
    "apps/deployments", "core/services", "core/serviceaccounts"];
  if (need.secrets) r.push("external-secrets.io/externalsecrets");
  if (need.database) r.push("postgresql.cnpg.io/clusters");
  return r.sort();
}
export const operateActions = (need: PermNeeds, purpose: Purpose) => actionsFor(PERMS, resourceTypes(need), purpose);

export const onpremAdapter: EnvironmentAdapter = {
  provider: "onprem",
  version: "onprem@0.3.0",
  // DRAFT(ai): 노드 CPU 종류는 연결 때 Agent가 보고해야 한다. 지금은 amd64 고정
  capabilities: () => ["workload.container", "arch.amd64", "ingress.cloudflared",
    "secrets.external", "db.postgres.15", "db.postgres.16", "db.postgres.17", "db.cnpg"],
  // Z88: 진짜 읽기 = kubectl --context ONPREM_KUBE_CONTEXT 로 노드·앱·CNPG. MOCK_SEED=1 이면 데모 원본
  ...sourceImport("onprem"),
  imageRef: (src: string, t: Target) => platformImageRef(t.registryHost ?? envRef("registryHost"), t, src),
};
