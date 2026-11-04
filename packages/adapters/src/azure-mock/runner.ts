import { regionOf, type Target } from "../common/target.js";
import type {
  InfraRunner, RunnerApplyResult, RunnerDestroyResult, RunnerPlan, RunnerResource, RunnerStatus,
} from "../common/runner.js";
import { hash6 } from "../common/names.js";
import { MOCK_SUBSCRIPTION, resourceGroupOf } from "./ids.js";
import { mockOutputsV2, mockPlanV2 } from "../target/azure-mock.js";

export { MOCK_SUBSCRIPTION, fakeUuid, resourceGroupOf } from "./ids.js";

// Azure Mock 실행기. 클라우드 호출 0번. 결과는 "진짜 Terraform이 돌았다면 나왔을 모양"을 흉내 낸다.
// - 같은 입력이면 같은 이름·ID·출력 (결정적) → 데모를 여러 번 돌려도 화면이 같다
// - 일부러 기다린다 (latencyMs) → 화면에서 "만드는 중"이 보인다
// 아키텍처 전제(CLAUDE.md §0-1): Azure는 모양 + Mock. 진짜 실행기는 만들지 않는다

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

const armId = (rg: string, provider: string, name: string) =>
  `/subscriptions/${MOCK_SUBSCRIPTION}/resourceGroups/${rg}/providers/${provider}/${name}`;

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
      const p = mockPlanV2(spec, te as Target);
      return { provider: "azure_mock", mock: true, region: p.region, moduleRef: p.root, vars: p.vars, summary: p.summary, resources: p.resources };
    }),

    apply: (spec, te) => timed(3, (): Omit<RunnerApplyResult, "elapsedMs"> => {
      const t = te as Target;
      if (o.failOn === "apply") {
        const resources = mockPlanV2(spec, t, "Failed").resources;
        return { provider: "azure_mock", mock: true, ok: false, tfOutputs: {}, resources,
                 log: ["[MOCK] Error: creating Flexible Server: Code=\"ServerQuotaExceeded\" (주입한 장애)"] };
      }
      const resources = mockPlanV2(spec, t, "Succeeded").resources;
      return {
        provider: "azure_mock", mock: true, ok: true, tfOutputs: mockOutputsV2(spec, t), resources,
        log: [
          ...resources.map((r) => `[MOCK] ${r.type}.${r.name}: Creation complete`),
          `[MOCK] Apply complete! Resources: ${resources.length} added, 0 changed, 0 destroyed. (${regionOf(t)})`,
        ],
      };
    }),

    destroy: (spec, te) => timed(2, (): Omit<RunnerDestroyResult, "elapsedMs"> => {
      const t = te as Target;
      const n = mockPlanV2(spec, t, "Deleted").resources.length;
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
