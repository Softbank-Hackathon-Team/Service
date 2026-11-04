import type { EnvironmentAdapter } from "@svc/contracts";
import { sourceImport, platformImageRef, type PermNeeds } from "../common/base.js";
import { envRef, type Target } from "../common/target.js";

// Azure: 실계정 없음(아키텍처 전제: 모양 + Mock). 번역 함수는 진짜 코드,
// infra/modules/azure/app 은 terraform validate까지만. 화면엔 Mock 배지. apply 하지 않는다
export const AZURE_IS_MOCK = true;

export function resourceTypes(need: PermNeeds): string[] {
  const t = ["azurerm_key_vault", "azurerm_user_assigned_identity", "azurerm_federated_identity_credential"];
  if (need.database) t.push("azurerm_postgresql_flexible_server", "azurerm_postgresql_flexible_server_database");
  return t.sort();
}

export const azureMockAdapter: EnvironmentAdapter = {
  provider: "azure_mock",
  version: "azure-mock@0.3.0",
  capabilities: () => ["workload.container", "arch.amd64", "ingress.cloudflared",
    "secrets.external", "db.postgres.15", "db.postgres.16", "db.postgres.17", "mock"],
  ...sourceImport("azure_mock"),
  imageRef: (src: string, t: Target) => platformImageRef(t.registryHost ?? envRef("acrHost"), t, src),
};
