import type { AppSpec, EnvironmentAdapter, TfOutputs } from "@svc/contracts";
import { appNamespace, dbInstanceName, sourceImport, moduleRefOf, platformImageRef } from "../common/base.js";
import { buildValues } from "../common/k8s-values.js";
import { boundedName } from "../common/names.js";
import { envRef, fromOut, nameSeed, regionOf, tenantOf, type Target } from "../common/target.js";

// Azure: 실계정 없음(아키텍처 전제: 모양 + Mock). 번역 함수는 진짜 코드,
// infra/modules/azure/app 은 terraform validate까지만. 화면엔 Mock 배지. apply 하지 않는다
export const AZURE_IS_MOCK = true;

export function resourceTypes(spec: AppSpec): string[] {
  const t = ["azurerm_key_vault", "azurerm_user_assigned_identity", "azurerm_federated_identity_credential"];
  if (spec.database) t.push("azurerm_postgresql_flexible_server", "azurerm_postgresql_flexible_server_database");
  return t.sort();
}

export const azureMockAdapter: EnvironmentAdapter = {
  provider: "azure_mock",
  version: "azure-mock@0.3.0",
  capabilities: () => ["workload.container", "arch.amd64", "ingress.cloudflared",
    "secrets.external", "db.postgres.15", "db.postgres.16", "db.postgres.17", "mock"],
  ...sourceImport("azure_mock"),
  // Mock이라 실행 권한이 없다 → 빈 목록 (apply 대상 아님)
  requiredOperateActions: () => [],
  imageRef: (src: string, t: Target) => platformImageRef(t.registryHost ?? envRef("acrHost"), t, src),
  toTerraform(spec, t: Target) {
    const seed = [nameSeed(t), spec.app.name];
    return {
      moduleRef: moduleRefOf("azure/app", t),
      vars: {
        location: regionOf(t),
        app_name: spec.app.name,
        tenant_id: tenantOf(t),
        k8s_namespace: appNamespace(spec),
        aks_oidc_issuer_url: envRef("aksOidcIssuerUrl"),
        resource_group: envRef("resourceGroup"),
        delegated_subnet_id: envRef("delegatedSubnetId"),
        private_dns_zone_id: envRef("privateDnsZoneId"),
        azure_tenant_id: envRef("azureTenantId"),
        // Key Vault 이름은 전 세계 유일 3~24자
        name_key_vault: boundedName({ prefix: "kv", app: spec.app.name, seed, max: 24 }),
        name_db_server: dbInstanceName(spec, t, 63),
        db_enabled: Boolean(spec.database),
        db_version: spec.database?.majorVersion ?? "16",
        db_storage_mb: Math.max(32768, (spec.database?.storageGb ?? 32) * 1024),
      },
    };
  },
  toHelmValues(spec, out: TfOutputs, t: Target) {
    return buildValues(spec, {
      tenant: tenantOf(t),
      imageRef: azureMockAdapter.imageRef(spec.service.image, t),
      saAnnotations: { "azure.workload.identity/client-id": fromOut(out, "app_identity_client_id") },
      secretStore: { kind: "ClusterSecretStore", name: "azure-key-vault" },
      database: spec.database ? {
        mode: "external", host: fromOut(out, "db_fqdn"), port: 5432, name: spec.app.name,
        passwordSecret: "db-password",
      } : null,
    });
  },
};
