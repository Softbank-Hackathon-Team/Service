import type { Provider, TargetBuilder } from "@svc/contracts";
import { awsTarget } from "./aws.js";
import { gcpTarget } from "./gcp.js";
import { onpremTarget } from "./onprem.js";
import { azureMockTarget } from "./azure-mock.js";

// 도착 Builder v2 표 (설계 27번 A1). v1 adapterFor 와 따로 둔다 (PLAN_IR=v2 깃발 뒤에서만 쓰임, A3)
const TARGETS: Record<Provider, TargetBuilder> = { aws: awsTarget, gcp: gcpTarget, onprem: onpremTarget, azure_mock: azureMockTarget };
export const targetBuilderFor = (p: Provider) => TARGETS[p];
export { awsTarget, gcpTarget, onpremTarget, azureMockTarget };
export { mockPlanV2 as azureMockPlanV2, mockOutputsV2 as azureMockOutputsV2, resourceTypesV2 as azureResourceTypesV2, type AzureMockPlanV2 } from "./azure-mock.js";
export { rdsClassFor } from "./aws.js";
export { cloudSqlTierFor } from "./gcp.js";
export { requirementsV2, v2Blockers, V2_FIELD_COVERAGE, K8S_RENDER_CAPS, UNSUPPORTED_V2, LINK_OUTPUT_UNKNOWN, identitiesOf, type FieldRule, type IdentityPlan } from "./shared.js";
