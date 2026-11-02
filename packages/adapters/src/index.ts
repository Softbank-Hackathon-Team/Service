import type { EnvironmentAdapter, Provider } from "@svc/contracts";
import { awsAdapter } from "./aws/index.js";
import { gcpAdapter } from "./gcp/index.js";
import { onpremAdapter } from "./onprem/index.js";
import { azureMockAdapter } from "./azure-mock/index.js";

const REGISTRY: Record<Provider, EnvironmentAdapter> = {
  aws: awsAdapter, gcp: gcpAdapter, onprem: onpremAdapter, azure_mock: azureMockAdapter,
};
export const adapterFor = (p: Provider) => REGISTRY[p];

export * as aws from "./aws/index.js";
export * as gcp from "./gcp/index.js";
export * as onprem from "./onprem/index.js";
export * as azure from "./azure-mock/index.js";
export * as azureRunner from "./azure-mock/runner.js";
export { runnerFor, chooseRunner, azureMockEnabled, RunnerUnavailable, STUB_TF_OUTPUTS, stubStatus, type RunnerChoice } from "./runners.js";
export { AdapterError, isAdapterError, type AdapterErrorCode } from "./common/errors.js";
export type * from "./common/runner.js";
export { unexpectedPlanTypes, type Purpose } from "./common/actions.js";
export { DEMO_INVENTORY, DEMO_INVENTORY_V2, DEMO_SPEC } from "./common/fixtures.js";
export type { Target, TargetExtras } from "./common/target.js";
export { realTerraformEnabled, iacMockEnabled, findWorkDir, readImported, type ImportedInfra, TENANT_DIR_RE, createRealTerraformRunner, fillTfVars, factsFromEnv, factEnvName, parseOutputs, childEnv,
  workRootOf, workDirOf, PLAN_ONLY_ID, planOnlyId, spawnExec, REAL_MODULE_DIR, DEFAULT_MODULE_ROOT, type Exec, type ExecResult, type RealApplyResult, type RealTerraformRunner } from "./terraform/real-runner.js";
export { dbNetworkFromEnv, withDbNetwork, cidrProblem, DbNetworkError, type DbNetworkSummary } from "./terraform/db-network.js";
// Z86: 환경 실자원 읽기(읽기 전용 CLI) + 클라우드 서비스 대응표
export { readInventory, cachedInventory, clearInventoryCache, inventoryToStatus, itemState, type CloudInventory, type InventoryGroup, type InventoryItem, type InventoryDeps } from "./inventory.js";
export { serviceMap, categoryOfType, SERVICE_NAME, SOURCE_WORKLOAD, METHOD_LABEL, type ServiceMapRow, type ServiceCategory, type MoveMethod, type PlanStepId } from "./common/service-map.js";
// Z88: 출발 환경 진짜 읽기 (가져오기). MOCK_SEED=1 이면 어댑터 discover 는 데모 원본
export { discoverSource, inventoryForAudit, discoverAws, discoverGcp, discoverOnprem, discoverForImport, type DiscoverOpts } from "./discover/index.js";
export { readK8sApp, readK8sNamespace, type K8sRead, type K8sNamespaceRead, type K8sNamespaceOpts } from "./discover/k8s.js";
// I2: k8s 원본 타입 + 종류 문자열
export * from "./import/raw-k8s.js";
export { mockSeed, CliError, type CliDeps } from "./common/cli.js";
export { runCloudPrecheck, toPrecheckItems, mockPrecheckEnabled, mockChecks, cliProblem, tcpProbe, apiEndpoint, AWS_QUOTAS, GCP_APIS, CLOUDSQL_PG_MAJORS_DEFAULT, MIN_REPL_PG_MAJOR,
  type CloudCheck, type Verdict, type PrecheckEnvInfo, type PrecheckInput, type PrecheckDeps, type CloudProvider } from "./precheck/cloud-precheck.js";
// L4: 연결 확인 (빌린 관찰 역할로 고객 AWS 읽어 보기)
export { verifyAwsObserve, envFor, trustHasExternalId, type VerifyAwsInput, type VerifyAwsResult } from "./verify/aws.js";
