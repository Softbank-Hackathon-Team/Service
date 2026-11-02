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

// TA11: v2 Builder 가 만들 자원 종류 (화면 "생길 자원"이 v2 계획서면 이걸 씀). azure_mock 은 v2 렌더 없음 → 빈 목록
import type { AppSpecV2 } from "@svc/contracts";
import { resourceTypesV2 as awsTypesV2 } from "./aws.js";
import { resourceTypesV2 as gcpTypesV2 } from "./gcp.js";
import { resourceTypesV2 as onpremTypesV2 } from "./onprem.js";
import { resourceTypesV2 as azureTypesV2 } from "./azure-mock.js";
const TYPES_V2: Record<Provider, (s: AppSpecV2) => string[]> = { aws: awsTypesV2, gcp: gcpTypesV2, onprem: onpremTypesV2, azure_mock: azureTypesV2 };
export const resourceTypesV2For = (p: Provider, spec: AppSpecV2) => TYPES_V2[p](spec);
