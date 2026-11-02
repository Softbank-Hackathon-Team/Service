import type { AppSpec, EnvironmentAdapter, TfOutputs } from "@svc/contracts";
import { actionsFor, type PermTable, type Purpose } from "../common/actions.js";
import { appNamespace, sourceImport, moduleRefOf, platformImageRef } from "../common/base.js";
import { buildValues } from "../common/k8s-values.js";
import { envRef, regionOf, tenantOf, type Target } from "../common/target.js";

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

export function resourceTypes(spec: AppSpec): string[] {
  const r = ["core/namespaces", "core/resourcequotas", "networking.k8s.io/networkpolicies",
    "apps/deployments", "core/services", "core/serviceaccounts"];
  if (spec.service.secretRefs.length) r.push("external-secrets.io/externalsecrets");
  if (spec.database) r.push("postgresql.cnpg.io/clusters");
  return r.sort();
}
export const operateActions = (spec: AppSpec, purpose: Purpose) => actionsFor(PERMS, resourceTypes(spec), purpose);

const MEM_MI: Record<string, number> = { "512Mi": 512, "1Gi": 1024, "2Gi": 2048 };
const CPU_M: Record<string, number> = { "250m": 250, "500m": 500, "1": 1000 };

export const onpremAdapter: EnvironmentAdapter = {
  provider: "onprem",
  version: "onprem@0.3.0",
  // DRAFT(ai): 노드 CPU 종류는 연결 때 Agent가 보고해야 한다. 지금은 amd64 고정
  capabilities: () => ["workload.container", "arch.amd64", "ingress.cloudflared",
    "secrets.external", "db.postgres.15", "db.postgres.16", "db.postgres.17", "db.cnpg"],
  // Z88: 진짜 읽기 = kubectl --context ONPREM_KUBE_CONTEXT 로 노드·앱·CNPG. MOCK_SEED=1 이면 데모 원본
  ...sourceImport("onprem"),
  requiredOperateActions: (spec) => operateActions(spec, "apply"),
  imageRef: (src: string, t: Target) => platformImageRef(t.registryHost ?? envRef("registryHost"), t, src),
  toTerraform(spec, t: Target) {
    const ns = appNamespace(spec);
    // 할당량 = 레플리카 × 요청량 × 2 (롤링 업데이트 여유) + DB
    const cpu = CPU_M[spec.service.cpu]! * spec.service.replicas * 2 + (spec.database ? 1000 : 0);
    const mem = MEM_MI[spec.service.memory]! * spec.service.replicas * 2 + (spec.database ? 2048 : 0);
    return {
      moduleRef: moduleRefOf("onprem/app", t),
      vars: {
        kube_context: regionOf(t) === "local" ? "k3s-onprem" : regionOf(t),
        app_name: spec.app.name,
        tenant_id: tenantOf(t),
        k8s_namespace: ns,
        quota_cpu_m: cpu,
        quota_memory_mi: mem,
        db_enabled: Boolean(spec.database),
        db_storage_gb: spec.database?.storageGb ?? 0,
      },
    };
  },
  toHelmValues(spec, _out: TfOutputs, t: Target) {
    return buildValues(spec, {
      tenant: tenantOf(t),
      imageRef: onpremAdapter.imageRef(spec.service.image, t),
      // DRAFT(ai): 온프레 시크릿 저장소 = Vault (ESO ClusterSecretStore 이름)
      secretStore: { kind: "ClusterSecretStore", name: "vault" },
      database: spec.database ? {
        mode: "cnpg",
        instances: 1,                        // DRAFT(ai): 노트북 1노드라 1개
        majorVersion: spec.database.majorVersion,
        storageGb: spec.database.storageGb,
        // CNPG가 만드는 접속 서비스 이름 규칙: <cluster>-rw
        host: `${spec.app.name}-db-rw`, port: 5432, name: spec.app.name,
        passwordSecret: `${spec.app.name}-db-app`,
      } : null,
    });
  },
};
