import type { AppSpec, TargetEnv, TfOutputs } from "@svc/contracts";
import { hash6 } from "../common/names.js";
import { regionOf, type Target } from "../common/target.js";
import type {
  InfraRunner, RunnerApplyResult, RunnerDestroyResult, RunnerPlan, RunnerResource, RunnerStatus, ResourceState,
} from "../common/runner.js";
import { azureMockAdapter, resourceTypes } from "./index.js";

// Azure Mock 실행기. 클라우드 호출 0번. 결과는 "진짜 Terraform이 돌았다면 나왔을 모양"을 흉내 낸다.
// - 같은 입력이면 같은 이름·ID·출력 (결정적) → 데모를 여러 번 돌려도 화면이 같다
// - 일부러 기다린다 (latencyMs) → 화면에서 "만드는 중"이 보인다
// 아키텍처 전제(CLAUDE.md §0-1): Azure는 모양 + Mock. 진짜 실행기는 만들지 않는다

// 모양만 맞춘 가짜 구독 번호 (packages/adapters/scripts/write-tfvars.ts와 같은 값)
export const MOCK_SUBSCRIPTION = "00000000-0000-0000-0000-000000000000";

// DRAFT(ai): 호출 한 번당 기다리는 시간 기본 300ms. apply는 3번(자원 만들기·DB·출력) → 약 0.9초.
//            smoke(STUB_DELAY_MS 200ms 단계)보다 조금 길게 해서 화면에서 보이게
export const DEFAULT_LATENCY_MS = 300;

export interface AzureMockOptions {
  latencyMs?: number;
  now?: () => Date;
  // 데모용 장애 주입: "apply" 면 apply가 ok:false로 끝난다 (롤백 화면 연습용)
  failOn?: "apply" | "destroy" | null;
}

const wait = (ms: number) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

// 해시로 만든 UUID 모양 문자열 (클라이언트 ID 같은 칸에 넣는 가짜 값)
export function fakeUuid(...parts: string[]): string {
  const h = [0, 1, 2, 3, 4, 5].map((i) => hash6(...parts, String(i))).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export const resourceGroupOf = (envId: string) => `rg-platform-${hash6(envId)}`;
const armId = (rg: string, provider: string, name: string) =>
  `/subscriptions/${MOCK_SUBSCRIPTION}/resourceGroups/${rg}/providers/${provider}/${name}`;

// Terraform 자원 종류 → (Azure 자원 공급자 경로, 이름)
function describe(type: string, vars: Record<string, unknown>): { arm: string; name: string } {
  const app = String(vars.app_name);
  switch (type) {
    case "azurerm_key_vault": return { arm: "Microsoft.KeyVault/vaults", name: String(vars.name_key_vault) };
    case "azurerm_user_assigned_identity": return { arm: "Microsoft.ManagedIdentity/userAssignedIdentities", name: `id-${app}` };
    case "azurerm_federated_identity_credential":
      return { arm: `Microsoft.ManagedIdentity/userAssignedIdentities/id-${app}/federatedIdentityCredentials`, name: `fic-${app}` };
    case "azurerm_postgresql_flexible_server": return { arm: "Microsoft.DBforPostgreSQL/flexibleServers", name: String(vars.name_db_server) };
    case "azurerm_postgresql_flexible_server_database":
      return { arm: `Microsoft.DBforPostgreSQL/flexibleServers/${String(vars.name_db_server)}/databases`, name: app };
    default: return { arm: "Microsoft.Resources/unknown", name: type };
  }
}

function appResources(spec: AppSpec, t: Target, state: ResourceState): RunnerResource[] {
  const { vars } = azureMockAdapter.toTerraform(spec, t);
  const rg = resourceGroupOf(t.envId);
  return resourceTypes(spec).map((type) => {
    const d = describe(type, vars);
    return { type, name: d.name, id: armId(rg, d.arm, d.name), state };
  });
}

// 환경(연결된 도착지) 자체에 있는 기반 자원. env 모듈이 만들었다고 치는 것들
function baseResources(envId: string): RunnerResource[] {
  const rg = resourceGroupOf(envId);
  const h = hash6(envId);
  return [
    { type: "azurerm_resource_group", name: rg, id: `/subscriptions/${MOCK_SUBSCRIPTION}/resourceGroups/${rg}`, state: "Succeeded" },
    { type: "azurerm_virtual_network", name: `vnet-platform-${h}`, id: armId(rg, "Microsoft.Network/virtualNetworks", `vnet-platform-${h}`), state: "Succeeded" },
    { type: "azurerm_kubernetes_cluster", name: `aks-platform-${h}`, id: armId(rg, "Microsoft.ContainerService/managedClusters", `aks-platform-${h}`), state: "Succeeded" },
    { type: "azurerm_container_registry", name: `acrplatform${h}`, id: armId(rg, "Microsoft.ContainerRegistry/registries", `acrplatform${h}`), state: "Succeeded" },
  ];
}

// infra/modules/azure/app 의 output 3개와 같은 키
export function mockOutputs(spec: AppSpec, t: TargetEnv): TfOutputs {
  const { vars } = azureMockAdapter.toTerraform(spec, t);
  return {
    app_identity_client_id: fakeUuid("identity", t.envId, String(vars.app_name)),
    db_fqdn: vars.db_enabled ? `${String(vars.name_db_server)}.postgres.database.azure.com` : "",
    key_vault_uri: `https://${String(vars.name_key_vault)}.vault.azure.net/`,
  };
}

export function createAzureMockRunner(o: AzureMockOptions = {}): InfraRunner {
  const latency = o.latencyMs ?? DEFAULT_LATENCY_MS;
  const now = o.now ?? (() => new Date());
  const timed = async <T>(steps: number, f: () => T): Promise<T & { elapsedMs: number }> => {
    const t0 = Date.now();
    for (let i = 0; i < steps; i++) await wait(latency);
    const r = f();
    return { ...r, elapsedMs: Date.now() - t0 };
  };

  return {
    provider: "azure_mock",
    mock: true,

    plan: (spec, te) => timed(1, (): Omit<RunnerPlan, "elapsedMs"> => {
      const t = te as Target;
      const tf = azureMockAdapter.toTerraform(spec, t);
      const resources = appResources(spec, t, "Creating");
      return { provider: "azure_mock", mock: true, region: regionOf(t), moduleRef: tf.moduleRef, vars: tf.vars,
               summary: { add: resources.length, change: 0, destroy: 0 }, resources };
    }),

    apply: (spec, te) => timed(3, (): Omit<RunnerApplyResult, "elapsedMs"> => {
      const t = te as Target;
      if (o.failOn === "apply") {
        const resources = appResources(spec, t, "Failed");
        return { provider: "azure_mock", mock: true, ok: false, tfOutputs: {}, resources,
                 log: ["[MOCK] Error: creating Flexible Server: Code=\"ServerQuotaExceeded\" (주입한 장애)"] };
      }
      const resources = appResources(spec, t, "Succeeded");
      return {
        provider: "azure_mock", mock: true, ok: true, tfOutputs: mockOutputs(spec, t), resources,
        log: [
          ...resources.map((r) => `[MOCK] ${r.type}.${r.name}: Creation complete`),
          `[MOCK] Apply complete! Resources: ${resources.length} added, 0 changed, 0 destroyed. (${regionOf(t)})`,
        ],
      };
    }),

    destroy: (spec, te) => timed(2, (): Omit<RunnerDestroyResult, "elapsedMs"> => {
      const t = te as Target;
      const n = appResources(spec, t, "Deleted").length;
      if (o.failOn === "destroy")
        return { provider: "azure_mock", mock: true, ok: false, destroyed: 0, log: ["[MOCK] Error: deleting Key Vault (주입한 장애)"] };
      return { provider: "azure_mock", mock: true, ok: true, destroyed: n,
               log: [`[MOCK] Destroy complete! Resources: ${n} destroyed.`] };
    }),

    status: (te) => timed(1, (): Omit<RunnerStatus, "elapsedMs"> => {
      const t = te as Target;
      return { provider: "azure_mock", mock: true, envId: t.envId, region: regionOf(t), health: "healthy",
               checkedAt: now().toISOString(), resources: baseResources(t.envId) };
    }).then(({ elapsedMs: _e, ...s }) => s),
  };
}
